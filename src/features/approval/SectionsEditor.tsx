import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { addSection, listSections, updateSection, type BatchSection } from '@/features/approval/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🏫 Sections of a batch (Settings → Courses → a batch)
//   The Admission Officer picks one when approving an admission.
//   A section in use is switched off, not removed.
// =====================================================================

export function SectionsEditor({ batchId }: { batchId: string }) {
  const [items, setItems] = useState<BatchSection[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listSections(batchId)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the sections.'));
  }, [batchId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      await addSection(batchId, n, (items?.length ?? 0) + 1);
      setName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: BatchSection) => {
    setError(null);
    try {
      await updateSection(s.id, { is_active: !s.is_active });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change it.');
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title}>🏫 Sections</Text>
      <Text style={styles.hint}>The Admission Officer chooses one when approving an admission (e.g. A, B, C).</Text>
      {items === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : items.length === 0 ? (
        <Text style={styles.hint}>No sections yet.</Text>
      ) : (
        items.map((s) => (
          <View key={s.id} style={styles.row}>
            <Text style={[styles.name, !s.is_active && styles.off]}>Section {s.name}</Text>
            <Switch
              value={s.is_active}
              onValueChange={() => toggle(s)}
              trackColor={{ true: colors.primary, false: colors.border }}
              accessibilityLabel={`Section ${s.name} in use`}
            />
          </View>
        ))
      )}
      <View style={styles.addRow}>
        <TextInput
          value={name}
          onChangeText={setName}
          onSubmitEditing={add}
          placeholder="New section, e.g. A"
          placeholderTextColor={colors.textMuted}
          maxLength={40}
          style={styles.input}
        />
        <Pressable onPress={busy ? undefined : add} style={styles.addBtn} accessibilityRole="button">
          <Text style={styles.addText}>{busy ? '…' : '＋ Add'}</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  off: { color: colors.textMuted, textDecorationLine: 'line-through' },
  addRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    flex: 1,
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: fontSize.small,
  },
  addBtn: {
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    justifyContent: 'center',
  },
  addText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  error: { fontSize: fontSize.small, color: colors.danger },
});
