// =====================================================================
// 🔐 Sign in with a mobile number and a one-time code (OTP)
//   POST { action: 'send', phone, app_hash? }  → { ok, hint } | { error, wait? }
//   POST { action: 'verify', phone, code }     → { access_token, refresh_token } | { error }
//   Open to anyone (it is the sign-in page): the limits, the code and the
//   number checks are in the database (otp_login_start / _check). The SMS
//   goes straight to the SMS company in use, from its non-masking sender,
//   so the person gets it in seconds and a failure is shown at once.
//   A right code gives a normal Supabase session for that user's account
//   (a sign-in link is made on the server and used at once; no email).
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { admin, cors, json, SUPABASE_URL } from '../_shared/drive.ts';

const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

type Start = { id?: string; url?: string; method?: string; hint?: string; error?: string; wait?: number };
type Check = { user_id?: string; email?: string; error?: string };

/** The caller's internet address (for the per-network limit) */
function callerIp(req: Request): string | null {
  const f = req.headers.get('x-forwarded-for');
  if (f) return f.split(',')[0].trim() || null;
  return req.headers.get('x-real-ip') ?? req.headers.get('cf-connecting-ip');
}

async function send(phone: string, appHash: string, ip: string | null): Promise<Response> {
  const { data, error } = await admin.rpc('otp_login_start', { p_phone: phone, p_ip: ip, p_app_hash: appHash || null });
  if (error) throw new Error(error.message);
  const s = (data ?? {}) as Start;
  if (s.error || !s.id || !s.url) return json({ error: s.error ?? 'Could not make a code.', wait: s.wait }, 400);

  // to the SMS company (it answers in a second or two)
  let status: number | null = null;
  let content: string | null = null;
  let failure: string | null = null;
  try {
    const res = await fetch(s.url, {
      method: s.method === 'POST' ? 'POST' : 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    status = res.status;
    content = (await res.text()).slice(0, 2000);
  } catch (e) {
    failure = e instanceof Error && e.name === 'TimeoutError' ? 'No answer from the SMS company (timed out)' : String(e);
  }

  const { data: problem, error: e2 } = await admin.rpc('otp_login_sent', {
    p_id: s.id,
    p_status: status,
    p_content: content,
    p_error: failure,
  });
  if (e2) throw new Error(e2.message);
  if (problem) {
    console.error('otp sms failed', problem);
    return json({ error: 'The SMS could not be sent. Sign in with email, or try again later.' }, 502);
  }
  return json({ ok: true, hint: s.hint });
}

async function verify(phone: string, code: string): Promise<Response> {
  const { data, error } = await admin.rpc('otp_login_check', { p_phone: phone, p_code: code });
  if (error) throw new Error(error.message);
  const c = (data ?? {}) as Check;
  if (c.error || !c.email) return json({ error: c.error ?? 'Could not check the code.' }, 400);

  // a one-time sign-in link for this account, used here at once (nothing is emailed)
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: c.email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) throw new Error(linkError?.message ?? 'No sign-in link.');

  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signed, error: signError } = await client.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
  if (signError || !signed.session) throw new Error(signError?.message ?? 'No session.');

  return json({ access_token: signed.session.access_token, refresh_token: signed.session.refresh_token });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      phone?: string;
      code?: string;
      app_hash?: string;
    };
    const phone = String(body.phone ?? '').slice(0, 40);
    if (!phone.trim()) return json({ error: 'Write your mobile number.' }, 400);

    if (body.action === 'send') return await send(phone, String(body.app_hash ?? '').slice(0, 11), callerIp(req));
    if (body.action === 'verify') return await verify(phone, String(body.code ?? '').slice(0, 12));
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('otp-login', e);
    return json({ error: 'Something went wrong. Try again, or sign in with email.' }, 500);
  }
});
