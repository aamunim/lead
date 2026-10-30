// =====================================================================
// 📎 Google Drive helpers for the drive-* Edge Functions
//   One Google account (connected by an admin) holds every file. Its
//   refresh token lives in google_drive_connection, which only the server
//   (service role) can read.
//   Needs the secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
//   (npx supabase secrets set …).
// =====================================================================
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
export const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
export const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
export const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/drive-callback`;
/** drive.file: the app sees only the files it made itself */
export const SCOPES = 'https://www.googleapis.com/auth/drive.file email';
export const ROOT_FOLDER = 'Lead Management';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/** Server client: can read the Google token and add files */
export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** The caller's own client: row security decides what they may see */
export function asUser(req: Request): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

/** The signed-in person, or null */
export async function currentUser(req: Request): Promise<{ id: string } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user ? { id: data.user.id } : null;
}

// ---------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------
let cached: { token: string; until: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const { data: conn } = await admin.from('google_drive_connection').select('refresh_token').eq('id', 1).maybeSingle();
  if (!conn) throw new Error('Google Drive is not connected. An admin can connect it in Settings → Google Drive.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      body.error === 'invalid_grant'
        ? 'The Google Drive connection has expired. An admin needs to connect it again in Settings → Google Drive.'
        : `Google: ${body.error_description ?? body.error ?? res.status}`,
    );
  }
  cached = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function google(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  return fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

/** A folder inside another (made if it isn't there) */
export async function makeFolder(name: string, parent: string | null): Promise<string> {
  const res = await google('/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parent ? { parents: [parent] } : {}),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google Drive: ${body.error?.message ?? res.status}`);
  return body.id as string;
}

/** "Lead Management" folder (made once, remembered) */
export async function rootFolder(): Promise<string> {
  const { data: conn } = await admin.from('google_drive_connection').select('root_folder_id').eq('id', 1).maybeSingle();
  if (conn?.root_folder_id) return conn.root_folder_id;
  const id = await makeFolder(ROOT_FOLDER, null);
  await admin.from('google_drive_connection').update({ root_folder_id: id }).eq('id', 1);
  return id;
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** The lead's folder, and inside it "Papers" / "Voice notes" */
export async function leadFolder(lead: { id: string; name: string; phone: string | null }, kind: 'paper' | 'voice' | 'other') {
  const get = async (k: string) =>
    (await admin.from('lead_drive_folders').select('folder_id').eq('lead_id', lead.id).eq('kind', k).maybeSingle()).data
      ?.folder_id as string | undefined;

  let main = await get('lead');
  if (!main) {
    main = await makeFolder(safe(`${lead.name}${lead.phone ? ` – ${lead.phone}` : ''}`), await rootFolder());
    await admin.from('lead_drive_folders').upsert({ lead_id: lead.id, kind: 'lead', folder_id: main });
  }
  if (kind === 'other') return main;

  let sub = await get(kind);
  if (!sub) {
    sub = await makeFolder(kind === 'paper' ? 'Papers' : 'Voice notes', main);
    await admin.from('lead_drive_folders').upsert({ lead_id: lead.id, kind, folder_id: sub });
  }
  return sub;
}

/** Upload one file (multipart: metadata + content) */
export async function uploadFile(name: string, mime: string, bytes: Uint8Array, parent: string): Promise<string> {
  const boundary = `lead${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name, parents: [parent] });
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await google('/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Google Drive: ${out.error?.message ?? res.status}`);
  return out.id as string;
}

/** The file's content (streamed straight to the app) */
export function downloadFile(fileId: string): Promise<Response> {
  return google(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
}
