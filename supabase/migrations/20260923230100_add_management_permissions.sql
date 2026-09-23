create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('worker', 'boss', 'admin')
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role in ('boss', 'admin')
  );
$$;

drop function if exists public.review_application(uuid, public.application_status);

create function public.review_application(
  p_application_id uuid,
  p_decision public.application_status,
  p_role public.user_role default 'worker'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_user_id uuid;
begin
  if not private.is_admin() then raise exception 'Acceso denegado'; end if;
  if p_decision = 'approved' and p_role not in ('worker', 'boss') then
    raise exception 'Rol de equipo no válido';
  end if;

  update public.job_applications
  set status = p_decision,
      reviewed_at = case when p_decision = 'pending' then null else now() end
  where id = p_application_id
  returning user_id into v_user_id;

  if v_user_id is null then raise exception 'Solicitud no encontrada'; end if;

  if p_decision = 'approved' then
    update public.profiles set role = p_role
    where id = v_user_id and role = 'customer';
  elsif p_decision = 'rejected' then
    update public.profiles set role = 'customer'
    where id = v_user_id and role not in ('boss', 'admin');
  end if;
end;
$$;

revoke all on function public.review_application(uuid,public.application_status,public.user_role) from public, anon;
grant execute on function public.review_application(uuid,public.application_status,public.user_role) to authenticated;
