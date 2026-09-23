import "jsr:@supabase/functions-js@2.4.4/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeUsername(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 24);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    const body = await request.json();
    const fullName = String(body.fullName || "").trim();
    const username = normalizeUsername(String(body.username || fullName));
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");

    if (fullName.length < 2 || fullName.length > 80) return json({ error: "Escribe un nombre válido." }, 400);
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) return json({ error: "El usuario debe tener entre 3 y 24 caracteres." }, 400);
    if (!/^[0-9]{5,15}$/.test(phone)) return json({ error: "El teléfono solo puede contener entre 5 y 15 números." }, 400);
    if (password.length < 6 || password.length > 72) return json({ error: "La contraseña debe tener entre 6 y 72 caracteres." }, 400);

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "El registro no está configurado." }, 500);

    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: existing } = await admin
      .from("profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existing) return json({ error: "Ese nombre de usuario ya está ocupado." }, 409);

    const hiddenEmail = `${username}@users.keepitdigging.invalid`;
    const { error } = await admin.auth.admin.createUser({
      email: hiddenEmail,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: fullName, phone },
    });

    if (error) {
      const duplicate = /already|registered|database error/i.test(error.message);
      return json({ error: duplicate ? "Ese nombre de usuario ya está ocupado." : "No se pudo crear la cuenta." }, duplicate ? 409 : 400);
    }

    return json({ username }, 201);
  } catch {
    return json({ error: "No se pudo procesar el registro." }, 400);
  }
});
