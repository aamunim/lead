// =====================================================================
// 🔐 Sign in with a mobile number and a one-time code (OTP)
//   POST { action: 'send', phone, app_hash? }  → { ok, hint } | { error, wait? }
//   POST { action: 'verify', phone, code }     → { access_token, refresh_token } | { error }
//   Open to anyone (it is the sign-in page): the limits, the code and the
//   number checks are in the database (otp_login_start / _check). The
//   database sends the SMS (pg_net, from the non-masking sender, like all
//   other SMS); this waits a few seconds for the company's answer so a
//   failure is shown at once. The API key and the code never come here.
//   A right code gives a normal Supabase session for that user's account
//   (a sign-in link is made on the server and used at once; no email).
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { admin, cors, json, SUPABASE_URL } from '../_shared/drive.ts';

const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

type Start = { id?: string; hint?: string; error?: string; wait?: number };
type Check = { user_id?: string; email?: string; error?: string };
type Status = { done?: boolean; problem?: string | null };

/**
 * The caller's internet address (for the per-network limit). The gateway adds
 * the real address at the END of x-forwarded-for; the start can be written by
 * the caller, so it is not trusted.
 */
function callerIp(req: Request): string | null {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const parts = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(phone: string, appHash: string, ip: string | null): Promise<Response> {
  const { data, error } = await admin.rpc('otp_login_start', { p_phone: phone, p_ip: ip, p_app_hash: appHash || null });
  if (error) throw new Error(error.message);
  const s = (data ?? {}) as Start;
  if (s.error || !s.id) return json({ error: s.error ?? 'Could not make a code.', wait: s.wait }, 400);

  // the database sends the SMS (pg_net); wait a few seconds for the company's answer
  for (let i = 0; i < 12; i++) {
    await sleep(i === 0 ? 400 : 700);
    const { data: st, error: e2 } = await admin.rpc('otp_login_status', { p_id: s.id });
    if (e2) break;
    const status = (st ?? {}) as Status;
    if (!status.done) continue;
    if (status.problem) {
      console.error('otp sms failed:', status.problem.slice(0, 200));
      return json({ error: 'The SMS could not be sent. Sign in with email, or try again later.' }, 502);
    }
    break;
  }
  // sent (or no answer yet: it usually still arrives)
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
