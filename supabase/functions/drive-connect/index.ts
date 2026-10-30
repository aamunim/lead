// =====================================================================
// 🔗 Start connecting the institute's Google Drive (admins only)
//   POST → { url }: the app opens it, the admin signs in to Google and
//   allows access, Google sends them to drive-callback.
// =====================================================================
import { GOOGLE_CLIENT_ID, REDIRECT_URI, SCOPES, admin, asUser, cors, currentUser, json } from '../_shared/drive.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    const { data: isAdmin } = await asUser(req).rpc('has_permission', { perm: 'settings.manage' });
    if (!isAdmin) return json({ error: 'Only an admin can connect Google Drive.' }, 403);
    if (!GOOGLE_CLIENT_ID) return json({ error: 'GOOGLE_CLIENT_ID is not set on the server.' }, 500);

    const state = crypto.randomUUID();
    await admin.from('drive_oauth_states').delete().lt('created_at', new Date(Date.now() - 3600_000).toISOString());
    await admin.from('drive_oauth_states').insert({ state, user_id: user.id });

    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent', // always get a refresh token
        state,
      });
    return json({ url });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
