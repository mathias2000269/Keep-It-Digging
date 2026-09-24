alter table public.orders
alter column user_id drop not null;

create or replace function public.place_order(
  p_customer_name text,
  p_phone text,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_total numeric(12,2);
  v_requested integer;
  v_valid integer;
begin
  if trim(p_customer_name) = '' then raise exception 'Falta el nombre'; end if;
  if p_phone !~ '^[0-9]{5,15}$' then raise exception 'Teléfono no válido'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El carrito está vacío';
  end if;

  select count(*) into v_requested
  from jsonb_to_recordset(p_items) as x(product_id bigint, quantity integer);

  select count(*), coalesce(sum(p.price * x.quantity), 0)
  into v_valid, v_total
  from jsonb_to_recordset(p_items) as x(product_id bigint, quantity integer)
  join public.products p on p.id = x.product_id and p.active
  where x.quantity > 0;

  if v_valid <> v_requested then raise exception 'Hay productos o cantidades no válidos'; end if;

  insert into public.orders (user_id, customer_name, phone, notes, total)
  values ((select auth.uid()), trim(p_customer_name), p_phone, coalesce(p_notes, ''), v_total)
  returning id into v_order_id;

  insert into public.order_items (order_id, product_id, product_name, unit_price, quantity)
  select v_order_id, p.id, p.name, p.price, x.quantity
  from jsonb_to_recordset(p_items) as x(product_id bigint, quantity integer)
  join public.products p on p.id = x.product_id and p.active;

  return v_order_id;
end;
$$;

revoke all on function public.place_order(text,text,text,jsonb) from public;
grant execute on function public.place_order(text,text,text,jsonb) to anon, authenticated;
