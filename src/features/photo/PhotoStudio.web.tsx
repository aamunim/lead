import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { detectFaces, warmUp, type Face } from './faceDetect';
import {
  CUSTOM,
  inches,
  listSavedPresets,
  paperPresets,
  pixels,
  saveSavedPresets,
  sizeLabel,
  type Preset,
  type Unit,
} from './presets';
import {
  NEUTRAL,
  PAPERS,
  addRecent,
  autoLight,
  clearRecent,
  download,
  drawLook,
  fillFrame,
  headFromFace,
  headFromOutline,
  listRecent,
  makeFile,
  makeSheet,
  placeHead,
  sheetFile,
  sheetFits,
  zoomAt,
  type HeadBox,
  type Look,
  type Paper,
  type Recent,
} from './studio';
import { sizeText, uploadLeadFile } from '@/features/files/api';
import { cutout, loadPic, turn, type Pic } from '@/features/files/passport';
import { canEditUploadRules, listCutoutAccounts, ruleFor } from '@/features/files/uploadRules';
import { listLeads, type LeadListItem } from '@/features/leads/api';
import { getLeadPapers, type LeadPaper } from '@/features/papers/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🖼 Photo Studio (website; admins and the Admission Officer)
//   Any photo → the size you need: drop / paste / choose a photo; the face
//   is found (MediaPipe, in the browser) and the background removed
//   (remove.bg through our server); the head is placed by the size's rule.
//   Then: drag to move, wheel to zoom, straighten, mirror, light, the
//   background colour; download (JPG/PNG under a KB limit), a print sheet
//   (4R / A4 with cut lines), or save it straight to a student's Photo.
// =====================================================================

const SWATCHES = ['#CFE6FA', '#E3F0FB', '#BFD9F2', '#FFFFFF', '#F1F1F1', '#DCE3EA', '#1E6FD9', '#C62828'];
const AUTO_BG_KEY = 'photo_studio_auto_bg';
const BOX_W = 440;
const BOX_H = 500;

const pref = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const savePref = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    // private window
  }
};

const baseLook = (bg: string): Look => ({
  cx: 0,
  cy: 0,
  scale: 1,
  tilt: 0,
  flip: false,
  ...NEUTRAL,
  bgOn: true,
  bg,
  feather: 1.5,
});

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

export function PhotoStudio() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  // Sizes
  const [papers, setPapers] = useState<Preset[]>([]);
  const [saved, setSaved] = useState<Preset[]>([]);
  const [size, setSize] = useState<Preset>(CUSTOM);
  const [chosen, setChosen] = useState<string>('custom');

  // The photo
  const [fileName, setFileName] = useState('photo');
  const [photo, setPhoto] = useState<Pic | null>(null);
  const [mask, setMask] = useState<Pic | null>(null);
  const [faces, setFaces] = useState<Face[] | null>(null);
  const [faceAt, setFaceAt] = useState(0);
  const [head, setHead] = useState<HeadBox | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [autoBg, setAutoBg] = useState(() => pref(AUTO_BG_KEY, true));
  const [straighten, setStraighten] = useState(true);
  const [guides, setGuides] = useState(true);
  const [before, setBefore] = useState(false);
  const [usage, setUsage] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const say = useCallback((text: string, bad = false) => {
    setMsg({ text, bad });
    setTimeout(() => setMsg(null), 5000);
  }, []);

  const { w: W, h: H } = pixels(size);

  // ── Open ────────────────────────────────────────────────
  useEffect(() => {
    canEditUploadRules()
      .then((ok) => {
        setAllowed(ok);
        if (!ok) return;
        warmUp();
        paperPresets().then(setPapers);
        listSavedPresets().then(setSaved);
        listCutoutAccounts()
          .then((a) => setUsage(a.reduce((n, x) => n + (x.files_month ?? 0), 0)))
          .catch(() => setUsage(null));
      })
      .catch(() => setAllowed(false));
  }, []);

  // ── Place the head (or fill the frame) ─────────────────
  const placed = useCallback(
    (from: Look, p: Pic, h: HeadBox | null, s: Preset) => {
      const { w, h: hh } = pixels(s);
      return h ? placeHead(from, p, h, w, hh, s.face_pct, s.top_pct, straighten) : fillFrame(from, p, w, hh);
    },
    [straighten],
  );

  const findHead = (p: Pic, m: Pic | null, f: Face[] | null, at: number): HeadBox | null => {
    const face = f?.[at];
    if (face) return headFromFace(face, p, m);
    return m ? headFromOutline(p, m) : null;
  };

  /** A photo came: find the face, cut the person out, place it */
  const open = async (blob: Blob, name: string) => {
    setNote(null);
    setStep('Opening the photo…');
    setFileName(
      name
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w\- ]+/g, '')
        .trim() || 'photo',
    );
    try {
      const p = await loadPic(blob, 2400);
      setPhoto(p);
      setMask(null);
      setFaces(null);
      setFaceAt(0);
      await analyse(p, autoBg);
    } catch {
      setNote('This picture could not be opened (JPG, PNG or WEBP).');
      setStep(null);
    }
  };

  const analyse = async (p: Pic, withBg: boolean) => {
    setStep(withBg ? 'Finding the face · removing the background…' : 'Finding the face…');
    const notes: string[] = [];
    const [f, m] = await Promise.all([
      detectFaces(p),
      withBg
        ? cutout(p).catch((e: unknown) => {
            notes.push(e instanceof Error ? e.message : 'The background could not be removed.');
            return null;
          })
        : Promise.resolve(null),
    ]);
    if (f === null)
      notes.push('The face finder could not start in this browser; the head is guessed from the outline.');
    else if (f.length === 0) notes.push('No face was found: place it by hand (drag, wheel to zoom).');
    else if (f.length > 1) notes.push(`${f.length} faces: the biggest is used (“Next face” to change).`);
    const h = findHead(p, m, f, 0);
    if (!h && (f?.length ?? 0) > 0) notes.push('Could not measure the head: place it by hand.');
    setMask(m);
    setFaces(f);
    setHead(h);
    const next = placed({ ...baseLook(size.bg), bgOn: !!m }, p, h, size);
    setLook(next);
    setNote(notes.length ? notes.join(' ') : null);
    setStep(null);
    if (m) setUsage((u) => (u == null ? u : u + 1));
  };

  // ── Drop, paste, choose ────────────────────────────────
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const take = (files: FileList | null | undefined) => {
      const f = Array.from(files ?? []).find((x) => x.type.startsWith('image/'));
      if (f) void open(f, f.name);
      return !!f;
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e as unknown as KeyboardEvent)) return;
      if (take(e.clipboardData?.files)) e.preventDefault();
    };
    const onOver = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      take(e.dataTransfer?.files);
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, autoBg, size]);

  // ── Size changes: place the head again (light and colour stay) ──
  const pickSize = (p: Preset, id: string) => {
    setChosen(id);
    setSize(p);
    if (photo && look) setLook(placed({ ...look, bg: p.bg }, photo, head, p));
  };
  const editSize = (patch: Partial<Preset>) => {
    const next = { ...size, ...patch };
    setSize(next);
    setChosen('custom');
    if (
      photo &&
      look &&
      ('width' in patch ||
        'height' in patch ||
        'unit' in patch ||
        'dpi' in patch ||
        'face_pct' in patch ||
        'top_pct' in patch)
    )
      setLook(placed(look, photo, head, next));
    if ('bg' in patch && look) setLook({ ...look, bg: next.bg });
  };

  // ── The preview ────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const kCss = Math.min(BOX_W / W, BOX_H / H);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !photo || !look) return;
    const id = requestAnimationFrame(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const k = kCss * dpr;
      drawLook(c, W, H, k, photo, mask, look, before);
      if (guides && !before) {
        const ctx = c.getContext('2d')!;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.lineWidth = 1 / kCss;
        ctx.setLineDash([5 / kCss, 4 / kCss]);
        ctx.strokeStyle = 'rgba(230,40,90,0.85)';
        const top = (size.top_pct / 100) * H;
        const chin = top + (size.face_pct / 100) * H;
        for (const y of [top, chin]) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(30,110,220,0.7)';
        ctx.beginPath();
        ctx.moveTo(W / 2, 0);
        ctx.lineTo(W / 2, H);
        ctx.stroke();
        const ry = (chin - top) / 2;
        ctx.beginPath();
        ctx.ellipse(W / 2, top + ry, ry * 0.74, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [photo, mask, look, before, guides, W, H, kCss, size.top_pct, size.face_pct]);

  // Drag to move
  const drag = useRef<{ x: number; y: number; look: Look } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!look) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, look };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    setLook({
      ...d.look,
      cx: d.look.cx + (e.clientX - d.x) / kCss,
      cy: d.look.cy + (e.clientY - d.y) / kCss,
    });
  };
  const onUp = () => {
    drag.current = null;
  };
  // Wheel to zoom (at the mouse)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const ox = (e.clientX - r.left) / kCss;
      const oy = (e.clientY - r.top) / kCss;
      setLook((l) => (l ? zoomAt(l, Math.exp(-e.deltaY * 0.0015), ox, oy) : l));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [kCss, photo]);
  // Keys: arrows move, + − zoom, B before
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || !look) return;
      const n = e.shiftKey ? 10 : 2;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-n, 0],
        ArrowRight: [n, 0],
        ArrowUp: [0, -n],
        ArrowDown: [0, n],
      };
      if (moves[e.key]) {
        e.preventDefault();
        setLook({
          ...look,
          cx: look.cx + moves[e.key][0],
          cy: look.cy + moves[e.key][1],
        });
      } else if (e.key === '+' || e.key === '=') setLook(zoomAt(look, 1.04, W / 2, H / 2));
      else if (e.key === '-') setLook(zoomAt(look, 1 / 1.04, W / 2, H / 2));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [look, W, H]);

  // ── Tools ──────────────────────────────────────────────
  const set = (patch: Partial<Look>) => look && setLook({ ...look, ...patch });
  const reAuto = () => photo && look && setLook(placed(look, photo, head, size));
  const quarter = async (right: boolean) => {
    if (!photo) return;
    const p = turn(photo, right);
    const m = mask ? turn(mask, right) : null;
    setPhoto(p);
    setMask(m);
    setStep('Finding the face…');
    const f = await detectFaces(p);
    const h = findHead(p, m, f, 0);
    setFaces(f);
    setFaceAt(0);
    setHead(h);
    setLook(placed(look ?? baseLook(size.bg), p, h, size));
    setStep(null);
  };
  const nextFace = () => {
    if (!photo || !faces || faces.length < 2 || !look) return;
    const at = (faceAt + 1) % faces.length;
    const h = findHead(photo, mask, faces, at);
    setFaceAt(at);
    setHead(h);
    setLook(placed(look, photo, h, size));
  };
  const removeBgNow = async () => {
    if (!photo) return;
    setStep('Removing the background…');
    try {
      const m = await cutout(photo);
      setMask(m);
      setUsage((u) => (u == null ? u : u + 1));
      const h = findHead(photo, m, faces, faceAt);
      setHead(h);
      if (look) setLook(placed({ ...look, bgOn: true }, photo, h, size));
    } catch (e) {
      say(e instanceof Error ? e.message : 'The background could not be removed.', true);
    } finally {
      setStep(null);
    }
  };

  // ── The result ─────────────────────────────────────────
  const full = (): HTMLCanvasElement | null => {
    if (!photo || !look) return null;
    const c = document.createElement('canvas');
    drawLook(c, W, H, 1, photo, mask, look);
    return c;
  };
  const [outName, setOutName] = useState('');
  const name = (outName.trim() || `${fileName}-${W}x${H}`).replace(/\.(jpe?g|png)$/i, '');
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSize, setLastSize] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  useEffect(() => {
    listRecent().then(setRecent);
  }, []);
  const remember = async (blob: Blob, n: string) => setRecent(await addRecent({ name: n, blob, w: W, h: H }));

  const save = async () => {
    const c = full();
    if (!c) return;
    setBusy('save');
    try {
      const made = await makeFile(c, size.format, size.max_kb, size.dpi);
      const file = `${name}.${size.format}`;
      download(made.blob, file);
      setLastSize(
        `${sizeText(made.blob.size)}${made.quality ? ` · quality ${Math.round(made.quality * 100)}%` : ''}${
          made.underLimit ? '' : ` · ⚠ still over ${size.max_kb} KB`
        }`,
      );
      await remember(made.blob, file);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not make the picture.', true);
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    const c = full();
    if (!c) return;
    try {
      const png = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error())), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      say('📋 Copied: paste it anywhere (Ctrl+V).');
    } catch {
      say('This browser could not copy a picture.', true);
    }
  };

  // ── Print sheet ────────────────────────────────────────
  const [paper, setPaper] = useState<Paper>('4r');
  const physical = inches(size);
  const fits = sheetFits(paper, physical);
  const copyChoices = useMemo(
    () =>
      Array.from(new Set([fits, 8, 6, 4, 2, 1]))
        .filter((n) => n > 0 && n <= fits)
        .sort((a, b) => b - a),
    [fits],
  );
  const [copies, setCopies] = useState<number | null>(null);
  const nCopies = copies && copies <= fits ? copies : fits;
  const sheet = async (print: boolean) => {
    const c = full();
    if (!c || fits === 0) return;
    setBusy(print ? 'print' : 'sheet');
    try {
      const s = makeSheet(c, physical, paper, nCopies);
      const blob = await sheetFile(s);
      if (!print) {
        download(blob, `${name}-${paper}-x${nCopies}.jpg`);
        return;
      }
      const url = URL.createObjectURL(blob);
      const p = PAPERS[paper];
      const w = window.open('', '_blank');
      if (!w) {
        say('The browser blocked the print window: allow pop-ups, or use “Download sheet”.', true);
        return;
      }
      w.document.write(
        `<!doctype html><title>${name}</title><style>@page{size:${p.w}in ${p.h}in;margin:0}html,body{margin:0}` +
          `img{width:${p.w}in;height:${p.h}in;display:block}</style><img src="${url}" onload="setTimeout(()=>print(),200)">`,
      );
      w.document.close();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } finally {
      setBusy(null);
    }
  };

  // ── Save to a student ──────────────────────────────────
  const [q, setQ] = useState('');
  const [found, setFound] = useState<LeadListItem[] | null>(null);
  const [student, setStudent] = useState<LeadListItem | null>(null);
  const [studentPapers, setStudentPapers] = useState<LeadPaper[] | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound(null);
      return;
    }
    const t = setTimeout(() => {
      listLeads({ search: q.trim(), page: 0 })
        .then((r) => setFound(r.items.slice(0, 8)))
        .catch(() => setFound([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const choose = (s: LeadListItem) => {
    setStudent(s);
    setFound(null);
    setStudentPapers(null);
    getLeadPapers(s.id)
      .then((r) => {
        setStudentPapers(r.papers);
        const photoPaper = r.papers.find((p) => /photo|ছবি/i.test(p.name)) ?? null;
        setPaperId(photoPaper?.paperId ?? null);
      })
      .catch(() => setStudentPapers([]));
  };
  const toStudent = async () => {
    const c = full();
    if (!c || !student) return;
    setBusy('student');
    try {
      const rule = await ruleFor(paperId);
      const limit = size.max_kb > 0 ? Math.min(size.max_kb, rule.imgMaxKb) : rule.imgMaxKb;
      const made = await makeFile(c, 'jpg', limit, size.dpi);
      const paperName = studentPapers?.find((p) => p.paperId === paperId)?.name ?? null;
      const row = await uploadLeadFile({
        leadId: student.id,
        kind: paperId ? 'paper' : 'other',
        paperId,
        uri: '',
        name: `${paperName ?? name}.jpg`,
        mimeType: 'image/jpeg',
        file: made.blob,
      });
      const wrong =
        rule.exact && (rule.exact.width !== W || rule.exact.height !== H)
          ? ` · note: this paper's size is ${rule.exact.width} × ${rule.exact.height}`
          : '';
      say(`✅ Saved to ${student.name}${paperName ? ` · ${paperName}` : ''} (${sizeText(made.blob.size)})${wrong}.`);
      await remember(made.blob, row.name ?? `${name}.jpg`);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not save.', true);
    } finally {
      setBusy(null);
    }
  };

  // ── Save a size for everyone ───────────────────────────
  const [newName, setNewName] = useState('');
  const keepSize = async () => {
    const n = newName.trim();
    if (!n) return say('Give the size a name.', true);
    const p: Preset = {
      ...size,
      id: `p${Date.now().toString(36)}`,
      name: n,
      source: 'saved',
    };
    const list = [...saved.filter((s) => s.name.toLowerCase() !== n.toLowerCase()), p];
    try {
      await saveSavedPresets(list);
      setSaved(list);
      setChosen(p.id);
      setNewName('');
      say(`💾 “${n}” saved for everyone.`);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not save.', true);
    }
  };
  const dropSize = async (id: string) => {
    const list = saved.filter((s) => s.id !== id);
    try {
      await saveSavedPresets(list);
      setSaved(list);
      if (chosen === id) setChosen('custom');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not remove.', true);
    }
  };

  // Thumbnails for the recent list
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const r of recent) next[r.id] = URL.createObjectURL(r.blob);
    setThumbs(next);
    return () => Object.values(next).forEach((u) => URL.revokeObjectURL(u));
  }, [recent]);

  // ─────────────────────────────────────────────────────────
  if (allowed === null)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  if (!allowed)
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>🖼 Photo Studio is for admins and the Admission Officer.</Text>
      </View>
    );

  const faceText = !photo
    ? null
    : head?.by === 'face'
      ? `🙂 Face found${faces && faces.length > 1 ? ` (${faceAt + 1} of ${faces.length})` : ''}`
      : head?.by === 'outline'
        ? '👤 Head from the outline'
        : '✋ Place by hand';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) void open(f, f.name);
          e.currentTarget.value = '';
        }}
      />
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.h1}>🖼 Photo Studio</Text>
          <Text style={styles.muted}>
            Drop a photo, paste it (Ctrl+V) or choose one. The face is found and the background changed; then move it,
            zoom, fix the light and download, print or save it to a student.
          </Text>
        </View>
        {usage != null && (
          <Text style={styles.usage} accessibilityLabel="remove.bg this month">
            remove.bg this month: {usage}
          </Text>
        )}
      </View>
      {msg && <Text style={[styles.msg, msg.bad && styles.msgBad]}>{msg.text}</Text>}

      <View style={styles.cols}>
        {/* ── Left: sizes ─────────────────────────────── */}
        <View style={[styles.panel, styles.left]}>
          <Text style={styles.h2}>Size</Text>
          <View style={styles.chips}>
            {papers.map((p) => (
              <Chip key={p.id} on={chosen === p.id} label={`📎 ${p.name}`} onPress={() => pickSize(p, p.id)} />
            ))}
            {saved.map((p) => (
              <Chip
                key={p.id}
                on={chosen === p.id}
                label={`⭐ ${p.name}`}
                onPress={() => pickSize(p, p.id)}
                onRemove={() => dropSize(p.id)}
              />
            ))}
            <Chip on={chosen === 'custom'} label="✏️ Custom" onPress={() => setChosen('custom')} />
          </View>
          <Text style={styles.small}>{sizeLabel(size)}</Text>

          <View style={styles.row}>
            <Field label="Width" value={size.width} onChange={(v) => editSize({ width: v })} />
            <Text style={styles.times}>×</Text>
            <Field label="Height" value={size.height} onChange={(v) => editSize({ height: v })} />
          </View>
          <View style={styles.row}>
            {(['px', 'mm', 'in'] as Unit[]).map((u) => (
              <Chip key={u} on={size.unit === u} label={u} onPress={() => editSize({ unit: u })} />
            ))}
            <Field label="DPI" value={size.dpi} onChange={(v) => editSize({ dpi: v })} />
          </View>
          <Slider
            label={`Head size ${size.face_pct}% of the height`}
            min={20}
            max={85}
            step={1}
            value={size.face_pct}
            onChange={(v) => editSize({ face_pct: v })}
          />
          <Slider
            label={`Room above the head ${size.top_pct}%`}
            min={0}
            max={30}
            step={1}
            value={size.top_pct}
            onChange={(v) => editSize({ top_pct: v })}
          />
          <View style={styles.row}>
            <Field label="Max KB (0 = any)" value={size.max_kb} onChange={(v) => editSize({ max_kb: v })} zero />
            <Chip on={size.format === 'jpg'} label="JPG" onPress={() => editSize({ format: 'jpg' })} />
            <Chip on={size.format === 'png'} label="PNG" onPress={() => editSize({ format: 'png' })} />
          </View>

          <View style={styles.sep} />
          <Text style={styles.label}>💾 Keep this size for everyone</Text>
          <View style={styles.row}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Name, e.g. Visa 2×2 in"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { flex: 1 }]}
              onSubmitEditing={keepSize}
            />
            <Btn label="Save" onPress={keepSize} />
          </View>
        </View>

        {/* ── Middle: the editor ──────────────────────── */}
        <View style={[styles.panel, styles.mid]}>
          {!photo ? (
            <Pressable
              onPress={() => inputRef.current?.click()}
              style={[styles.drop, dragging && styles.dropOn]}
              accessibilityRole="button"
              accessibilityLabel="Choose a photo"
            >
              <Text style={styles.dropIcon}>📷</Text>
              <Text style={styles.dropText}>Drop a photo here, paste it (Ctrl+V) or click to choose</Text>
              <Text style={styles.small}>A full photo is fine: the face is found automatically.</Text>
            </Pressable>
          ) : (
            <>
              <View style={[styles.stage, dragging && styles.dropOn]}>
                <canvas
                  ref={canvasRef}
                  aria-label="Photo: drag to move, wheel to zoom"
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  style={{
                    width: Math.round(W * kCss),
                    height: Math.round(H * kCss),
                    cursor: drag.current ? 'grabbing' : 'grab',
                    touchAction: 'none',
                    boxShadow: '0 1px 6px rgba(0,0,0,0.25)',
                    background: '#fff',
                  }}
                />
                {step && (
                  <View style={styles.wait}>
                    <ActivityIndicator color={colors.primary} />
                    <Text style={styles.waitText}>{step}</Text>
                  </View>
                )}
              </View>
              <Text style={styles.small}>
                {faceText} · drag to move · wheel or + − to zoom · arrows to nudge (Shift = more)
              </Text>
              {!!note && <Text style={styles.note}>⚠ {note}</Text>}

              <View style={styles.tools}>
                <Btn label="🎯 Auto place" onPress={reAuto} />
                {faces && faces.length > 1 && <Btn label="🙂 Next face" onPress={nextFace} />}
                <Btn label="＋" onPress={() => look && setLook(zoomAt(look, 1.06, W / 2, H / 2))} />
                <Btn label="－" onPress={() => look && setLook(zoomAt(look, 1 / 1.06, W / 2, H / 2))} />
                <Btn label="↺ 90°" onPress={() => quarter(false)} />
                <Btn label="↻ 90°" onPress={() => quarter(true)} />
                <Btn label="⇋ Mirror" on={look?.flip} onPress={() => set({ flip: !look?.flip })} />
                <Btn label="▦ Guides" on={guides} onPress={() => setGuides(!guides)} />
                <Pressable
                  onPressIn={() => setBefore(true)}
                  onPressOut={() => setBefore(false)}
                  style={styles.btn}
                  accessibilityRole="button"
                >
                  <Text style={styles.btnText}>👁 Hold: before</Text>
                </Pressable>
                <Btn label="📷 Another photo" onPress={() => inputRef.current?.click()} />
              </View>
              {look && (
                <Slider
                  label={`Straighten ${look.tilt.toFixed(1)}°`}
                  min={-20}
                  max={20}
                  step={0.5}
                  value={look.tilt}
                  onChange={(v) => set({ tilt: v })}
                />
              )}
              <Toggle
                on={straighten}
                label="Level the eyes automatically"
                onPress={() => {
                  setStraighten(!straighten);
                  if (photo && look && head)
                    setLook(placeHead(look, photo, head, W, H, size.face_pct, size.top_pct, !straighten));
                }}
              />
            </>
          )}
        </View>

        {/* ── Right: look, result ─────────────────────── */}
        <View style={[styles.panel, styles.right]}>
          <Text style={styles.h2}>Background</Text>
          <View style={styles.row}>
            <Toggle
              on={!!look?.bgOn && !!mask}
              label={mask ? 'Change the background' : 'Remove the background'}
              onPress={() => (mask ? set({ bgOn: !look?.bgOn }) : removeBgNow())}
              disabled={!photo || !!step}
            />
          </View>
          <View style={styles.swatches}>
            {SWATCHES.map((c) => (
              <Pressable
                key={c}
                onPress={() => editSize({ bg: c })}
                style={[
                  styles.swatch,
                  { backgroundColor: c },
                  size.bg.toLowerCase() === c.toLowerCase() && styles.swatchOn,
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: size.bg === c }}
                accessibilityLabel={`Background ${c}`}
              />
            ))}
            <input
              type="color"
              value={size.bg}
              onChange={(e) => editSize({ bg: e.currentTarget.value })}
              aria-label="Any colour"
              style={{
                width: 34,
                height: 30,
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            />
          </View>
          {look && mask && (
            <Slider
              label={`Soft edge ${look.feather.toFixed(1)} px`}
              min={0}
              max={6}
              step={0.5}
              value={look.feather}
              onChange={(v) => set({ feather: v })}
            />
          )}
          <Toggle
            on={autoBg}
            label="Remove the background of every new photo"
            onPress={() => {
              savePref(AUTO_BG_KEY, !autoBg);
              setAutoBg(!autoBg);
            }}
          />

          <View style={styles.sep} />
          <Text style={styles.h2}>Light</Text>
          {look && (
            <>
              <Slider
                label={`Brightness ${Math.round(look.brightness * 100)}%`}
                min={0.5}
                max={1.6}
                step={0.01}
                value={look.brightness}
                onChange={(v) => set({ brightness: v })}
              />
              <Slider
                label={`Contrast ${Math.round(look.contrast * 100)}%`}
                min={0.5}
                max={1.6}
                step={0.01}
                value={look.contrast}
                onChange={(v) => set({ contrast: v })}
              />
              <Slider
                label={`Colour ${Math.round(look.saturation * 100)}%`}
                min={0}
                max={2}
                step={0.01}
                value={look.saturation}
                onChange={(v) => set({ saturation: v })}
              />
              <Slider
                label={`Warmth ${look.warmth > 0 ? '+' : ''}${Math.round(look.warmth * 100)}`}
                min={-1}
                max={1}
                step={0.05}
                value={look.warmth}
                onChange={(v) => set({ warmth: v })}
              />
              <View style={styles.row}>
                <Btn
                  label="✨ Auto light"
                  onPress={() => photo && set(autoLight(photo, mask, faces?.[faceAt] ?? null))}
                />
                <Btn label="Reset light" onPress={() => set(NEUTRAL)} />
              </View>
            </>
          )}

          <View style={styles.sep} />
          <Text style={styles.h2}>Download</Text>
          <TextInput
            value={outName}
            onChangeText={setOutName}
            placeholder={`${fileName}-${W}x${H}`}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            accessibilityLabel="File name"
          />
          <View style={styles.row}>
            <Btn
              label={busy === 'save' ? 'Making…' : `⬇ Download ${size.format.toUpperCase()}`}
              main
              onPress={save}
              disabled={!look}
            />
            <Btn label="📋 Copy" onPress={copy} disabled={!look} />
          </View>
          {!!lastSize && <Text style={styles.small}>{lastSize}</Text>}

          <View style={styles.sep} />
          <Text style={styles.h2}>🖨 Print sheet</Text>
          <View style={styles.row}>
            {(Object.keys(PAPERS) as Paper[]).map((p) => (
              <Chip key={p} on={paper === p} label={PAPERS[p].label} onPress={() => setPaper(p)} />
            ))}
          </View>
          {fits === 0 ? (
            <Text style={styles.small}>This size does not fit on {PAPERS[paper].label}.</Text>
          ) : (
            <>
              <Text style={styles.small}>
                {physical.w.toFixed(2)} × {physical.h.toFixed(2)} in each · up to {fits} on a sheet
              </Text>
              <View style={styles.row}>
                {copyChoices.map((n) => (
                  <Chip key={n} on={nCopies === n} label={`${n}`} onPress={() => setCopies(n)} />
                ))}
              </View>
              <View style={styles.row}>
                <Btn label="⬇ Download sheet" onPress={() => sheet(false)} disabled={!look} />
                <Btn label="🖨 Print" onPress={() => sheet(true)} disabled={!look} />
              </View>
            </>
          )}

          <View style={styles.sep} />
          <Text style={styles.h2}>🎓 Save to a student</Text>
          {student ? (
            <View style={styles.gap}>
              <View style={styles.row}>
                <Text style={[styles.label, { flex: 1 }]} numberOfLines={1}>
                  {student.name}
                  {student.student_ref ? ` · ${student.student_ref}` : ''}
                </Text>
                <Btn label="Change" onPress={() => setStudent(null)} />
              </View>
              {studentPapers === null ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <View style={styles.chips}>
                  {studentPapers.map((p) => (
                    <Chip
                      key={p.paperId}
                      on={paperId === p.paperId}
                      label={`${p.status ? '✅ ' : ''}${p.name}`}
                      onPress={() => setPaperId(p.paperId)}
                    />
                  ))}
                  <Chip on={paperId === null} label="Other file" onPress={() => setPaperId(null)} />
                </View>
              )}
              <Btn
                label={busy === 'student' ? 'Saving…' : '☁ Save to Google Drive'}
                main
                onPress={toStudent}
                disabled={!look || busy === 'student'}
              />
            </View>
          ) : (
            <View style={styles.gap}>
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Name, phone or Student ID"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
              {found?.map((s) => (
                <Pressable
                  key={s.id}
                  onPress={() => choose(s)}
                  style={(st) => [styles.hit, (st as { hovered?: boolean }).hovered && styles.hitHover]}
                  accessibilityRole="button"
                >
                  <Text style={styles.label} numberOfLines={1}>
                    {s.name}
                  </Text>
                  <Text style={styles.small} numberOfLines={1}>
                    {[s.student_ref, s.phone, s.stage?.name].filter(Boolean).join(' · ')}
                  </Text>
                </Pressable>
              ))}
              {found?.length === 0 && <Text style={styles.small}>No one found.</Text>}
            </View>
          )}
        </View>
      </View>

      {recent.length > 0 && (
        <View style={styles.panel}>
          <View style={styles.row}>
            <Text style={[styles.h2, { flex: 1 }]}>🕘 Recent (this browser)</Text>
            <Btn
              label="Clear"
              onPress={async () => {
                await clearRecent();
                setRecent([]);
              }}
            />
          </View>
          <View style={styles.recent}>
            {recent.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => download(r.blob, r.name)}
                style={styles.recentItem}
                accessibilityRole="button"
                accessibilityLabel={`Download ${r.name}`}
              >
                {thumbs[r.id] && (
                  <img
                    src={thumbs[r.id]}
                    alt=""
                    style={{
                      height: 90,
                      width: Math.round((90 * r.w) / r.h),
                      objectFit: 'cover',
                      borderRadius: 6,
                    }}
                  />
                )}
                <Text style={styles.recentName} numberOfLines={1}>
                  {r.name}
                </Text>
                <Text style={styles.small}>{sizeText(r.blob.size)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------
function Chip({
  label,
  on,
  onPress,
  onRemove,
}: {
  label: string;
  on?: boolean;
  onPress: () => void;
  onRemove?: () => void;
}) {
  return (
    <View style={[styles.chip, on && styles.chipOn]}>
      <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: !!on }}>
        <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
      </Pressable>
      {onRemove && (
        <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={`Remove ${label}`}>
          <Text style={[styles.chipText, on && styles.chipTextOn, styles.chipX]}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

function Btn({
  label,
  onPress,
  main,
  on,
  disabled,
}: {
  label: string;
  onPress: () => void;
  main?: boolean;
  on?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={(s) => [
        styles.btn,
        (main || on) && styles.btnMain,
        !disabled && (s as { hovered?: boolean }).hovered && styles.btnHover,
        disabled && styles.off,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
    >
      <Text style={[styles.btnText, (main || on) && styles.btnTextMain]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({
  label,
  on,
  onPress,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[styles.toggle, disabled && styles.off]}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled: !!disabled }}
    >
      <View style={[styles.box, on && styles.boxOn]}>{on && <Text style={styles.tick}>✓</Text>}</View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.slider}>
      <Text style={styles.small}>{label}</Text>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        onDoubleClick={() => onChange(min < 0 ? 0 : min <= 1 && max >= 1 && max <= 2 ? 1 : value)}
        style={{ width: '100%', accentColor: colors.primary }}
      />
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  zero,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  zero?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          const n = Number(t.replace(',', '.'));
          if (Number.isFinite(n) && (n > 0 || (zero && n === 0))) onChange(n);
        }}
        keyboardType="numeric"
        style={[styles.input, styles.num]}
        accessibilityLabel={label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  page: { padding: spacing.lg, gap: spacing.md },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  h1: {
    fontSize: fontSize.heading,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  h2: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  label: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  usage: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  msg: {
    alignSelf: 'flex-start',
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.success,
    backgroundColor: colors.successSoft,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  msgBad: { color: colors.danger, backgroundColor: colors.dangerSoft },
  cols: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  panel: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  left: { flexBasis: 270, flexGrow: 1, flexShrink: 1, minWidth: 250, maxWidth: 340 },
  mid: { flexBasis: BOX_W + 2 * spacing.lg, flexGrow: 2, flexShrink: 0, alignItems: 'center' },
  right: { flexBasis: 290, flexGrow: 1, flexShrink: 1, minWidth: 270, maxWidth: 360 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  chipTextOn: { color: colors.textOnPrimary },
  chipX: { fontSize: fontSize.body, lineHeight: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  gap: { gap: spacing.sm },
  times: { fontSize: fontSize.body, color: colors.textMuted, marginTop: 14 },
  field: { gap: 2 },
  fieldLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  input: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.small,
  },
  num: { width: 84 },
  sep: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  drop: {
    width: BOX_W,
    height: BOX_H,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  dropOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  dropIcon: { fontSize: 48 },
  dropText: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    textAlign: 'center',
  },
  stage: {
    width: BOX_W + 2,
    height: BOX_H + 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    // a checkerboard-free plain grey so the photo's edge shows
    backgroundColor: colors.background,
  },
  wait: {
    position: 'absolute',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  waitText: { fontSize: fontSize.small, color: colors.text },
  note: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.warning,
    alignSelf: 'stretch',
  },
  tools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    justifyContent: 'center',
  },
  btn: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  btnMain: { backgroundColor: colors.primary, borderColor: colors.primary },
  btnHover: { borderColor: colors.primary },
  btnText: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  btnTextMain: { color: colors.textOnPrimary },
  off: { opacity: 0.5 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
    paddingVertical: 2,
  },
  box: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: {
    fontSize: 12,
    lineHeight: 14,
    color: colors.textOnPrimary,
    fontWeight: fontWeight.bold,
  },
  slider: { gap: 2, alignSelf: 'stretch' },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    alignItems: 'center',
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  swatchOn: { borderWidth: 3, borderColor: colors.primary },
  hit: {
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  hitHover: { backgroundColor: colors.primarySoft },
  recent: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  recentItem: { alignItems: 'center', gap: 2, maxWidth: 120 },
  recentName: { fontSize: fontSize.caption, color: colors.text, maxWidth: 120 },
});
