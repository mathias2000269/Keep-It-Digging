-- Crea reclamaciones desde una función controlada. La identidad se obtiene de
-- la sesión de Supabase y nunca se acepta un user_id enviado por el navegador.

create or replace function public.create_order_claim(
  p_order_id uuid,
  p_message text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Debes iniciar sesión para enviar una reclamación';
  end if;

  if char_length(trim(coalesce(p_message, ''))) not between 5 and 2000 then
    raise exception 'La reclamación debe tener entre 5 y 2000 caracteres';
  end if;

  if not exists (
    select 1
    from public.orders
    where id = p_order_id
      and user_id = (select auth.uid())
      and customer_deleted_at is null
  ) then
    raise exception 'El pedido no existe o no pertenece a tu cuenta';
  end if;

  if exists (
    select 1
    from public.order_claims
    where order_id = p_order_id
      and status = 'new'
  ) then
    raise exception 'Este pedido ya tiene una reclamación pendiente' using errcode = '23505';
  end if;

  insert into public.order_claims (
    order_id,
    user_id,
    message
  )
  values (
    p_order_id,
    (select auth.uid()),
    trim(p_message)
  )
  returning id into v_claim_id;

  return v_claim_id;
end;
$$;

revoke all on function public.create_order_claim(uuid, text)
from public, anon;

grant execute on function public.create_order_claim(uuid, text)
to authenticated;
