import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

import { getLeadReferrer, searchAlumni, setLeadReferrer } from './api';
import { alumniChanged, s as ui, useAlumniAccess, useAlumniVersion } from './ui';

// =====================================================================
// 🎓 On the lead page: the alumnus who referred this lead (tap to open),
//   and a picker to set / change / clear it
// =====================================================================

export function LeadReferrer({ leadId }: { leadId: string }) {
  const access = useAlumniAccess();
  const version = useAlumniVersion();
  const [ref, setRef] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!access.view) return;
    getLeadReferrer(leadId)
      .then(setRef)
      .catch(() => setRef(null));
  }, [leadId, access.view, version]);

  if (!access.view || ref === undefined) return null;

  return (
    <View style={styles.row}>
      <Text style={styles.label}>Alumni referral</Text>
      <View style={styles.valueRow}>
        {ref ? (
          <Pressable
            onPress={() => router.push(`/alumni/${ref.id}` as Href)}
            style={styles.flex}
            accessibilityRole="link"
          >
            <Text style={styles.link} numberOfLines={1}>
              🎓 {ref.name} ›
            </Text>
          </Pressable>
        ) : (
          <Text style={[styles.flex, ui.muted]}>—</Text>
        )}
        <Pressable onPress={() => setPicking(true)} hitSlop={8} accessibilityRole="button">
          <Text style={styles.change}>{ref ? 'Change' : '＋ Alumnus'}</Text>
        </Pressable>
      </View>
      {picking && (
        <PickAlumnus
          current={ref}
          onClose={() => setPicking(false)}
          onPick={async (id) => {
            await setLeadReferrer(leadId, id);
            alumniChanged();
            setPicking(false);
          }}
        />
      )}
    </View>
  );
}

function PickAlumnus({
  current,
  onClose,
  onPick,
}: {
  current: { id: string; name: string } | null;
  onClose: () => void;
  onPick: (id: string | null) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Awaited<ReturnType<typeof searchAlumni>>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(
      () =>
        searchAlumni(q)
          .then(setRows)
          .catch((e) => setError(e instanceof Error ? e.message : 'Could not search.'))
          .finally(() => setLoading(false)),
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [q]);

  const pick = async (id: string | null) => {
    setError(null);
    try {
      await onPick(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  return (
    <Modal visible transparent keyboard animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <Text style={styles.title}>🎓 Who referred this lead?</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search alumni: name, phone, school"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoFocus
          accessibilityLabel="Search alumni"
        />
        {error && <Text style={ui.error}>{error}</Text>}
        {loading && <ActivityIndicator color={colors.primary} />}
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          renderItem={({ item }) => (
            <Pressable onPress={() => pick(item.id)} style={styles.item} accessibilityRole="button">
              <Text style={styles.name}>
                {item.name}
                {current?.id === item.id ? '  ✓' : ''}
              </Text>
              <Text style={ui.muted} numberOfLines={1}>
                {[item.phone, item.batch_name, item.workplace].filter(Boolean).join(' · ')}
              </Text>
            </Pressable>
          )}
          ListEmptyComponent={loading ? undefined : <Text style={ui.muted}>Nobody found.</Text>}
        />
        {current && <Button title="Remove the alumnus" variant="ghost" onPress={() => pick(null)} fullWidth />}
        <Button title="Close" variant="secondary" onPress={onClose} fullWidth />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: spacing.sm },
  label: { width: 120, fontSize: fontSize.small, color: colors.textMuted },
  valueRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  change: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '85%',
    gap: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    ...(Platform.OS === 'web' ? { width: '100%', maxWidth: 560, alignSelf: 'center' } : {}),
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  list: { maxHeight: 360 },
  item: { paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
});
