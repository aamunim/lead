// =====================================================================
// 📦 All files of a lead in one ZIP: GET ?lead_id=<leads.id>
//   Only the files the caller may see (row security on lead_files, their
//   own client), in folders Papers / Voice notes / Others. Named like the
//   Drive folder: "ADM-2026-0012 Rahim Uddin.zip".
// =====================================================================
import { zipSync, type Zippable } from 'npm:fflate@0.8.2';

import { admin, asUser, cors, currentUser, downloadFile, json, leadFolderName } from '../_shared/drive.ts';

const MAX_BYTES = 60 * 1024 * 1024; // the server's memory: the files plus the ZIP
const MAX_FILES = 60;
const AT_ONCE = 3;

const FOLDER: Record<string, string> = { paper: 'Papers', voice: 'Voice notes', other: 'Others' };

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'file';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);

    const leadId = new URL(req.url).searchParams.get('lead_id') ?? '';
    const me = asUser(req);
    const { data: lead } = await me.from('leads').select('id, name, phone, student_ref').eq('id', leadId).maybeSingle();
    if (!lead) return json({ error: 'Lead not found.' }, 404);

    const { data: files, error } = await me
      .from('lead_files')
      .select('id, kind, name, size_bytes, drive_file_id')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    if (!files || files.length === 0) return json({ error: 'No files to download.' }, 404);
    if (files.length > MAX_FILES) {
      return json({ error: `Too many files (${files.length}) for one ZIP. The most is ${MAX_FILES}; open them one by one.` }, 413);
    }
    const total = files.reduce((n, f) => n + Number(f.size_bytes ?? 0), 0);
    if (total > MAX_BYTES) {
      return json({ error: `The files are ${Math.round(total / 1048576)} MB together; one ZIP can hold 60 MB. Open them one by one.` }, 413);
    }

    // Unique names inside each folder: "SSC.pdf", "SSC (2).pdf"
    const used = new Set<string>();
    const pathOf = (f: { kind: string; name: string }) => {
      const folder = FOLDER[f.kind] ?? 'Others';
      const name = safe(f.name);
      const dot = name.lastIndexOf('.');
      const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let path = `${folder}/${name}`;
      for (let i = 2; used.has(path.toLowerCase()); i++) path = `${folder}/${base} (${i})${ext}`;
      used.add(path.toLowerCase());
      return path;
    };
    const paths = files.map(pathOf);

    // Download a few at a time (photos and PDFs are already packed: store, don't squeeze)
    const zip: Zippable = {};
    for (let i = 0; i < files.length; i += AT_ONCE) {
      const part = files.slice(i, i + AT_ONCE);
      const got = await Promise.all(part.map((f) => downloadFile(f.drive_file_id)));
      got.forEach((g, j) => (zip[paths[i + j]] = [g.bytes, { level: 0 }]));
    }
    const bytes = zipSync(zip);

    await admin.from('lead_activity').insert({
      lead_id: lead.id,
      user_id: user.id,
      action: 'files_downloaded',
      details: { count: files.length },
    });

    const name = `${leadFolderName(lead)}.zip`;
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
      headers: {
        ...cors,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
