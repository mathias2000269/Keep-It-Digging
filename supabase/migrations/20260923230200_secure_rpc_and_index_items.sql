revoke execute on function public.place_order(text,text,text,jsonb) from public, anon;
revoke execute on function public.review_application(uuid,public.application_status,public.user_role) from public, anon;
grant execute on function public.place_order(text,text,text,jsonb) to authenticated;
grant execute on function public.review_application(uuid,public.application_status,public.user_role) to authenticated;

create index if not exists order_items_product_idx on public.order_items (product_id);
