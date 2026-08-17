// Mismo App ID y forma de payload que supabase/functions/send-push/index.ts
// (targeting por alias external_id = auth_user_id que OneSignal.login()
// registra en mobile/src/hooks/useAuth.tsx). Acá se le pega directo a la
// API de OneSignal en vez de invocar esa Edge Function porque send-push
// exige un JWT de admin (is_admin() vía auth.uid()) y este bot corre con
// SUPABASE_SERVICE_ROLE_KEY, sin sesión de usuario — mismo patrón que el
// resto de los bots (llamar APIs externas directo con un secret propio).
const ONESIGNAL_APP_ID = "65bbb85e-2969-496f-9e02-cf26b9b7b56b";

export async function sendPush(externalUserId, title, message) {
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!restApiKey) throw new Error("Falta la variable de entorno ONESIGNAL_REST_API_KEY");

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      Authorization: `Key ${restApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      contents: { en: message },
      headings: { en: title },
      include_aliases: { external_id: [externalUserId] },
      target_channel: "push",
    }),
  });

  const result = await res.json();
  if (!res.ok) {
    throw new Error(`OneSignal rechazó el envío a ${externalUserId}: ${JSON.stringify(result)}`);
  }
  return result;
}
