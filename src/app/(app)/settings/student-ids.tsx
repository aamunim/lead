import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  fillSectionRanges,
  formatStudentRef,
  getAdmissionSettings,
  getIdRulesData,
  renumberStudentRefs,
  saveIdRule,
  type IdRule,
  type IdRuleLevel,
  type IdRulesData,
} from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// ⚙️ Settings → Student ID rules
//   Course → batch → section: each can have its own rule, or use the one
//   above. A rule is a 🔤 pattern ({YY}{000} …) or a 🔢 range
//   (27001 – 27110). The most exact rule gives the ID.
// =====================================================================

type Target = {
  level: IdRuleLevel;
  id: string;
  title: string;
  above: string;
  suggest?: { start: number; end: number };
};

const ruleText = (r: IdRule | undefined) =>
  !r ? null : r.kind === 'range' ? `🔢 ${r.start} – ${r.end}` : `🔤 ${r.pattern ?? ''}`;

export default function StudentIdRulesScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const [data, setData] = useState<IdRulesData | null>(null);
  const [defaultPattern, setDefaultPattern] = useState('{YY}{000}');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [edit, setEdit] = useState<Target | null>(null);
  const [fill, setFill] = useState<{ batchId: string; name: string; sections: number; seats: number | null } | null>(
    null,
  );
  const [renumbering, setRenumbering] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([getIdRulesData(), getAdmissionSettings()]);
      setData(d);
      setDefaultPattern(s.student_id.pattern);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!canManage)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Student ID rules' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  if (!data)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Student ID rules' }} />
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} size="large" />}
      </View>
    );

  const ruleOf = (level: IdRuleLevel, id: string) =>
    data.rules.find((r) =>
      level === 'course' ? r.courseId === id : level === 'batch' ? r.batchId === id : r.sectionId === id,
    );

  // ⚠️ two ranges can't share numbers (the database stops it); here: ranges filling up
  const nearlyFull = data.rules.filter(
    (r) => r.kind === 'range' && r.start != null && r.end != null && (r.used ?? 0) >= 0.9 * (r.end - r.start + 1),
  );

  const renumber = async () => {
    setRenumbering(true);
    try {
      const p = await renumberStudentRefs(false);
      if (p.full && p.full.length > 0) {
        Alert.alert('Some ranges are too small', `Make these bigger first:\n${p.full.join('\n')}`);
        return;
      }
      if (p.changed === 0) {
        Alert.alert('Nothing to change', `All ${p.students} students already have IDs by these rules.`);
        return;
      }
      const ex = p.examples.map((e) => `${e.old ?? '—'} → ${e.new}`).join('\n');
      Alert.alert(
        `Change ${p.changed} of ${p.students} student IDs?`,
        `Oldest admission first, by each student's course, batch and section:\n${ex}${p.changed > p.examples.length ? '\n…' : ''}\n\nThe old ID of each is kept in its change log.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Change IDs',
            style: 'destructive',
            onPress: async () => {
              setRenumbering(true);
              try {
                const done = await renumberStudentRefs(true);
                Alert.alert('✅ Done', `${done.changed} student IDs changed.`);
                load();
              } catch (e) {
                Alert.alert('Could not change', e instanceof Error ? e.message : '');
              } finally {
                setRenumbering(false);
              }
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert('Could not check', e instanceof Error ? e.message : '');
    } finally {
      setRenumbering(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen options={{ title: 'Student ID rules' }} />
      <Text style={styles.intro}>
        Each course, batch and section can have its own rule. The most exact one gives the ID: section → batch → course
        → the default. A full range stops the admission until it is made bigger.
      </Text>

      <Pressable
        onPress={() => router.push('/settings/admission' as Href)}
        style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <View style={styles.flex}>
          <Text style={styles.title}>Default for everything else</Text>
          <Text style={styles.small}>
            🔤 {defaultPattern} · e.g. {formatStudentRef(defaultPattern, 1)} (Settings → Admission)
          </Text>
        </View>
        <Text style={styles.chev}>›</Text>
      </Pressable>

      {nearlyFull.length > 0 && (
        <View style={styles.warnBox}>
          <Text style={styles.warnTitle}>⚠️ Ranges almost full</Text>
          {nearlyFull.map((r) => (
            <Text key={r.id} style={styles.warnText}>
              • {r.label}: {r.used} of {(r.end ?? 0) - (r.start ?? 0) + 1} used
            </Text>
          ))}
        </View>
      )}

      {data.courses.map((c) => {
        const cr = ruleOf('course', c.id);
        const batches = data.batches.filter((b) => b.courseId === c.id);
        return (
          <View key={c.id} style={styles.card}>
            <RuleRow
              icon="📘"
              title={`${c.name}${c.code ? ` (${c.code})` : ''}`}
              rule={cr}
              inherit="Default"
              onPress={() => setEdit({ level: 'course', id: c.id, title: c.name, above: 'the default' })}
              big
            />
            {batches.map((b) => {
              const br = ruleOf('batch', b.id);
              const secs = data.sections.filter((s) => s.batchId === b.id);
              const year = b.startDate ? b.startDate.slice(0, 4) : null;
              return (
                <View key={b.id} style={styles.batch}>
                  <RuleRow
                    icon="🗓"
                    title={`${b.name}${year ? ` · starts ${year}` : ''}`}
                    rule={br}
                    inherit={cr ? 'Course rule' : 'Default'}
                    onPress={() =>
                      setEdit({ level: 'batch', id: b.id, title: `${c.name} · ${b.name}`, above: 'the course rule' })
                    }
                  />
                  {secs.map((s) => {
                    const sr = ruleOf('section', s.id);
                    const size =
                      sr?.kind === 'range' && sr.start != null && sr.end != null ? sr.end - sr.start + 1 : null;
                    return (
                      <View key={s.id} style={styles.section}>
                        <RuleRow
                          icon="🏫"
                          title={`Section ${s.name}`}
                          rule={sr}
                          inherit={br ? 'Batch rule' : cr ? 'Course rule' : 'Default'}
                          extra={size != null ? `${sr?.used ?? 0} used · ${size - (sr?.used ?? 0)} left` : undefined}
                          onPress={() =>
                            setEdit({
                              level: 'section',
                              id: s.id,
                              title: `${c.name} · ${b.name} · Section ${s.name}`,
                              above: 'the batch rule',
                            })
                          }
                        />
                      </View>
                    );
                  })}
                  {secs.length > 0 && (
                    <Pressable
                      onPress={() =>
                        setFill({ batchId: b.id, name: `${c.name} · ${b.name}`, sections: secs.length, seats: b.seats })
                      }
                      style={styles.fillBtn}
                      accessibilityRole="button"
                    >
                      <Text style={styles.link}>🔢 Give the {secs.length} sections ranges one after the other</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
            {batches.length === 0 && <Text style={styles.small}>No batches yet.</Text>}
          </View>
        );
      })}

      <Button
        title="🔁 Give every student an ID by these rules"
        variant="secondary"
        onPress={renumber}
        loading={renumbering}
        fullWidth
      />
      <Text style={styles.small}>
        Moving a student to another section, batch or course gives a new ID by its rule; the old one stays in the change
        log.
      </Text>

      {edit && (
        <RuleSheet
          target={edit}
          rule={ruleOf(edit.level, edit.id)}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
      {fill && (
        <FillSheet
          {...fill}
          onClose={() => setFill(null)}
          onSaved={() => {
            setFill(null);
            load();
          }}
        />
      )}
    </KeyboardAwareScrollView>
  );
}

function RuleRow({
  icon,
  title,
  rule,
  inherit,
  extra,
  onPress,
  big,
}: {
  icon: string;
  title: string;
  rule: IdRule | undefined;
  inherit: string;
  extra?: string;
  onPress: () => void;
  big?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Text style={styles.icon}>{icon}</Text>
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, big && styles.rowTitleBig]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.small, !!rule && styles.ruleOn]}>
          {ruleText(rule) ?? `↳ ${inherit}`}
          {extra ? `   ${extra}` : ''}
        </Text>
      </View>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );
}

function RuleSheet({
  target,
  rule,
  onClose,
  onSaved,
}: {
  target: Target;
  rule: IdRule | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<'inherit' | 'pattern' | 'range'>(rule?.kind ?? 'inherit');
  const [pattern, setPattern] = useState(rule?.pattern ?? '{YY}{000}');
  const [start, setStart] = useState(rule?.start != null ? String(rule.start) : '');
  const [end, setEnd] = useState(rule?.end != null ? String(rule.end) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveIdRule(target.level, target.id, kind, {
        pattern: pattern.trim(),
        start: Number(start) || undefined,
        end: Number(end) || undefined,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const size = Number(end) - Number(start) + 1;
  return (
    <Modal keyboard visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Student ID rule</Text>
          <Text style={styles.small}>{target.title}</Text>
          <View style={styles.chips}>
            {(
              [
                ['inherit', `↳ Use ${target.above}`],
                ['range', '🔢 Range'],
                ['pattern', '🔤 Pattern'],
              ] as const
            ).map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                style={[styles.chip, kind === k && styles.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ checked: kind === k }}
              >
                <Text style={[styles.chipText, kind === k && styles.chipTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {kind === 'range' && (
            <>
              <View style={styles.rangeRow}>
                <TextInput
                  value={start}
                  onChangeText={(t) => setStart(t.replace(/[^0-9]/g, ''))}
                  placeholder="27001"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="number-pad"
                  style={[styles.input, styles.flex]}
                  accessibilityLabel="First number"
                />
                <Text style={styles.dash}>–</Text>
                <TextInput
                  value={end}
                  onChangeText={(t) => setEnd(t.replace(/[^0-9]/g, ''))}
                  placeholder="27110"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="number-pad"
                  style={[styles.input, styles.flex]}
                  accessibilityLabel="Last number"
                />
              </View>
              <Text style={styles.small}>
                {size > 0 ? `${size} IDs. ` : ''}The next free number in it is given. When all are used, admitting stops
                until the range is made bigger.
              </Text>
            </>
          )}
          {kind === 'pattern' && (
            <>
              <TextInput
                value={pattern}
                onChangeText={setPattern}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.input}
                accessibilityLabel="Pattern"
              />
              <Text style={styles.small}>
                e.g. {formatStudentRef(pattern, 1)} · {'{YY}'} {'{YYYY}'} {'{SESSION}'} {'{CODE}'} {'{000}'}. This
                pattern counts on its own.
              </Text>
            </>
          )}
          {kind === 'inherit' && <Text style={styles.small}>No rule of its own: {target.above} gives the ID.</Text>}

          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="Save" onPress={save} loading={saving} fullWidth />
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
      </View>
    </Modal>
  );
}

function FillSheet({
  batchId,
  name,
  sections,
  seats,
  onClose,
  onSaved,
}: {
  batchId: string;
  name: string;
  sections: number;
  seats: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [start, setStart] = useState('');
  const [per, setPer] = useState(String(seats ? Math.ceil(seats / sections) : 100));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = Number(start);
  const n = Number(per);
  const preview =
    s > 0 && n > 0
      ? Array.from({ length: Math.min(sections, 4) }, (_, i) => `${s + i * n}–${s + (i + 1) * n - 1}`).join(' · ') +
        (sections > 4 ? ' …' : '')
      : '';

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await fillSectionRanges(batchId, s, n);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal keyboard visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>🔢 Ranges for the sections</Text>
          <Text style={styles.small}>
            {name} · {sections} sections{seats ? ` · ${seats} seats` : ''}
          </Text>
          <Text style={styles.label}>First number</Text>
          <TextInput
            value={start}
            onChangeText={(t) => setStart(t.replace(/[^0-9]/g, ''))}
            placeholder="27001"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            style={styles.input}
          />
          <Text style={styles.label}>IDs in each section</Text>
          <TextInput
            value={per}
            onChangeText={(t) => setPer(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            style={styles.input}
          />
          {!!preview && <Text style={styles.preview}>{preview}</Text>}
          {seats != null && n * sections < seats && (
            <Text style={styles.warnText}>
              ⚠️ {n * sections} IDs for {seats} seats: some students would get none.
            </Text>
          )}
          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="Save the ranges" onPress={save} loading={saving} disabled={!(s > 0 && n > 0)} fullWidth />
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  flex: { flex: 1 },
  intro: { fontSize: fontSize.small, color: colors.textMuted, lineHeight: 20 },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: fontSize.small, color: colors.danger },
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 4 },
  pressed: { opacity: 0.7 },
  icon: { fontSize: 18, width: 24, textAlign: 'center' },
  rowTitle: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleBig: { fontSize: fontSize.body, fontWeight: fontWeight.bold },
  ruleOn: { color: colors.primary, fontWeight: fontWeight.semibold },
  chev: { fontSize: 20, color: colors.textMuted },
  batch: {
    marginLeft: spacing.md,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    gap: 2,
  },
  section: { marginLeft: spacing.lg },
  fillBtn: { marginLeft: spacing.lg, paddingVertical: 6 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  warnBox: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.warningSoft },
  warnTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.warning },
  warnText: { fontSize: fontSize.caption, color: colors.warning, lineHeight: 18 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    gap: spacing.md,
    padding: spacing.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
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
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dash: { fontSize: fontSize.title, color: colors.textMuted },
  input: {
    height: 46,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
  },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  preview: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
});
