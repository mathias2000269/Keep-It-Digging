-- Cierre contable mensual de K.I.D.
--
-- Los movimientos detallados permanecen en revenue_ledger y expense_ledger
-- durante el mes. Después de enviar el PDF, sus importes pasan a
-- financial_carryover y los movimientos ya archivados se eliminan.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.financial_carryover (
  id smallint primary key default 1 check (id = 1),
  gross_income numeric(14,2) not null default 0 check (gross_income >= 0),
  total_expenses numeric(14,2) not null default 0 check (total_expenses >= 0),
  updated_at timestamptz not null default now()
);

insert into public.financial_carryover (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.monthly_financial_archives (
  id uuid primary key default gen_random_uuid(),
  period_start timestamptz not null,
  period_end timestamptz not null unique,
  gross_income numeric(14,2) not null default 0 check (gross_income >= 0),
  total_expenses numeric(14,2) not null default 0 check (total_expenses >= 0),
  net_income numeric(14,2) not null default 0,
  order_count integer not null default 0 check (order_count >= 0),
  expense_count integer not null default 0 check (expense_count >= 0),
  status text not null default 'preparing'
    check (status in ('preparing', 'completed', 'failed')),
  email_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (period_start < period_end)
);

create index if not exists monthly_financial_archives_completed_idx
on public.monthly_financial_archives (completed_at desc)
where status = 'completed';

alter table public.financial_carryover enable row level security;
alter table public.monthly_financial_archives enable row level security;

drop policy if exists "financial_carryover_management_read" on public.financial_carryover;
create policy "financial_carryover_management_read"
on public.financial_carryover
for select to authenticated
using ((select private.is_admin()));

drop policy if exists "monthly_financial_archives_management_read" on public.monthly_financial_archives;
create policy "monthly_financial_archives_management_read"
on public.monthly_financial_archives
for select to authenticated
using ((select private.is_admin()));

grant select on public.financial_carryover to authenticated;
grant select on public.monthly_financial_archives to authenticated;

-- Guardamos en el historial todos los datos necesarios para que el PDF pueda
-- mostrar cada pedido aunque su tarjeta operativa se haya eliminado.
alter table public.revenue_ledger
  add column if not exists phone varchar(10),
  add column if not exists notes text not null default '',
  add column if not exists items jsonb not null default '[]'::jsonb;

alter table public.orders
  add column if not exists revenue_archived_at timestamptz;

alter table public.expenses
  add column if not exists accounting_archived_at timestamptz;

update public.revenue_ledger as ledger
set phone = order_row.phone,
    notes = order_row.notes,
    items = coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', item.product_name,
          'quantity', item.quantity,
          'unit_price', item.unit_price
        )
        order by item.id
      )
      from public.order_items as item
      where item.order_id = order_row.id
    ), '[]'::jsonb)
from public.orders as order_row
where order_row.id = ledger.order_id;

-- Mantiene sincronizado el ingreso vivo. Si se reabre un pedido que ya había
-- entrado en un cierre mensual, descuenta el importe del saldo acumulado.
create or replace function private.record_completed_order_revenue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status = 'completed' then
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'name', item.product_name,
          'quantity', item.quantity,
          'unit_price', item.unit_price
        ) order by item.id
      ), '[]'::jsonb)
      into v_items
      from public.order_items as item
      where item.order_id = new.id;

      insert into public.revenue_ledger (
        order_id, customer_name, phone, notes, items, amount, completed_at
      ) values (
        new.id, new.customer_name, new.phone, new.notes, v_items, new.total, now()
      )
      on conflict (order_id) do nothing;
    end if;

  elsif tg_op = 'UPDATE'
        and new.status = 'completed'
        and old.status is distinct from 'completed' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'name', item.product_name,
        'quantity', item.quantity,
        'unit_price', item.unit_price
      ) order by item.id
    ), '[]'::jsonb)
    into v_items
    from public.order_items as item
    where item.order_id = new.id;

    insert into public.revenue_ledger (
      order_id, customer_name, phone, notes, items, amount, completed_at
    ) values (
      new.id, new.customer_name, new.phone, new.notes, v_items, new.total, now()
    )
    on conflict (order_id) do nothing;

    update public.orders
    set revenue_archived_at = null
    where id = new.id
      and revenue_archived_at is not null;

  elsif tg_op = 'UPDATE'
        and old.status = 'completed'
        and new.status is distinct from 'completed' then
    delete from public.revenue_ledger
    where order_id = new.id;

    get diagnostics v_deleted_count = row_count;

    if v_deleted_count = 0 and old.revenue_archived_at is not null then
      update public.financial_carryover
      set gross_income = greatest(0, gross_income - old.total),
          updated_at = now()
      where id = 1;

      update public.orders
      set revenue_archived_at = null
      where id = new.id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.record_completed_order_revenue()
from public, anon, authenticated;

drop trigger if exists record_completed_order_revenue on public.orders;
create trigger record_completed_order_revenue
after insert or update of status on public.orders
for each row execute function private.record_completed_order_revenue();

-- Conserva la regla existente de cancelación. Si el movimiento ya se archivó,
-- el importe se descuenta del saldo histórico en vez de buscarlo en el ledger.
create or replace function public.cancel_expense(p_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount numeric(12,2);
  v_archived_at timestamptz;
  v_ledger_count integer := 0;
begin
  if not private.is_admin() then
    raise exception 'Acceso denegado';
  end if;

  select amount, accounting_archived_at
  into v_amount, v_archived_at
  from public.expenses
  where id = p_expense_id
    and cancelled_at is null
  for update;

  if not found then
    raise exception 'Ticket no encontrado o ya cancelado';
  end if;

  update public.expenses
  set cancelled_at = now(),
      cancelled_by = (select auth.uid()),
      accounting_archived_at = null
  where id = p_expense_id;

  update public.expense_ledger
  set cancelled_at = now()
  where expense_id = p_expense_id
    and cancelled_at is null;

  get diagnostics v_ledger_count = row_count;

  if v_ledger_count = 0 and v_archived_at is not null then
    update public.financial_carryover
    set total_expenses = greatest(0, total_expenses - v_amount),
        updated_at = now()
    where id = 1;
  end if;
end;
$$;

revoke all on function public.cancel_expense(uuid) from public, anon;
grant execute on function public.cancel_expense(uuid) to authenticated;

-- Esta función se llama únicamente después de que Resend confirme el envío.
-- El bloqueo de las dos filas evita que dos ejecuciones sumen el mes dos veces.
create or replace function public.finalize_monthly_financial_archive(
  p_archive_id uuid,
  p_period_end timestamptz,
  p_email_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_gross numeric(14,2);
  v_expenses numeric(14,2);
  v_order_count integer;
  v_expense_count integer;
begin
  select status
  into v_status
  from public.monthly_financial_archives
  where id = p_archive_id
    and period_end = p_period_end
  for update;

  if not found then
    raise exception 'Cierre mensual no encontrado';
  end if;

  if v_status = 'completed' then
    return jsonb_build_object('already_completed', true);
  end if;

  perform 1
  from public.financial_carryover
  where id = 1
  for update;

  select coalesce(sum(amount), 0), count(*)
  into v_gross, v_order_count
  from public.revenue_ledger
  where completed_at < p_period_end;

  select coalesce(sum(amount) filter (where cancelled_at is null), 0), count(*)
  into v_expenses, v_expense_count
  from public.expense_ledger
  where spent_at < p_period_end;

  update public.orders as order_row
  set revenue_archived_at = now()
  from public.revenue_ledger as ledger
  where ledger.order_id = order_row.id
    and ledger.completed_at < p_period_end;

  update public.expenses as expense
  set accounting_archived_at = now()
  from public.expense_ledger as ledger
  where ledger.expense_id = expense.id
    and ledger.spent_at < p_period_end
    and ledger.cancelled_at is null;

  update public.financial_carryover
  set gross_income = gross_income + v_gross,
      total_expenses = total_expenses + v_expenses,
      updated_at = now()
  where id = 1;

  delete from public.revenue_ledger
  where completed_at < p_period_end;

  delete from public.expense_ledger
  where spent_at < p_period_end;

  update public.monthly_financial_archives
  set gross_income = v_gross,
      total_expenses = v_expenses,
      net_income = v_gross - v_expenses,
      order_count = v_order_count,
      expense_count = v_expense_count,
      status = 'completed',
      email_id = p_email_id,
      completed_at = now()
  where id = p_archive_id;

  return jsonb_build_object(
    'already_completed', false,
    'gross_income', v_gross,
    'total_expenses', v_expenses,
    'net_income', v_gross - v_expenses,
    'order_count', v_order_count,
    'expense_count', v_expense_count
  );
end;
$$;

revoke all on function public.finalize_monthly_financial_archive(uuid, timestamptz, text)
from public, anon, authenticated;
grant execute on function public.finalize_monthly_financial_archive(uuid, timestamptz, text)
to service_role;

-- pg_cron trabaja en UTC. Probamos a los minutos 1, 16, 31 y 46 durante los
-- posibles días de cambio de mes; la función comprueba Europe/Madrid y solo
-- actúa durante la hora 00 del día 1. Se incluyen los días 28-31 porque las
-- 00:01 de Madrid todavía pertenecen al día anterior en UTC.
-- La primera llamada sale a las 00:01 y las otras tres permiten reintentar un
-- fallo temporal sin duplicar el correo ni sumar dos veces el mismo cierre.
select cron.unschedule(jobid)
from cron.job
where jobname = 'kid-monthly-financial-report';

select cron.schedule(
  'kid-monthly-financial-report',
  '1,16,31,46 * 1,28-31 * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'kid_project_url'
      ) || '/functions/v1/monthly-financial-report',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-report-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'kid_monthly_report_secret'
        )
      ),
      body := '{"scheduled":true}'::jsonb
    );
  $cron$
);
