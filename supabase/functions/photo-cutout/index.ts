// =====================================================================
// 🪪 Cut the person out of a photo (remove.bg) for a passport photo
//   POST multipart/form-data: file (a JPEG/PNG, made smaller in the
//   browser first). Returns a PNG with a see-through background.
//   The remove.bg accounts (Settings → Upload rules) are tried in order;
//   one out of credits (402), with a wrong key (401/403) or busy (429) is
//   noted and the next one is used. "preview" size: the free allowance.
// =====================================================================
import { admin, cors, currentUser, json } from '../_shared/drive.ts';

type Account = { id: string; label: string; api_key: string; files_month: number; month: string | null };

const MAX_BYTES = 12 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'No picture.' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'The picture is too big.' }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { data } = await admin
      .from('removebg_accounts')
      .select('id, label, api_key, files_month, month')
      .eq('is_active', true)
      .order('sort_order')
      .order('created_at');
    const accounts = (data ?? []) as Account[];
    if (accounts.length === 0) {
      return json({ error: 'No remove.bg account is set (Settings → Upload rules).', code: 'no_account' }, 409);
    }

    const month = new Date().toISOString().slice(0, 7);
    let lastError = '';
    for (const a of accounts) {
      const body = new FormData();
      body.append('image_file', new Blob([bytes as unknown as ArrayBuffer], { type: file.type || 'image/jpeg' }), 'photo');
      body.append('size', 'preview');
      body.append('type', 'person');
      body.append('format', 'png');
      let r: Response;
      try {
        r = await fetch('https://api.remove.bg/v1.0/removebg', {
          method: 'POST',
          headers: { 'X-Api-Key': a.api_key },
          body,
        });
      } catch (e) {
        lastError = `network: ${e instanceof Error ? e.message : String(e)}`;
        break; // remove.bg can't be reached: the next account won't do better
      }
      if (r.ok) {
        const png = new Uint8Array(await r.arrayBuffer());
        await admin
          .from('removebg_accounts')
          .update({
            files_month: (a.month === month ? a.files_month : 0) + 1,
            month,
            last_used_at: new Date().toISOString(),
            last_error: null,
          })
          .eq('id', a.id);
        return new Response(new Blob([png as unknown as ArrayBuffer]), {
          headers: { ...cors, 'Content-Type': 'image/png', 'X-Account': encodeURIComponent(a.label) },
        });
      }
      const text = (await r.text()).slice(0, 300);
      let title = text;
      try {
        title = (JSON.parse(text) as { errors?: { title?: string }[] }).errors?.[0]?.title ?? text;
      } catch {
        // not JSON
      }
      lastError = `${r.status}: ${title}`;
      await admin
        .from('removebg_accounts')
        .update({ last_error: lastError, last_error_at: new Date().toISOString() })
        .eq('id', a.id);
      // 402 no credits · 401/403 wrong key · 429 busy → the next account; a bad picture → stop
      if (![401, 402, 403, 429].includes(r.status)) {
        return json({ error: `remove.bg: ${title}`, code: 'bad_picture' }, 422);
      }
    }
    return json({ error: `remove.bg did not work right now (${lastError}).`, code: 'all_failed' }, 502);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
