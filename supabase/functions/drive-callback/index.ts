// =====================================================================
// 🔗 Google sends the admin back here after "Allow"
//   Swaps the code for a refresh token, keeps it (server only), makes the
//   "Lead Management" folder, then sends the admin back to the app.
//   Deploy with --no-verify-jwt (Google calls it, not the app).
// =====================================================================
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI,
  admin,
  rootFolder,
} from '../_shared/drive.ts';

const APP_LINK = 'leadmanagement://drive-connected';

function page(title: string, text: string, ok: boolean): Response {
  const link = `${APP_LINK}?ok=${ok ? 1 : 0}&message=${encodeURIComponent(text)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:32px 20px;background:#f5f7fb;color:#111;text-align:center}
.c{max-width:420px;margin:auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px #0001}
h1{font-size:22px}a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:10px;background:#3156d3;color:#fff;text-decoration:none;font-weight:600}</style>
</head><body><div class="c"><h1>${title}</h1><p>${text}</p><a href="${link}">Back to the app</a></div>
<script>setTimeout(function(){location.href=${JSON.stringify(link)}},800)</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) return page('Not connected', 'Google access was not allowed.', false);
  if (!code || !state) return page('Not connected', 'Something was missing. Please try again from the app.', false);

  try {
    const { data: st } = await admin.from('drive_oauth_states').select('user_id, created_at').eq('state', state).maybeSingle();
    await admin.from('drive_oauth_states').delete().eq('state', state);
    if (!st || Date.parse(st.created_at) < Date.now() - 3600_000) {
      return page('Not connected', 'This link is old. Please start again from the app.', false);
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await res.json();
    if (!res.ok || !tok.refresh_token) {
      return page('Not connected', `Google did not give access (${tok.error_description ?? tok.error ?? 'no refresh token'}).`, false);
    }

    // Whose account (shown in Settings)
    let email: string | null = null;
    try {
      const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      email = (await info.json()).email ?? null;
    } catch {
      email = null;
    }

    // A different account: start with fresh folders
    const { data: before } = await admin.from('google_drive_connection').select('email').eq('id', 1).maybeSingle();
    if (before && before.email !== email) await admin.from('lead_drive_folders').delete().neq('lead_id', '00000000-0000-0000-0000-000000000000');

    await admin.from('google_drive_connection').upsert({
      id: 1,
      email,
      refresh_token: tok.refresh_token,
      root_folder_id: before && before.email === email ? undefined : null,
      connected_by: st.user_id,
      connected_at: new Date().toISOString(),
    });
    await rootFolder();

    return page('✓ Google Drive connected', `Files will be saved in "Lead Management" in ${email ?? 'this Google account'}.`, true);
  } catch (e) {
    return page('Not connected', e instanceof Error ? e.message : String(e), false);
  }
});
