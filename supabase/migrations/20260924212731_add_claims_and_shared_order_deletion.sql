-- Reclamaciones y borrado compartido de pedidos.
-- Un pedido solo se elimina físicamente cuando ambas partes lo han quitado
-- de su vista o cuando han pasado 7 días desde la primera solicitud.
-- Una reclamación abierta detiene siempre el borrado.

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

alter table public.orders
  add column if not exists customer_deleted_at timestamptz,
  add column if not exists company_deleted_at timestamptz,
  add column if not exists deletion_requested_at timestamptz;

create table if not exists public.order_claims (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (char_length(trim(message)) between 5 and 2000),
  status public.inquiry_status not null default 'new',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists order_claims_order_idx
  on public.order_claims (order_id);

create index if not exists order_claims_status_created_idx
  on public.order_claims (status, created_at desc);

create unique index if not exists order_claims_one_open_per_order_idx
  on public.order_claims (order_id)
  where status = 'new';

create index if not exists orders_cleanup_idx
  on public.orders (deletion_requested_at)
  where deletion_requested_at is not null;

alter table public.order_claims enable row level security;

create policy "claims_read_own_or_staff" on public.order_claims
for select to authenticated
using (user_id = (select auth.uid()) or private.is_staff());

create policy "claims_insert_own_order" on public.order_claims
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and status = 'new'
  and exists (
    select 1
    from public.orders
    where orders.id = order_claims.order_id
      and orders.user_id = (select auth.uid())
      and orders.customer_deleted_at is null
  )
);

create policy "claims_staff_update" on public.order_claims
for update to authenticated
using (private.is_staff())
with check (private.is_staff());

grant select, insert on public.order_claims to authenticated;
grant update (status) on public.order_claims to authenticated;

-- Los trabajadores pueden leer dudas. Solo jefe/admin conservan los permisos
-- para marcarlas como resueltas o eliminarlas.
drop policy if exists "inquiries_admin_read" on public.inquiries;
create policy "inquiries_staff_read" on public.inquiries
for select to authenticated
using (private.is_staff());

-- La lectura de pedidos respeta qué parte ya lo ha quitado de su vista.
-- Si existe una reclamación abierta, la empresa conserva acceso al pedido
-- desde la sección de reclamaciones aunque ya hubiera solicitado borrarlo.
drop policy if exists "orders_read_own_or_staff" on public.orders;
create policy "orders_read_own_or_staff" on public.orders
for select to authenticated
using (
  (
    user_id = (select auth.uid())
    and customer_deleted_at is null
  )
  or (
    private.is_staff()
    and (
      company_deleted_at is null
      or exists (
        select 1
        from public.order_claims
        where order_claims.order_id = orders.id
          and order_claims.status = 'new'
      )
    )
  )
);

drop policy if exists "items_read_own_or_staff" on public.order_items;
create policy "items_read_own_or_staff" on public.order_items
for select to authenticated
using (
  exists (
    select 1
    from public.orders
    where orders.id = order_items.order_id
      and (
        (
          orders.user_id = (select auth.uid())
          and orders.customer_deleted_at is null
        )
        or (
          private.is_staff()
          and (
            orders.company_deleted_at is null
            or exists (
              select 1
              from public.order_claims
              where order_claims.order_id = orders.id
                and order_claims.status = 'new'
            )
          )
        )
      )
  )
);

-- El borrado directo deja de estar disponible. Las dos funciones públicas de
-- abajo registran quién pidió borrar y deciden si ya se puede eliminar.
drop policy if exists "orders_staff_delete" on public.orders;
revoke update on public.orders from authenticated;
revoke delete on public.orders from authenticated;
grant update (status) on public.orders to authenticated;

create or replace function private.delete_order_if_eligible(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
begin
  delete from public.orders
  where id = p_order_id
    and not exists (
      select 1
      from public.order_claims
      where order_claims.order_id = orders.id
        and order_claims.status = 'new'
    )
    and (
      (customer_deleted_at is not null and company_deleted_at is not null)
      or deletion_requested_at <= now() - interval '7 days'
    );

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

revoke all on function private.delete_order_if_eligible(uuid) from public, anon, authenticated;

create or replace function public.customer_remove_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Debes iniciar sesión';
  end if;

  update public.orders
  set customer_deleted_at = coalesce(customer_deleted_at, now()),
      deletion_requested_at = coalesce(deletion_requested_at, now()),
      status = case
        when status = 'pending' then 'cancelled'::public.order_status
        else status
      end
  where id = p_order_id
    and user_id = (select auth.uid());

  if not found then
    raise exception 'Pedido no encontrado';
  end if;

  perform private.delete_order_if_eligible(p_order_id);
end;
$$;

create or replace function public.staff_remove_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_staff() then
    raise exception 'Acceso denegado';
  end if;

  update public.orders
  set company_deleted_at = coalesce(company_deleted_at, now()),
      deletion_requested_at = coalesce(deletion_requested_at, now())
  where id = p_order_id;

  if not found then
    raise exception 'Pedido no encontrado';
  end if;

  perform private.delete_order_if_eligible(p_order_id);
end;
$$;

revoke all on function public.customer_remove_order(uuid) from public, anon;
revoke all on function public.staff_remove_order(uuid) from public, anon;
grant execute on function public.customer_remove_order(uuid) to authenticated;
grant execute on function public.staff_remove_order(uuid) to authenticated;

create or replace function private.prepare_claim_resolution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.resolved_at = case
    when new.status = 'resolved' then coalesce(new.resolved_at, now())
    else null
  end;
  return new;
end;
$$;

create or replace function private.cleanup_order_after_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'new' and new.status = 'resolved' then
    perform private.delete_order_if_eligible(new.order_id);
  end if;
  return new;
end;
$$;

revoke all on function private.prepare_claim_resolution() from public, anon, authenticated;
revoke all on function private.cleanup_order_after_claim() from public, anon, authenticated;

drop trigger if exists prepare_claim_resolution on public.order_claims;
create trigger prepare_claim_resolution
before update of status on public.order_claims
for each row execute function private.prepare_claim_resolution();

drop trigger if exists cleanup_order_after_claim on public.order_claims;
create trigger cleanup_order_after_claim
after update of status on public.order_claims
for each row execute function private.cleanup_order_after_claim();

create or replace function private.cleanup_deleted_orders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  for v_order_id in
    select id
    from public.orders
    where deletion_requested_at <= now() - interval '7 days'
  loop
    perform private.delete_order_if_eligible(v_order_id);
  end loop;
end;
$$;

revoke all on function private.cleanup_deleted_orders() from public, anon, authenticated;

-- Se ejecuta cada hora. Reutiliza el mismo nombre si se vuelve a aplicar una
-- versión posterior de esta migración.
select cron.unschedule(jobid)
from cron.job
where jobname = 'kid-cleanup-deleted-orders';

select cron.schedule(
  'kid-cleanup-deleted-orders',
  '17 * * * *',
  'select private.cleanup_deleted_orders();'
);
