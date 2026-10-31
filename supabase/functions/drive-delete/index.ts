// =====================================================================
// 🗑 Remove a lead file: POST { id: <lead_files.id> }
//   delete_lead_file() decides (the caller's own client): the person who
//   added it, or an admin. Then the file goes to Google Drive's Trash
//   (Google empties it after 30 days). An older script without "trash"
//   leaves it in Drive; the app is told so.
// =====================================================================
import { admin, asUser, cors, json, trashFile } from '../_shared/drive.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const { id } = (await req.json().catch(() => ({}))) as { id?: string };
    if (!id) return json({ error: 'No file.' }, 400);

    // Allowed? Removed from the app (and the timeline line) in one step
    const { error } = await asUser(req).rpc('delete_lead_file', { p_file_id: id });
    if (error) return json({ error: error.message }, 403);

    const { data: f } = await admin.from('lead_files').select('drive_file_id').eq('id', id).maybeSingle();
    if (!f) return json({ ok: true, drive: 'missing' });

    try {
      return json({ ok: true, drive: (await trashFile(f.drive_file_id)) ? 'trashed' : 'old_script' });
    } catch (e) {
      // Already gone from Drive, or Drive can't be reached: the app part is done
      return json({ ok: true, drive: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
