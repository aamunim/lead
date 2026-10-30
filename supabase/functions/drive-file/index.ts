// =====================================================================
// ⬇️ Open a lead file: GET ?id=<lead_files.id>
//   Row security on lead_files decides (the caller's own client): the
//   person who added it, or admins / people allowed in Settings. The
//   content comes from Google Drive through the script; no Drive link.
// =====================================================================
import { asUser, cors, downloadFile, json } from '../_shared/drive.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    const { data: f } = await asUser(req)
      .from('lead_files')
      .select('drive_file_id, name, mime_type')
      .eq('id', id)
      .maybeSingle();
    if (!f) return json({ error: 'Not found, or you may not open it.' }, 404);

    const file = await downloadFile(f.drive_file_id);
    return new Response(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), {
      headers: {
        ...cors,
        'Content-Type': f.mime_type || file.mime || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
