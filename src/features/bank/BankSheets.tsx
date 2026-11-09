import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { md } from '@/features/home/md';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { listPipelineStages, openStages, type PipelineStage } from '@/features/pipeline/api';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { colors, fontSize, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import {
  createBankList,
  importToBank,
  parsePasted,
  pullFromBank,
  type BankImportResult,
  type BankInput,
  type BankList,
} from './api';

// =====================================================================
// 🏦 Lead Bank sheets: put numbers into the leads · bring numbers in ·
//   send leads back (from the lead page and the lead list)
// =====================================================================

function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

// ---------------------------------------------------------------------
// ➡️ Into the leads
// ---------------------------------------------------------------------
export function PullSheet({
  ids,
  hasNew,
  onClose,
  onDone,
}: {
  ids: string[];
  /** some have never been leads: a course is needed for them */
  hasNew: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [courses, setCourses] = useState<CourseWithDetails[] | null>(null);
  const [people, setPeople] = useState<AssignableUser[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [course, setCourse] = useState<string | null>(null);
  const [who, setWho] = useState<string[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      listCourses().catch(() => []),
      listAssignableUsers().catch(() => []),
      listPipelineStages().catch(() => []),
    ]).then(([c, p, st]) => {
      setCourses(c);
      if (c.length === 1) setCourse(c[0].id);
      setPeople(p.filter((u) => u.is_active));
      setStages(openStages(st));
    });
  }, []);

  const needCourse = hasNew && (courses?.length ?? 0) > 0;
  const go = async () => {
    if (needCourse && !course) return setError('Choose the course.');
    setBusy(true);
    setError(null);
    try {
      const r = await pullFromBank({ ids, courseId: course, assignees: who, stageId: stage });
      const parts = [
        r.created ? `${r.created} new lead${r.created === 1 ? '' : 's'}` : null,
        r.back ? `${r.back} back with their history` : null,
        r.skipped ? `${r.skipped} skipped (resting, do not call, or already a lead)` : null,
      ].filter(Boolean);
      say('Done', parts.join(' · ') || 'Nothing to put in.');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do it.');
      setBusy(false);
    }
  };

  return (
    <Sheet title={`➡️ ${ids.length} into the leads`} onClose={onClose}>
      {courses === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <Text style={ui.label}>COURSE{needCourse ? ' *' : ''}</Text>
          {!hasNew && <Text style={ui.muted}>Returned ones keep their own course; this one is for any without.</Text>}
          <View style={ui.chips}>
            {courses.map((c) => (
              <Chip
                key={c.id}
                text={c.name}
                on={course === c.id}
                onPress={() => setCourse(course === c.id ? null : c.id)}
              />
            ))}
          </View>

          <Text style={ui.label}>GIVE TO (IN TURN)</Text>
          <Text style={ui.muted}>
            {who.length === 0
              ? 'Nobody chosen: the usual rule for new leads decides (returned ones keep their person).'
              : `${ids.length} shared one by one between ${who.length}.`}
          </Text>
          <View style={ui.chips}>
            {people.map((u) => (
              <Chip
                key={u.id}
                text={u.full_name ?? 'No name'}
                on={who.includes(u.id)}
                onPress={() => setWho((w) => (w.includes(u.id) ? w.filter((x) => x !== u.id) : [...w, u.id]))}
              />
            ))}
          </View>

          <Text style={ui.label}>STAGE</Text>
          <View style={ui.chips}>
            <Chip text="New (default)" on={!stage} onPress={() => setStage(null)} />
            {stages
              .filter((s) => s.key !== 'new')
              .map((s) => (
                <Chip key={s.id} text={s.name} on={stage === s.id} onPress={() => setStage(s.id)} />
              ))}
          </View>
        </>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title="Put into leads" onPress={go} loading={busy} disabled={courses === null} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// 📥 Numbers into the bank: paste, or an Excel / CSV file
// ---------------------------------------------------------------------
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9ঀ-৿]/g, '');
const PHONE_WORDS = ['phone', 'mobile', 'number', 'contact', 'cell', 'ফোন', 'মোবাইল', 'নম্বর'];
const NAME_WORDS = ['name', 'নাম'];
const AREA_WORDS = ['area', 'address', 'district', 'upazila', 'thana', 'এলাকা', 'ঠিকানা'];
/** "WhatsApp", "WhatsApp number", "WA" (not "Ward") */
const isWa = (h: string) => h.includes('whatsapp') || h === 'wa' || h === 'wano' || h === 'wanumber';

/** The column for these words: an exact header first, then one that has the word in it */
function column(heads: string[], words: string[], skip: (h: string, i: number) => boolean = () => false) {
  const ws = words.map(norm);
  const exact = heads.findIndex((h, i) => !skip(h, i) && ws.includes(h));
  if (exact >= 0) return exact;
  return heads.findIndex((h, i) => !skip(h, i) && ws.some((w) => w.length > 2 && h.includes(w)));
}

export function ImportSheet({
  lists,
  listId: given,
  onClose,
  onDone,
}: {
  lists: BankList[];
  listId: string | null;
  onClose: () => void;
  onDone: (r: BankImportResult) => void;
}) {
  const [listId, setListId] = useState<string | null>(given);
  const [newList, setNewList] = useState('');
  const [mode, setMode] = useState<'paste' | 'file'>('paste');
  const [text, setText] = useState('');
  const [fileRows, setFileRows] = useState<BankInput[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // a new list made on a try that failed later: used again, not made twice
  const [made, setMade] = useState<{ name: string; id: string } | null>(null);

  const pasted = useMemo(() => (mode === 'paste' ? parsePasted(text) : []), [mode, text]);
  const rows = mode === 'paste' ? pasted : (fileRows ?? []);

  const pick = async () => {
    setError(null);
    try {
      // the spreadsheet code loads only when a file is chosen
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { pickSpreadsheet, readSpreadsheet } =
        require('@/features/import-export/excel') as typeof import('@/features/import-export/excel');
      const f = await pickSpreadsheet();
      if (!f) return;
      const sh = await readSpreadsheet(f.uri);
      const heads = sh.headers.map(norm);
      // the phone column is not the WhatsApp one (unless that is all there is)
      let iPhone = column(heads, PHONE_WORDS, (h) => isWa(h));
      if (iPhone < 0) iPhone = heads.findIndex(isWa);
      if (iPhone < 0) throw new Error('No phone column found (a header like “Phone” or “Mobile”).');
      const iName = column(heads, NAME_WORDS, (_, i) => i === iPhone);
      const iArea = column(heads, AREA_WORDS, (_, i) => i === iPhone || i === iName);
      const iWa = heads.findIndex((h, i) => i !== iPhone && isWa(h));
      const out: BankInput[] = [];
      for (const r of sh.rows) {
        const phone = (r[iPhone] ?? '').trim();
        if (!phone) continue;
        out.push({
          phone,
          name: iName >= 0 ? (r[iName] ?? '').trim() || undefined : undefined,
          area: iArea >= 0 ? (r[iArea] ?? '').trim() || undefined : undefined,
          whatsapp_number: iWa >= 0 ? (r[iWa] ?? '').trim() || undefined : undefined,
        });
      }
      setFileRows(out);
      setFileName(f.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file.');
    }
  };

  const go = async () => {
    if (rows.length === 0) return setError('No numbers found.');
    setBusy(true);
    setError(null);
    try {
      let target = listId;
      const name = newList.trim();
      if (name) {
        target = made?.name === name ? made.id : await createBankList(name);
        setMade({ name, id: target });
      }
      const r = await importToBank(target, rows, setStep);
      onDone(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not bring them in.');
      setBusy(false);
    }
  };

  return (
    <Sheet title="📥 Numbers into the bank" onClose={onClose}>
      <Text style={ui.label}>LIST</Text>
      <View style={ui.chips}>
        <Chip text="No list" on={!listId && !newList.trim()} onPress={() => (setListId(null), setNewList(''))} />
        {lists.map((l) => (
          <Chip
            key={l.id}
            text={l.name}
            on={listId === l.id && !newList.trim()}
            onPress={() => (setListId(l.id), setNewList(''))}
          />
        ))}
      </View>
      <TextInput
        value={newList}
        onChangeText={setNewList}
        placeholder="…or a new list, e.g. Education fair 2026"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        maxLength={80}
      />

      <View style={ui.chips}>
        <Chip text="📋 Paste numbers" on={mode === 'paste'} onPress={() => setMode('paste')} />
        <Chip text="📊 Excel / CSV" on={mode === 'file'} onPress={() => setMode('file')} />
      </View>
      {mode === 'paste' ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={'One per line:\n01712345678\nRahim, 01812345678'}
            placeholderTextColor={colors.textMuted}
            multiline
            style={[styles.input, styles.multi]}
          />
        </>
      ) : (
        <Button
          title={fileName ? `📄 ${fileName} · choose another` : 'Choose a file'}
          variant="secondary"
          onPress={pick}
          fullWidth
        />
      )}
      <Text style={ui.muted}>
        {rows.length > 0
          ? `${rows.length} number${rows.length === 1 ? '' : 's'} found. Numbers already in the bank or already leads are left out.`
          : 'Headers like Name, Phone, Area are found by themselves.'}
      </Text>
      {busy && step > 0 && <Text style={ui.muted}>{`${step} / ${rows.length}…`}</Text>}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button
            title={`Bring in ${rows.length || ''}`.trim()}
            onPress={go}
            loading={busy}
            disabled={rows.length === 0}
            fullWidth
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 140, paddingTop: spacing.sm, textAlignVertical: 'top' },
});
