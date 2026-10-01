-- EJECUTA ESTE ARCHIVO UNA SOLA VEZ DESPUÉS DE LA MIGRACIÓN MENSUAL.
-- Antes de ejecutarlo, sustituye CAMBIA_ESTE_SECRETO por una contraseña larga
-- y aleatoria. Esa misma contraseña se guarda también como
-- MONTHLY_REPORT_SECRET en los secretos de la Edge Function.

select vault.create_secret(
  'https://czvstsqwxxbqvenprmda.supabase.co',
  'kid_project_url',
  'URL del proyecto para el cierre financiero mensual'
);

select vault.create_secret(
  'CAMBIA_ESTE_SECRETO',
  'kid_monthly_report_secret',
  'Autorización privada para el cierre financiero mensual'
);

-- PRUEBA MANUAL (úsala después de desplegar y configurar la Edge Function).
-- Quita los dos guiones -- de las líneas siguientes para ejecutarla. Al usar
-- force=true podrás generar ahora el primer PDF sin esperar al próximo día 1.

-- select net.http_post(
--   url := (select decrypted_secret from vault.decrypted_secrets where name = 'kid_project_url') || '/functions/v1/monthly-financial-report',
--   headers := jsonb_build_object(
--     'Content-Type', 'application/json',
--     'x-report-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kid_monthly_report_secret')
--   ),
--   body := '{"force":true}'::jsonb
-- );
