-- Permite borrar tickets de gastos de forma definitiva.
-- Cancelar un ticket solo lo marca como cancelado; eliminarlo borra la fila.

drop function if exists public.hide_expense(uuid);

alter table public.expenses
drop column if exists hidden_at,
drop column if exists hidden_by;

create or replace function public.delete_expense(p_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Acceso denegado';
  end if;

  delete from public.expenses
  where id = p_expense_id;

  if not found then
    raise exception 'Ticket no encontrado';
  end if;
end;
$$;

revoke all on function public.delete_expense(uuid) from public, anon;
grant execute on function public.delete_expense(uuid) to authenticated;
