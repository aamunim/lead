// =====================================================================
// 🔗 Connect the Google Drive script (admins only)
//   POST { url, secret }: checks the script answers with that secret,
//   keeps both on the server, makes the "Lead Management" folder.
// =====================================================================
import { admin, asUser, callScript, cors, currentUser, json, rootFolder } from '../_shared/drive.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    const { data: isAdmin } = await asUser(req).rpc('has_permission', { perm: 'settings.manage' });
    if (!isAdmin) return json({ error: 'Only an admin can connect Google Drive.' }, 403);

    const { url, secret } = (await req.json().catch(() => ({}))) as { url?: string; secret?: string };
    const scriptUrl = (url ?? '').trim();
    const scriptSecret = (secret ?? '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(scriptUrl)) {
      return json({ error: 'Paste the Web app URL (https://script.google.com/macros/s/…/exec).' }, 400);
    }
    if (scriptSecret.length < 16) return json({ error: 'The secret key must be at least 16 characters.' }, 400);

    const ping = await callScript<{ ok: boolean; email?: string }>({ url: scriptUrl, secret: scriptSecret }, 'ping');

    const { data: before } = await admin.from('google_drive_connection').select('email').eq('id', 1).maybeSingle();
    const sameAccount = !!before && before.email === (ping.email ?? null);
    if (!sameAccount) await admin.from('lead_drive_folders').delete().neq('lead_id', '00000000-0000-0000-0000-000000000000');

    const { error } = await admin.from('google_drive_connection').upsert({
      id: 1,
      email: ping.email ?? null,
      script_url: scriptUrl,
      script_secret: scriptSecret,
      refresh_token: null,
      ...(sameAccount ? {} : { root_folder_id: null }),
      connected_by: user.id,
      connected_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    await rootFolder();

    return json({ ok: true, email: ping.email ?? null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
