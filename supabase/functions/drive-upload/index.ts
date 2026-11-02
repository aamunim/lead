// =====================================================================
// ⬆️ Upload a file for a lead to Google Drive
//   POST multipart/form-data: file, lead_id, kind ('paper' | 'voice' |
//   'other'), paper_id?, call_id?, name?, duration_sec?, context? (where a
//   voice note was recorded: call, note, fee, …)
//   The caller must be able to see the lead (row security). The file goes
//   to Lead Management / <Student ID Name, or Name – Phone> / Papers |
//   Voice notes. A paper's file also ticks that paper in the checklist
//   (as a photocopy) if it isn't ticked yet.
// =====================================================================
import { admin, asUser, cors, currentUser, json, leadFolder, uploadFile } from '../_shared/drive.ts';
import { compressPdf } from '../_shared/ilovepdf.ts';

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

const MAX_BYTES = 35 * 1024 * 1024; // the script takes ~50 MB of base64

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);

    const { data: on } = await admin.rpc('files_setting');
    if (on && on.enabled === false) return json({ error: 'Files are turned off in Settings.' }, 403);

    const form = await req.formData();
    const file = form.get('file');
    const leadId = String(form.get('lead_id') ?? '');
    const kind = String(form.get('kind') ?? 'paper') as 'paper' | 'voice' | 'other';
    if (!(file instanceof File)) return json({ error: 'No file.' }, 400);
    if (!['paper', 'voice', 'other'].includes(kind)) return json({ error: 'Unknown kind.' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'The file is bigger than 35 MB.' }, 400);

    // Can this person see the lead? (their own client: row security)
    const { data: lead } = await asUser(req).from('leads').select('id, name, phone, student_ref').eq('id', leadId).maybeSingle();
    if (!lead) return json({ error: 'Lead not found.' }, 404);

    const paperId = (form.get('paper_id') as string | null) || null;
    const callId = (form.get('call_id') as string | null) || null;
    const duration = Number(form.get('duration_sec') ?? '') || null;
    const context = String(form.get('context') ?? '').slice(0, 40) || null;
    const name = String(form.get('name') || file.name || 'file').slice(0, 120);
    const mime = file.type || 'application/octet-stream';
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    const originalSize = bytes.length;
    let compressed: { from: number; to: number; account: string } | null = null;

    // 📎 Upload rules (Settings → Upload rules): what the paper takes, the PDF's weight
    const isPdf = mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
    const isImage = mime.startsWith('image/');
    const { data: defaults } = await admin.rpc('upload_rules_setting');
    let pdfMaxKb = Number((defaults as { pdf_max_kb?: number } | null)?.pdf_max_kb ?? 0) || null;
    if (paperId) {
      const { data: rule } = await admin
        .from('admission_papers')
        .select('name, accept, pdf_max_kb')
        .eq('id', paperId)
        .maybeSingle();
      if (rule?.accept === 'image' && !isImage) return json({ error: `${rule.name}: only a picture can be uploaded.` }, 400);
      if (rule?.accept === 'pdf' && !isPdf) return json({ error: `${rule.name}: only a PDF can be uploaded.` }, 400);
      if (rule?.pdf_max_kb) pdfMaxKb = rule.pdf_max_kb;
    }

    // 📄 A PDF over its limit: smaller with iLovePDF, else made smaller by hand
    if (isPdf && pdfMaxKb && bytes.length > pdfMaxKb * 1024) {
      const limit = pdfMaxKb * 1024;
      const r = await compressPdf(bytes, name, limit);
      if (r.ok && r.bytes.length <= limit) {
        compressed = { from: bytes.length, to: r.bytes.length, account: r.account };
        bytes = r.bytes;
      } else {
        const why = !r.ok
          ? r.reason === 'no_account'
            ? 'No PDF compressor account is set (Settings → Upload rules).'
            : 'The PDF compressor did not work right now.'
          : `Even compressed it is ${kb(r.bytes.length)}.`;
        return json(
          {
            error: `This PDF is ${kb(originalSize)}; the limit is ${kb(limit)}. ${why} Please make it smaller by hand (e.g. ilovepdf.com/compress_pdf) and upload it again.`,
            code: 'pdf_too_big',
          },
          413,
        );
      }
    }

    const folder = await leadFolder(lead, kind);
    const driveId = await uploadFile(name, mime, bytes, folder);

    const { data: row, error } = await admin
      .from('lead_files')
      .insert({
        lead_id: lead.id,
        kind,
        paper_id: paperId,
        call_id: callId,
        name,
        mime_type: mime,
        size_bytes: bytes.length,
        duration_sec: duration,
        context,
        drive_file_id: driveId,
        uploaded_by: user.id,
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    await admin.from('lead_activity').insert({
      lead_id: lead.id,
      user_id: user.id,
      action: 'file_added',
      details: {
        name,
        kind,
        file_id: row.id,
        paper_id: paperId,
        duration_sec: duration,
        context,
        // 📉 made smaller on the way (here, or in the browser: original_size)
        original_size: Number(form.get('original_size') ?? '') || (compressed ? compressed.from : null),
        size: bytes.length,
      },
    });

    // Tick the paper in the checklist (as the uploader; a failed tick doesn't fail the upload)
    let paperTicked = false;
    if (kind === 'paper' && paperId) {
      const me = asUser(req);
      const { data: had } = await me
        .from('lead_papers')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('paper_id', paperId)
        .maybeSingle();
      if (!had) {
        const { error: tickError } = await me.rpc('set_lead_paper', {
          p_lead_id: lead.id,
          p_paper_id: paperId,
          p_status: 'received',
          p_copy_type: 'photocopy',
        });
        paperTicked = !tickError;
      }
    }

    return json({ ...row, paper_ticked: paperTicked, compressed });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
