drop policy if exists "inquiries_public_insert" on public.inquiries;

do $$
begin
  if exists (select 1 from public.profiles where phone !~ '^[0-9]{10}$') then
    raise exception 'Hay teléfonos inválidos en public.profiles. Deben ser exactamente 10 números.';
  end if;

  if exists (select 1 from public.orders where phone !~ '^[0-9]{10}$') then
    raise exception 'Hay teléfonos inválidos en public.orders. Deben ser exactamente 10 números.';
  end if;

  if exists (select 1 from public.inquiries where phone !~ '^[0-9]{10}$') then
    raise exception 'Hay teléfonos inválidos en public.inquiries. Deben ser exactamente 10 números.';
  end if;
end $$;

alter table public.profiles drop constraint if exists profiles_phone_check;
alter table public.orders drop constraint if exists orders_phone_check;
alter table public.inquiries drop constraint if exists inquiries_phone_check;

alter table public.profiles alter column phone type varchar(10);
alter table public.orders alter column phone type varchar(10);
alter table public.inquiries alter column phone type varchar(10);

alter table public.profiles
add constraint profiles_phone_check check (phone ~ '^[0-9]{10}$');

alter table public.orders
add constraint orders_phone_check check (phone ~ '^[0-9]{10}$');

alter table public.inquiries
add constraint inquiries_phone_check check (phone ~ '^[0-9]{10}$');

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
  if p_phone !~ '^[0-9]{10}$' then raise exception 'Teléfono no válido'; end if;
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

create policy "inquiries_public_insert" on public.inquiries
for insert to anon, authenticated
with check (
  status = 'new'
  and phone ~ '^[0-9]{10}$'
  and char_length(trim(name)) between 2 and 80
  and char_length(trim(message)) between 5 and 2000
);

revoke all on function public.place_order(text,text,text,jsonb) from public;
grant execute on function public.place_order(text,text,text,jsonb) to anon, authenticated;
