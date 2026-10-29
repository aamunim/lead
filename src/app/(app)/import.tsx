import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    canUndo,
    listImportBatches,
    runImport,
    shareImportErrors,
    undoImport,
    type AssignMode,
    type DuplicateMode,
    type ImportBatch,
    type ImportSummary,
} from '@/features/import-export/api';
import {
    autoMapColumns,
    buildImportRows,
    IMPORT_FIELDS,
    pickSpreadsheet,
    readSpreadsheet,
    shareImportTemplate,
    type ColumnMapping,
    type ImportFieldKey,
    type Spreadsheet,
} from '@/features/import-export/excel';
import { listAssignableUsers } from '@/features/leads/api';
import { listItems } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

type Step = 'pick' | 'map' | 'options' | 'running' | 'done';
type Option = { value: string; label: string };

const DUPLICATE_CHOICES: { value: DuplicateMode; label: string; hint: string }[] = [
  { value: 'skip', label: 'Skip', hint: 'Keep the existing lead, ignore the row' },
  { value: 'update', label: 'Update existing', hint: 'Fill empty details on the existing lead' },
  { value: 'create', label: 'Import anyway', hint: 'Create a separate lead' },
];

const ASSIGN_CHOICES: { value: AssignMode; label: string }[] = [
  { value: 'none', label: 'Leave unassigned' },
  { value: 'user', label: 'One person' },
  { value: 'round_robin', label: 'Share equally' },
];

export default function ImportScreen() {
  const { hasPermission } = useAuth();

  const [step, setStep] = useState<Step>('pick');
  const [fileName, setFileName] = useState('');
  const [sheet, setSheet] = useState<Spreadsheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});

  const [sources, setSources] = useState<Option[]>([]);
  const [users, setUsers] = useState<Option[]>([]);
  const [defaultSourceId, setDefaultSourceId] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>('skip');
  const [assignMode, setAssignMode] = useState<AssignMode>('none');
  const [assignUserId, setAssignUserId] = useState<string | null>(null);
  const [rrUserIds, setRrUserIds] = useState<string[]>([]);

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- options and history ------------------------------------------
  const loadHistory = useCallback(async () => {
    try {
      setHistory(await listImportBatches());
    } catch {
      // history is optional
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [src, ppl] = await Promise.all([listItems('lead_sources'), listAssignableUsers()]);
        setSources(src.map((s) => ({ value: s.id, label: s.name })));
        setUsers(ppl.map((p) => ({ value: p.id, label: p.full_name ?? 'No name' })));
        // "Old records" is a sensible default source for imports
        const old = src.find((s) => s.name.toLowerCase() === 'old records');
        if (old) setDefaultSourceId(old.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load options.');
      }
    })();
    loadHistory();
  }, [loadHistory]);

  // --- step 1: pick and read the file ---------------------------------
  const handlePick = async () => {
    setError(null);
    try {
      const picked = await pickSpreadsheet();
      if (!picked) return;
      setBusy(true);
      const data = await readSpreadsheet(picked.uri);
      setFileName(picked.name);
      setSheet(data);
      setMapping(autoMapColumns(data.headers));
      setStep('map');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this file.');
    } finally {
      setBusy(false);
    }
  };

  // --- step 2: mapping --------------------------------------------------
  const setColumn = (field: ImportFieldKey, column: number | null) => {
    setMapping((m) => {
      const next: ColumnMapping = { ...m };
      // A column can only belong to one field
      if (column != null) {
        for (const key of Object.keys(next) as ImportFieldKey[]) {
          if (next[key] === column) next[key] = null;
        }
      }
      next[field] = column;
      return next;
    });
  };

  // Name is always needed; then a phone, WhatsApp number or WhatsApp username column
  const missingRequired: { label: string }[] = IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] == null);
  if (mapping.phone == null && mapping.whatsapp_number == null && mapping.whatsapp_username == null) {
    missingRequired.push({ label: 'Phone (or WhatsApp number / username)' });
  }

  const preview = useMemo(() => {
    if (!sheet) return [];
    return buildImportRows({ headers: sheet.headers, rows: sheet.rows.slice(0, 3) }, mapping);
  }, [sheet, mapping]);

  // --- step 4: run ------------------------------------------------------
  const handleImport = async () => {
    if (!sheet) return;
    if (assignMode === 'user' && !assignUserId) {
      setError('Choose who gets the leads.');
      return;
    }
    if (assignMode === 'round_robin' && rrUserIds.length < 2) {
      setError('Choose at least two people to share the leads.');
      return;
    }

    setError(null);
    setStep('running');
    const rows = buildImportRows(sheet, mapping);
    setProgress({ done: 0, total: rows.length });

    try {
      const result = await runImport(
        rows,
        {
          fileName,
          defaultSourceId,
          duplicateMode,
          assignMode,
          assignUserId,
          roundRobinUserIds: rrUserIds,
        },
        (done, total) => setProgress({ done, total }),
      );
      setSummary(result);
      setStep('done');
      loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import stopped.');
      setStep('options');
      loadHistory();
    }
  };

  const confirmUndo = (batchId: string, label: string) => {
    Alert.alert('Undo this import?', `All new leads from “${label}” will be removed from the lists.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Undo import',
        style: 'destructive',
        onPress: async () => {
          try {
            const count = await undoImport(batchId);
            Alert.alert('Import undone', `${count} leads were removed.`);
            if (summary?.batchId === batchId) setSummary(null);
            loadHistory();
          } catch (e) {
            Alert.alert('Could not undo', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  const reset = () => {
    setStep('pick');
    setSheet(null);
    setMapping({});
    setSummary(null);
    setError(null);
  };

  if (!hasPermission('import.run')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Import leads' }} />
        <Text style={styles.title}>No access</Text>
        <Text style={styles.muted}>Only admins can import leads.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Import leads' }} />

      <StepBar step={step} />

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* ---------- 1. Pick ---------- */}
      {step === 'pick' && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Choose a file</Text>
            <Text style={styles.muted}>
              Excel (.xlsx, .xls) or CSV. The first row must contain the column names, e.g. Name, Phone,
              Course.
            </Text>
            <Button title="Choose file" onPress={handlePick} loading={busy} fullWidth />
            <Button title="Download a template" variant="ghost" onPress={() => shareImportTemplate().catch(() => {})} />
          </View>

          {history.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.title}>Recent imports</Text>
              {history.map((b) => (
                <View key={b.id} style={styles.historyRow}>
                  <View style={styles.flex}>
                    <Text style={styles.historyName} numberOfLines={1}>
                      {b.file_name ?? 'Import'}
                    </Text>
                    <Text style={styles.muted}>
                      {new Date(b.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                      {' · '}
                      {b.created} new · {b.updated} updated · {b.skipped} skipped · {b.failed} errors
                      {b.undone_at ? ' · undone' : ''}
                    </Text>
                  </View>
                  {canUndo(b) && (
                    <Button
                      title="Undo"
                      variant="ghost"
                      onPress={() => confirmUndo(b.id, b.file_name ?? 'this import')}
                    />
                  )}
                </View>
              ))}
            </View>
          )}
        </>
      )}

      {/* ---------- 2. Map ---------- */}
      {step === 'map' && sheet && (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>{fileName}</Text>
            <Text style={styles.muted}>
              {sheet.rows.length} rows found. Check which column holds each detail. We matched what we could.
            </Text>
          </View>

          {IMPORT_FIELDS.map((field) => (
            <View key={field.key} style={styles.card}>
              <Text style={styles.fieldLabel}>
                {field.label}
                {field.required && <Text style={styles.required}> *</Text>}
              </Text>
              <Chips
                options={[
                  { value: '-1', label: 'Not in file' },
                  ...sheet.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
                ]}
                selected={[String(mapping[field.key] ?? -1)]}
                onPress={(v) => setColumn(field.key, v === '-1' ? null : Number(v))}
              />
            </View>
          ))}

          {/* Preview */}
          <View style={styles.card}>
            <Text style={styles.title}>Preview</Text>
            {preview.map((r) => (
              <Text key={r.row} style={styles.previewRow}>
                Row {r.row}: {r.name || '—'} ·{' '}
                {r.phone || r.whatsapp_number || (r.whatsapp_username ? `@${r.whatsapp_username.replace(/^@+/, '')}` : '—')}
                {r.course ? ` · ${r.course}` : ''}
              </Text>
            ))}
          </View>

          {missingRequired.length > 0 && (
            <Text style={styles.warning}>Choose a column for: {missingRequired.map((f) => f.label).join(', ')}</Text>
          )}

          <Button
            title="Next"
            onPress={() => setStep('options')}
            disabled={missingRequired.length > 0}
            fullWidth
          />
          <Button title="Choose another file" variant="ghost" onPress={reset} />
        </>
      )}

      {/* ---------- 3. Options ---------- */}
      {step === 'options' && sheet && (
        <>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Source for rows without one</Text>
            <Chips
              options={[{ value: '__none__', label: 'None' }, ...sources]}
              selected={[defaultSourceId ?? '__none__']}
              onPress={(v) => setDefaultSourceId(v === '__none__' ? null : v)}
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.fieldLabel}>If the phone number (or WhatsApp) already exists</Text>
            {DUPLICATE_CHOICES.map((c) => (
              <Radio
                key={c.value}
                label={c.label}
                hint={c.hint}
                selected={duplicateMode === c.value}
                onPress={() => setDuplicateMode(c.value)}
              />
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Assign new leads to</Text>
            <Chips
              options={ASSIGN_CHOICES}
              selected={[assignMode]}
              onPress={(v) => setAssignMode(v as AssignMode)}
            />
            {assignMode === 'user' && (
              <Chips
                options={users}
                selected={assignUserId ? [assignUserId] : []}
                onPress={(v) => setAssignUserId(v)}
              />
            )}
            {assignMode === 'round_robin' && (
              <>
                <Text style={styles.muted}>Choose the people to share leads between, one by one in turn.</Text>
                <Chips
                  options={users}
                  selected={rrUserIds}
                  onPress={(v) =>
                    setRrUserIds((list) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]))
                  }
                />
              </>
            )}
          </View>

          <Button title={`Import ${sheet.rows.length} rows`} onPress={handleImport} fullWidth />
          <Button title="Back" variant="ghost" onPress={() => setStep('map')} />
        </>
      )}

      {/* ---------- Running ---------- */}
      {step === 'running' && (
        <View style={[styles.card, styles.centerCard]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.title}>Importing…</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` },
              ]}
            />
          </View>
          <Text style={styles.muted}>
            {progress.done} of {progress.total} rows. Please keep the app open.
          </Text>
        </View>
      )}

      {/* ---------- Done ---------- */}
      {step === 'done' && summary && (
        <>
          <View style={styles.stats}>
            <Stat label="New leads" value={summary.created} color={colors.success} />
            <Stat label="Updated" value={summary.updated} color={colors.info} />
            <Stat label="Skipped" value={summary.skipped} color={colors.textMuted} />
            <Stat label="Errors" value={summary.errors.length} color={colors.danger} />
          </View>

          {summary.errors.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.title}>Rows with problems</Text>
              {summary.errors.slice(0, 10).map((e) => (
                <Text key={`${e.row}-${e.reason}`} style={styles.errorRow}>
                  Row {e.row}: {e.reason}
                </Text>
              ))}
              {summary.errors.length > 10 && (
                <Text style={styles.muted}>…and {summary.errors.length - 10} more</Text>
              )}
              <Button
                title="Download error rows"
                variant="secondary"
                onPress={() => shareImportErrors(summary.errors).catch(() => {})}
              />
            </View>
          )}

          <Button title="Go to leads" onPress={() => router.replace('/leads' as Href)} fullWidth />
          <Button title="Import another file" variant="secondary" onPress={reset} fullWidth />
          {summary.batchId && summary.created > 0 && (
            <Button
              title="Undo this import"
              variant="ghost"
              onPress={() => confirmUndo(summary.batchId as string, fileName)}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}

// =====================================================================
// Small building blocks
// =====================================================================
function StepBar({ step }: { step: Step }) {
  const steps: { key: Step[]; label: string }[] = [
    { key: ['pick'], label: 'File' },
    { key: ['map'], label: 'Columns' },
    { key: ['options'], label: 'Settings' },
    { key: ['running', 'done'], label: 'Result' },
  ];
  const current = steps.findIndex((s) => s.key.includes(step));
  return (
    <View style={styles.stepBar}>
      {steps.map((s, i) => (
        <View key={s.label} style={styles.stepItem}>
          <View style={[styles.stepDot, i <= current && styles.stepDotOn]}>
            <Text style={[styles.stepNum, i <= current && styles.stepNumOn]}>{i + 1}</Text>
          </View>
          <Text style={[styles.stepLabel, i === current && styles.stepLabelOn]}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

function Chips({
  options,
  selected,
  onPress,
}: {
  options: Option[];
  selected: string[];
  onPress: (value: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <Pressable
            key={o.value}
            onPress={() => onPress(o.value)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Radio({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.radio, selected && styles.radioOn]}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <View style={[styles.radioDot, selected && styles.radioDotOn]} />
      <View style={styles.flex}>
        <Text style={styles.radioLabel}>{label}</Text>
        <Text style={styles.muted}>{hint}</Text>
      </View>
    </Pressable>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  flex: { flex: 1 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  centerCard: { alignItems: 'center' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.caption, color: colors.textMuted },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  required: { color: colors.danger },
  warning: { fontSize: fontSize.small, color: colors.warning, textAlign: 'center' },
  previewRow: { fontSize: fontSize.small, color: colors.text },
  stepBar: { flexDirection: 'row', justifyContent: 'space-between' },
  stepItem: { alignItems: 'center', gap: 4, flex: 1 },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  stepDotOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  stepNum: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  stepNumOn: { color: colors.textOnPrimary },
  stepLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  stepLabelOn: { color: colors.primary, fontWeight: fontWeight.bold },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    maxWidth: '100%',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  radio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  radioOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  radioDot: { width: 18, height: 18, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.border },
  radioDotOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  radioLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  progressTrack: { alignSelf: 'stretch', height: 10, borderRadius: radius.pill, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.primary },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statValue: { fontSize: fontSize.heading, fontWeight: fontWeight.bold },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  historyName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  errorRow: { fontSize: fontSize.small, color: colors.danger },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});