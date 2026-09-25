-- Permite al equipo eliminar una reclamación sin eliminar su pedido.

create or replace function public.delete_order_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  if not private.is_staff() then
    raise exception 'Acceso denegado';
  end if;

  delete from public.order_claims
  where id = p_claim_id
  returning order_id into v_order_id;

  if not found then
    raise exception 'Reclamación no encontrada';
  end if;

  -- Si ambas partes ya habían quitado el pedido o vencieron los siete días,
  -- retirar la reclamación permite aplicar la limpieza pendiente.
  perform private.delete_order_if_eligible(v_order_id);
end;
$$;

revoke all on function public.delete_order_claim(uuid)
from public, anon;

grant execute on function public.delete_order_claim(uuid)
to authenticated;
