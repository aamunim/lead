import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  bulkPlacementPreview,
  bulkSetPlacement,
  getPlacementOptions,
  type BulkPlacementPreview,
  type PlacementOptions,
} from '@/features/approval/api';
import { money } from '@/features/fees/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🔀 Students tab → mark → Course · Batch · Section: many students to one
//   place at once. Each move is the same as "Change" on one student (new
//   fee for a new course, a new ID by the rule); all of them move, or none.
// =====================================================================

type Student = {
  id: string;
  courseId: string | null;
  batchId: string | null;
  sectionId: string | null;
  place: string;
};

export function BulkPlacementSheet({
  students,
  onClose,
  onDone,
}: {
  students: Student[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [opts, setOpts] = useState<PlacementOptions | null>(null);
  // start from where most of them are now
  const common = (k: 'courseId' | 'batchId') => {
    const v = students[0]?.[k] ?? null;
    return students.every((s) => s[k] === v) ? v : null;
  };
  const [courseId, setCourseId] = useState<string | null>(common('courseId'));
  const [batchId, setBatchId] = useState<string | null>(common('batchId'));
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkPlacementPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPlacementOptions()
      .then(setOpts)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, []);

  const batches = useMemo(() => (opts?.batches ?? []).filter((b) => b.course_id === courseId), [opts, courseId]);
  const sections = useMemo(() => (opts?.sections ?? []).filter((s) => s.batch_id === batchId), [opts, batchId]);
  const ids = useMemo(() => students.map((s) => s.id), [students]);

  // where they are now: "B.Ed · Jan 2027 · A (9) · B (3)"
  const now = useMemo(() => {
    const m = new Map<string, number>();
    students.forEach((s) => m.set(s.place || 'No place yet', (m.get(s.place || 'No place yet') ?? 0) + 1));
    return [...m.entries()].map(([k, v]) => `${k} (${v})`).join(' · ');
  }, [students]);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!courseId || !batchId || !sectionId) return;
    let live = true;
    setChecking(true);
    bulkPlacementPreview(ids, { courseId, batchId, sectionId })
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not check.'))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [ids, courseId, batchId, sectionId]);

  const move = async () => {
    if (!courseId || !batchId || !sectionId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await bulkSetPlacement(ids, { courseId, batchId, sectionId });
      onDone(`🔀 ${r.moved} ${r.moved === 1 ? 'student' : 'students'} moved to ${r.place}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move them.');
    } finally {
      setSaving(false);
    }
  };

  const canMove = !!preview && preview.moving > 0 && preview.problems.length === 0;
  const idLine = (() => {
    const r = preview?.id_rule;
    if (!preview || preview.moving === 0) return null;
    if (r?.kind === 'range')
      return `🎓 New IDs from ${r.start} – ${r.end} (${r.free ?? 0} free, ${preview.moving} needed)`;
    if (r?.kind === 'pattern') return `🎓 New IDs by ${r.pattern}`;
    return '🎓 New IDs by the default pattern';
  })();

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>
              🔀 Move {students.length} {students.length === 1 ? 'student' : 'students'}
            </Text>
            <Text style={styles.small}>Now: {now}</Text>

            {!opts ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                <Text style={styles.label}>COURSE</Text>
                <Chips
                  items={opts.courses.map((c) => ({ id: c.id, name: c.name }))}
                  value={courseId}
                  onPick={(v) => {
                    setCourseId(v);
                    setBatchId(null);
                    setSectionId(null);
                  }}
                />
                {courseId && (
                  <>
                    <Text style={styles.label}>BATCH</Text>
                    {batches.length === 0 ? (
                      <Text style={styles.small}>No batches in this course.</Text>
                    ) : (
                      <Chips
                        items={batches.map((b) => ({ id: b.id, name: b.name }))}
                        value={batchId}
                        onPick={(v) => {
                          setBatchId(v);
                          setSectionId(null);
                        }}
                      />
                    )}
                  </>
                )}
                {batchId && (
                  <>
                    <Text style={styles.label}>SECTION</Text>
                    {sections.length === 0 ? (
                      <Text style={styles.small}>This batch has no sections yet (Settings → Courses).</Text>
                    ) : (
                      <Chips
                        items={sections.map((s) => ({ id: s.id, name: `Section ${s.name}` }))}
                        value={sectionId}
                        onPick={setSectionId}
                      />
                    )}
                  </>
                )}
              </>
            )}

            {checking && <ActivityIndicator color={colors.primary} />}
            {preview && (
              <View style={styles.box}>
                <Text style={styles.boxTitle}>What will happen</Text>
                {preview.moving > 0 ? (
                  <Text style={styles.line}>
                    ✅ {preview.moving} → {preview.place}
                  </Text>
                ) : (
                  <Text style={styles.line}>Nobody to move: they are all there already.</Text>
                )}
                {preview.already_there > 0 && (
                  <Text style={styles.line}>⏭ {preview.already_there} already there (left as they are)</Text>
                )}
                {preview.skipped > 0 && (
                  <Text style={styles.line}>⏭ {preview.skipped} not admitted or cancelled (left out)</Text>
                )}
                {preview.seats.capacity != null && preview.seats.need > 0 && (
                  <Text style={styles.line}>
                    🪑 Seats free in the batch: {Math.max(preview.seats.capacity - preview.seats.taken, 0)}, needed{' '}
                    {preview.seats.need} {preview.seats.ok ? '✓' : ''}
                  </Text>
                )}
                {!!idLine && <Text style={styles.line}>{idLine}</Text>}
                {preview.course_change > 0 ? (
                  <Text style={styles.line}>
                    💰 {preview.course_change} change course: their fee becomes the new course’s
                    {preview.course_fee != null ? ` (${money(preview.course_fee)})` : ''}, or a fee talked for it
                  </Text>
                ) : preview.moving > 0 ? (
                  <Text style={styles.line}>💰 Same course: fees stay as they are</Text>
                ) : null}
                {preview.overpaid > 0 && (
                  <Text style={styles.warn}>⚠️ {preview.overpaid} paid more than the new course’s fee</Text>
                )}
                {preview.problems.map((p) => (
                  <Text key={p} style={styles.problem}>
                    ⛔ {p}
                  </Text>
                ))}
                {preview.problems.length > 0 && (
                  <Text style={styles.small}>Nobody moves until this is fixed (all of them, or none).</Text>
                )}
              </View>
            )}

            {error && <Text style={styles.problem}>{error}</Text>}
            <Button
              title={preview && preview.moving > 0 ? `Move ${preview.moving}` : 'Move'}
              onPress={move}
              loading={saving}
              disabled={!canMove}
              fullWidth
            />
            <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Chips({
  items,
  value,
  onPick,
}: {
  items: { id: string; name: string }[];
  value: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {items.map((i) => {
        const on = i.id === value;
        return (
          <Pressable
            key={i.id}
            onPress={() => onPick(i.id)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{i.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  small: { fontSize: fontSize.caption, color: colors.textMuted, lineHeight: 18 },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  box: {
    gap: 4,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  boxTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  line: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  warn: { fontSize: fontSize.small, color: colors.warning, fontWeight: fontWeight.semibold },
  problem: { fontSize: fontSize.small, color: colors.danger, fontWeight: fontWeight.semibold },
});
