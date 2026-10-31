// =====================================================================
// 📎 Google Drive helpers for the drive-* Edge Functions
//   The files go to the Google Drive of ONE account, through a small
//   Google Apps Script web app the admin deploys there
//   (docs/drive-script.gs). Its address and secret key are kept in
//   google_drive_connection, which only the server (service role) reads.
//   No Google Cloud project, OAuth client or card is needed.
// =====================================================================
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
export const ROOT_FOLDER = 'Lead Management';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/** Server client: reads the script's address and adds files */
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
// The Apps Script web app
// ---------------------------------------------------------------------
type Script = { url: string; secret: string };

/** Call the script (it answers with JSON; Google redirects once, fetch follows) */
export async function callScript<T>(script: Script, action: string, payload: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(script.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: script.secret, action, ...payload }),
      redirect: 'follow',
    });
  } catch {
    throw new Error('Could not reach the Google Drive script.');
  }
  const text = await res.text();
  let body: { error?: string } & Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      'The Google Drive script did not answer properly. Check that it is deployed as a Web app with access "Anyone".',
    );
  }
  if (body.error) {
    throw new Error(body.error === 'Not allowed' ? 'The secret key does not match the script.' : `Google Drive: ${body.error}`);
  }
  return body as T;
}

async function connected(): Promise<Script> {
  const { data } = await admin
    .from('google_drive_connection')
    .select('script_url, script_secret')
    .eq('id', 1)
    .maybeSingle();
  if (!data?.script_url || !data?.script_secret) {
    throw new Error('Google Drive is not connected. An admin can connect it in Settings → Google Drive.');
  }
  return { url: data.script_url, secret: data.script_secret };
}

export async function makeFolder(name: string, parent: string | null): Promise<string> {
  const r = await callScript<{ id: string }>(await connected(), 'folder', { name, parent });
  return r.id;
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

/** Folder name: "ADM-2026-0012 Rahim Uddin" for a student, else "Rahim Uddin – 01711…" */
export function leadFolderName(lead: { name: string; phone: string | null; student_ref: string | null }): string {
  if (lead.student_ref) return safe(`${lead.student_ref} ${lead.name}`);
  return safe(`${lead.name}${lead.phone ? ` – ${lead.phone}` : ''}`);
}

/** The lead's folder, and inside it "Papers" / "Voice notes" (a folder made earlier keeps its name) */
export async function leadFolder(
  lead: { id: string; name: string; phone: string | null; student_ref: string | null },
  kind: 'paper' | 'voice' | 'other',
) {
  const get = async (k: string) =>
    (await admin.from('lead_drive_folders').select('folder_id').eq('lead_id', lead.id).eq('kind', k).maybeSingle()).data
      ?.folder_id as string | undefined;

  let main = await get('lead');
  if (!main) {
    main = await makeFolder(leadFolderName(lead), await rootFolder());
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

export async function uploadFile(name: string, mime: string, bytes: Uint8Array, parent: string): Promise<string> {
  const r = await callScript<{ id: string }>(await connected(), 'upload', {
    name,
    mime,
    parent,
    data: encodeBase64(bytes),
  });
  return r.id;
}

/** Move a file to Drive's Trash. false = the script is an older copy without "trash" */
export async function trashFile(fileId: string): Promise<boolean> {
  try {
    await callScript(await connected(), 'trash', { id: fileId });
    return true;
  } catch (e) {
    if (e instanceof Error && /Unknown action/.test(e.message)) return false;
    throw e;
  }
}

/** The file's content */
export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const r = await callScript<{ data: string; mime: string }>(await connected(), 'download', { id: fileId });
  return { bytes: decodeBase64(r.data), mime: r.mime };
}
