import { router, Stack, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import {
  ALUMNI_IMPORT_FIELDS,
  alumniFromStudents,
  importAlumni,
  listAlumniFields,
  type AlumniField,
  type AlumnusInput,
  type ImportResult,
} from '@/features/alumni/api';
import { alumniChanged, Chip, s as ui, useAlumniAccess } from '@/features/alumni/ui';
import { pickSpreadsheet, readSpreadsheet, type Spreadsheet } from '@/features/import-export/excel';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { isWeb } from '@/features/web/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📥 Alumni in bulk:
//   1. From Students: a whole batch that passed (or one course)
//   2. From an Excel / CSV file (columns matched by their header)
// =====================================================================

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[_\-.:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export default function AlumniImportScreen() {
  const access = useAlumniAccess();
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [fields, setFields] = useState<AlumniField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    listCourses()
      .then(setCourses)
      .catch(() => undefined);
    listAlumniFields()
      .then(setFields)
      .catch(() => undefined);
  }, []);

  if (!access.manage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Import alumni' }} />
        <Text style={ui.muted}>Only people who manage alumni can import.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Import alumni' }} />
      <FromStudents courses={courses} onResult={setResult} onError={setError} />
      <FromExcel courses={courses} fields={fields} onResult={setResult} onError={setError} />
      <View style={ui.card}>
        <Text style={styles.h}>📱 From phone contacts</Text>
        <Text style={ui.muted}>
          Coming in the next update: Phone contacts → a group (e.g. “Alumni ITTC”) → Save as alumni.
        </Text>
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      {result && <ResultCard r={result} />}
    </ScrollView>
  );
}

function ResultCard({ r }: { r: ImportResult }) {
  return (
    <View style={[ui.card, styles.result]}>
      <Text style={styles.h}>✅ Done</Text>
      <Text style={styles.line}>
        Added {r.added}
        {r.updated ? ` · updated ${r.updated}` : ''} · already there {r.skipped}
        {r.failed ? ` · could not add ${r.failed}` : ''}
      </Text>
      {r.errors.slice(0, 10).map((e) => (
        <Text key={e.row} style={ui.error}>
          Row {e.row}
          {e.name ? ` (${e.name})` : ''}: {e.error}
        </Text>
      ))}
      <Button title="Open Alumni" variant="secondary" onPress={() => router.replace('/alumni' as Href)} fullWidth />
    </View>
  );
}

// ---------------------------------------------------------------------
function FromStudents({
  courses,
  onResult,
  onError,
}: {
  courses: CourseWithDetails[];
  onResult: (r: ImportResult) => void;
  onError: (e: string | null) => void;
}) {
  const [courseId, setCourseId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const batches = courses.find((c) => c.id === courseId)?.batches ?? [];

  useEffect(() => {
    setCount(null);
    if (!batchId) return;
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('admitted_batch_id', batchId)
      .not('admitted_at', 'is', null)
      .is('cancelled_at', null)
      .is('deleted_at', null)
      .then(({ count: c }) => setCount(c ?? 0));
  }, [batchId]);

  const run = async () => {
    if (!batchId) return;
    setBusy(true);
    onError(null);
    try {
      const r = await alumniFromStudents({ batchId });
      alumniChanged();
      onResult(r);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.card}>
      <Text style={styles.h}>🎓 From Students (a batch that passed)</Text>
      <Text style={ui.muted}>
        Every admitted student of the batch becomes an alumnus: name, phone, course, batch and Student ID come along.
        Ones already in Alumni are skipped.
      </Text>
      <View style={ui.chips}>
        {courses.map((c) => (
          <Chip
            key={c.id}
            text={c.name}
            on={courseId === c.id}
            onPress={() => {
              setCourseId(c.id);
              setBatchId(null);
            }}
          />
        ))}
      </View>
      {batches.length > 0 && (
        <View style={ui.chips}>
          {batches.map((b) => (
            <Chip key={b.id} text={b.name} on={batchId === b.id} onPress={() => setBatchId(b.id)} />
          ))}
        </View>
      )}
      {courseId && batches.length === 0 && <Text style={ui.muted}>This course has no batches.</Text>}
      {batchId && (
        <Button
          title={count === null ? 'Make them alumni' : `Make ${count} student${count === 1 ? '' : 's'} alumni`}
          onPress={run}
          loading={busy}
          disabled={count === 0}
          fullWidth
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
type Target = { key: string; label: string; words: string[]; custom?: boolean };

function FromExcel({
  courses,
  fields,
  onResult,
  onError,
}: {
  courses: CourseWithDetails[];
  fields: AlumniField[];
  onResult: (r: ImportResult) => void;
  onError: (e: string | null) => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Spreadsheet | null>(null);
  const [map, setMap] = useState<Record<string, number | null>>({});
  const [courseId, setCourseId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [update, setUpdate] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const targets = useMemo<Target[]>(
    () => [
      ...ALUMNI_IMPORT_FIELDS.map((f) => ({ key: f.key as string, label: f.label, words: f.words })),
      ...fields.map((f) => ({ key: 'custom.' + f.key, label: f.label, words: [norm(f.label), f.key], custom: true })),
    ],
    [fields],
  );
  const batches = courses.find((c) => c.id === courseId)?.batches ?? [];

  const pick = async () => {
    onError(null);
    try {
      const f = await pickSpreadsheet();
      if (!f) return;
      setReading(true);
      const sh = await readSpreadsheet(f.uri);
      setFile(f.name);
      setSheet(sh);
      // match columns by their header words
      const used = new Set<number>();
      const m: Record<string, number | null> = {};
      const heads = sh.headers.map(norm);
      for (const t of targets) {
        let idx = heads.findIndex((h, i) => !used.has(i) && t.words.some((w) => h === norm(w)));
        if (idx < 0) idx = heads.findIndex((h, i) => !used.has(i) && t.words.some((w) => h.includes(norm(w))));
        m[t.key] = idx >= 0 ? idx : null;
        if (idx >= 0) used.add(idx);
      }
      setMap(m);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setReading(false);
    }
  };

  const rows = useMemo<(AlumnusInput & { from?: string })[]>(() => {
    if (!sheet) return [];
    return sheet.rows.map((r) => {
      const out: Record<string, unknown> = { from: 'excel', custom: {} };
      for (const t of targets) {
        const i = map[t.key];
        if (i === null || i === undefined) continue;
        const v = (r[i] ?? '').trim();
        if (!v) continue;
        if (t.custom) (out.custom as Record<string, string>)[t.key.slice(7)] = v;
        else out[t.key] = v;
      }
      if (courseId) out.course_id = courseId;
      if (batchId) out.batch_id = batchId;
      return out as AlumnusInput & { from?: string };
    });
  }, [sheet, map, targets, courseId, batchId]);

  const run = async () => {
    if (map.name === null || map.name === undefined) return onError('Choose which column is the Name.');
    setBusy(true);
    onError(null);
    try {
      const r = await importAlumni(rows, update);
      alumniChanged();
      onResult(r);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.card}>
      <Text style={styles.h}>📊 From an Excel / CSV file</Text>
      <Text style={ui.muted}>
        First row = headers (Name, Phone, Session, Roll, School, District…). Columns are matched by their header; tap a
        field to change it.
      </Text>
      <Button
        title={file ? `📄 ${file} · choose another` : 'Choose a file'}
        variant="secondary"
        onPress={pick}
        fullWidth
      />
      {reading && <ActivityIndicator color={colors.primary} />}
      {sheet && (
        <>
          <Text style={ui.label}>COLUMNS ({sheet.rows.length} rows)</Text>
          {targets.map((t) => {
            const i = map[t.key];
            return (
              <View key={t.key}>
                <Pressable
                  onPress={() => setEditing(editing === t.key ? null : t.key)}
                  style={styles.mapRow}
                  accessibilityRole="button"
                >
                  <Text style={styles.mapField}>{t.label}</Text>
                  <Text
                    style={[styles.mapCol, i === null || i === undefined ? styles.mapNone : null]}
                    numberOfLines={1}
                  >
                    {i === null || i === undefined ? '— not in the file' : sheet.headers[i] || `Column ${i + 1}`} ▾
                  </Text>
                </Pressable>
                {editing === t.key && (
                  <View style={[ui.chips, styles.mapPick]}>
                    <Chip
                      text="— none"
                      on={i === null || i === undefined}
                      onPress={() => {
                        setMap((m) => ({ ...m, [t.key]: null }));
                        setEditing(null);
                      }}
                    />
                    {sheet.headers.map((h, idx) => (
                      <Chip
                        key={idx}
                        text={h || `Column ${idx + 1}`}
                        on={i === idx}
                        onPress={() => {
                          setMap((m) => ({ ...m, [t.key]: idx }));
                          setEditing(null);
                        }}
                      />
                    ))}
                  </View>
                )}
              </View>
            );
          })}

          <Text style={ui.label}>COURSE / BATCH FOR ALL ROWS (OPTIONAL)</Text>
          <View style={ui.chips}>
            {courses.map((c) => (
              <Chip
                key={c.id}
                text={c.name}
                on={courseId === c.id}
                onPress={() => {
                  setCourseId(courseId === c.id ? null : c.id);
                  setBatchId(null);
                }}
              />
            ))}
          </View>
          {batches.length > 0 && (
            <View style={ui.chips}>
              {batches.map((b) => (
                <Chip
                  key={b.id}
                  text={b.name}
                  on={batchId === b.id}
                  onPress={() => setBatchId(batchId === b.id ? null : b.id)}
                />
              ))}
            </View>
          )}

          <Text style={ui.label}>PREVIEW</Text>
          {rows.slice(0, 3).map((r, idx) => (
            <Text key={idx} style={styles.preview} numberOfLines={2}>
              {[r.name, r.phone, r.session, r.workplace, r.district].filter(Boolean).join(' · ') || '(empty)'}
            </Text>
          ))}

          <View style={styles.switchRow}>
            <Text style={[styles.flex, styles.switchText]}>Fill in the ones already there (same phone)</Text>
            <Switch value={update} onValueChange={setUpdate} />
          </View>
          <Button
            title={`Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
            onPress={run}
            loading={busy}
            fullWidth
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : {}),
  },
  h: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  line: { fontSize: fontSize.small, color: colors.text },
  result: { borderColor: colors.success },
  mapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  mapField: { width: 130, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  mapCol: { flex: 1, fontSize: fontSize.small, color: colors.primary },
  mapNone: { color: colors.textMuted },
  mapPick: { paddingVertical: spacing.xs },
  preview: {
    fontSize: fontSize.small,
    color: colors.text,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  switchText: { color: colors.text, fontSize: fontSize.small },
});
