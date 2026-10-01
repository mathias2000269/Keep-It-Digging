-- Si un pedido sale del estado completed, su importe deja de ser un ingreso.
-- Borrar físicamente un pedido completado no pasa por este trigger, así que
-- el ingreso histórico se conserva tal como requiere la contabilidad.

create or replace function private.record_completed_order_revenue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'completed' then
    insert into public.revenue_ledger (
      order_id,
      customer_name,
      amount,
      completed_at
    )
    values (
      new.id,
      new.customer_name,
      new.total,
      now()
    )
    on conflict (order_id) do nothing;
  elsif tg_op = 'UPDATE'
        and new.status = 'completed'
        and old.status is distinct from 'completed' then
    insert into public.revenue_ledger (
      order_id,
      customer_name,
      amount,
      completed_at
    )
    values (
      new.id,
      new.customer_name,
      new.total,
      now()
    )
    on conflict (order_id) do nothing;
  elsif tg_op = 'UPDATE'
        and old.status = 'completed'
        and new.status is distinct from 'completed' then
    delete from public.revenue_ledger
    where order_id = new.id;
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

-- Corrige entradas antiguas creadas al marcar por error un pedido completado.
-- Solo elimina el ingreso si el pedido aún existe y actualmente no está completado.
delete from public.revenue_ledger as ledger
using public.orders as order_row
where ledger.order_id = order_row.id
  and order_row.status is distinct from 'completed';
