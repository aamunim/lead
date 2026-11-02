// =====================================================================
// 📄 Make a PDF smaller with iLovePDF (Settings → Upload rules → accounts)
//   The accounts are tried in order; one that fails (no credits left, a
//   wrong key) is noted and the next one is tried. "recommended" first,
//   "extreme" when that is still too big.
//   API: auth → start/compress → upload → process → download
// =====================================================================
import { admin } from './drive.ts';

const API = 'https://api.ilovepdf.com/v1';

type Account = { id: string; label: string; public_key: string; files_month: number; month: string | null };

export type CompressResult =
  | { ok: true; bytes: Uint8Array; account: string; level: string }
  | { ok: false; reason: 'no_account' | 'all_failed'; detail?: string };

async function token(publicKey: string): Promise<string> {
  const r = await fetch(`${API}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKey }),
  });
  if (!r.ok) throw new Error(`auth ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { token: string }).token;
}

async function compressOnce(publicKey: string, bytes: Uint8Array, name: string, level: string): Promise<Uint8Array> {
  const jwt = await token(publicKey);
  const auth = { Authorization: `Bearer ${jwt}` };

  let start = await fetch(`${API}/start/compress`, { headers: auth });
  if (start.status === 404) start = await fetch(`${API}/start/compress/eu`, { headers: auth });
  if (!start.ok) throw new Error(`start ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const { server, task } = (await start.json()) as { server: string; task: string };
  const base = `https://${server}/v1`;

  const form = new FormData();
  form.append('task', task);
  form.append('file', new Blob([bytes as unknown as ArrayBuffer], { type: 'application/pdf' }), name);
  const up = await fetch(`${base}/upload`, { method: 'POST', headers: auth, body: form });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
  const { server_filename } = (await up.json()) as { server_filename: string };

  const proc = await fetch(`${base}/process`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      tool: 'compress',
      compression_level: level,
      files: [{ server_filename, filename: name }],
    }),
  });
  if (!proc.ok) throw new Error(`process ${proc.status}: ${(await proc.text()).slice(0, 200)}`);

  const dl = await fetch(`${base}/download/${task}`, { headers: auth });
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  return new Uint8Array(await dl.arrayBuffer());
}

/** Smaller than maxBytes if it can; the smallest result otherwise (ok: true with bigger bytes) */
export async function compressPdf(bytes: Uint8Array, name: string, maxBytes: number): Promise<CompressResult> {
  const { data } = await admin
    .from('ilovepdf_accounts')
    .select('id, label, public_key, files_month, month')
    .eq('is_active', true)
    .order('sort_order')
    .order('created_at');
  const accounts = (data ?? []) as Account[];
  if (accounts.length === 0) return { ok: false, reason: 'no_account' };

  const month = new Date().toISOString().slice(0, 7);
  let lastError = '';
  for (const a of accounts) {
    try {
      let best: Uint8Array | null = null;
      let used = 0;
      let level = 'recommended';
      for (const l of ['recommended', 'extreme']) {
        level = l;
        const out = await compressOnce(a.public_key, bytes, name, l);
        used += 1;
        if (!best || out.length < best.length) best = out;
        if (out.length <= maxBytes) break;
      }
      await admin
        .from('ilovepdf_accounts')
        .update({
          files_month: (a.month === month ? a.files_month : 0) + used,
          month,
          last_used_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', a.id);
      return { ok: true, bytes: best!, account: a.label, level };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await admin
        .from('ilovepdf_accounts')
        .update({ last_error: lastError.slice(0, 300), last_error_at: new Date().toISOString() })
        .eq('id', a.id);
      // the next account
    }
  }
  return { ok: false, reason: 'all_failed', detail: lastError };
}
