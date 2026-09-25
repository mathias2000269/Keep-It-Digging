-- Las solicitudes aceptadas dejan de ser datos operativos: se concede el rol
-- y se elimina la solicitud dentro de la misma transacción.

create or replace function public.review_application(
  p_application_id uuid,
  p_decision public.application_status,
  p_role public.user_role default 'worker'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if not private.is_admin() then
    raise exception 'Acceso denegado';
  end if;

  if p_decision = 'approved' and p_role not in ('worker', 'boss') then
    raise exception 'Rol de equipo no válido';
  end if;

  select user_id into v_user_id
  from public.job_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'Solicitud no encontrada';
  end if;

  if p_decision = 'approved' then
    update public.profiles
    set role = p_role
    where id = v_user_id
      and role = 'customer';

    delete from public.job_applications
    where id = p_application_id;
  else
    update public.job_applications
    set status = p_decision,
        reviewed_at = case when p_decision = 'pending' then null else now() end
    where id = p_application_id;
  end if;
end;
$$;

create or replace function public.delete_job_application(p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Acceso denegado';
  end if;

  delete from public.job_applications
  where id = p_application_id;

  if not found then
    raise exception 'Solicitud no encontrada';
  end if;
end;
$$;

revoke all on function public.review_application(uuid, public.application_status, public.user_role)
from public, anon;
revoke all on function public.delete_job_application(uuid)
from public, anon;

grant execute on function public.review_application(uuid, public.application_status, public.user_role)
to authenticated;
grant execute on function public.delete_job_application(uuid)
to authenticated;

-- Limpia solicitudes antiguas que ya no están pendientes y que las versiones
-- anteriores conservaron en la tabla.
delete from public.job_applications
where status in ('approved', 'rejected');
