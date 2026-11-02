import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { copyLabel, getLeadPapers, type LeadPapers } from '@/features/papers/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐📄 A student's papers at a glance (from the Students table):
//   what is in, what is missing, originals, where the file is kept.
// =====================================================================

export function PapersPopup({
  leadId,
  name,
  onClose,
  onOpen,
}: {
  leadId: string;
  name: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  const [data, setData] = useState<LeadPapers | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLeadPapers(leadId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the papers.'));
  }, [leadId]);

  const list = data?.papers.filter((p) => p.isRequired || p.status !== null) ?? [];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.back} onPress={onClose} accessibilityLabel="Close papers">
        <Pressable style={styles.box} onPress={() => undefined}>
          <Text style={styles.title}>📄 Papers</Text>
          <Text style={styles.sub}>{name}</Text>

          {!data ? (
            error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            )
          ) : (
            <>
              <View style={styles.summary}>
                <Text style={[styles.big, data.done < data.required ? styles.warn : styles.good]}>
                  {data.required ? `${data.done}/${data.required}` : '—'}
                </Text>
                <Text style={styles.muted}>
                  {data.required === 0
                    ? 'No papers are needed for this course.'
                    : data.done < data.required
                      ? `${data.required - data.done} required paper${data.required - data.done > 1 ? 's' : ''} missing`
                      : 'All required papers are in'}
                  {data.originalsHeld ? ` · ${data.originalsHeld} original${data.originalsHeld > 1 ? 's' : ''} with us` : ''}
                </Text>
              </View>
              {!!data.folder && <Text style={styles.muted}>📁 File kept at: {data.folder}</Text>}

              <ScrollView style={styles.list}>
                {list.map((p) => {
                  const icon = p.status === 'received' ? '✅' : p.status === 'not_needed' ? '➖' : '⚠️';
                  const bits = [
                    p.status === 'not_needed' ? 'Not needed' : copyLabel(p.copyType),
                    p.returnedAt ? 'Returned' : null,
                    p.keptAt ? `at ${p.keptAt}` : null,
                    !p.isRequired ? 'optional' : null,
                  ].filter(Boolean);
                  return (
                    <View key={p.paperId} style={styles.row}>
                      <Text style={styles.icon}>{icon}</Text>
                      <View style={styles.flex}>
                        <Text style={[styles.name, p.status === null && styles.missing]}>{p.name}</Text>
                        {bits.length > 0 && <Text style={styles.muted}>{bits.join(' · ')}</Text>}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </>
          )}

          <View style={styles.buttons}>
            <Pressable onPress={onClose} style={styles.ghost} accessibilityRole="button">
              <Text style={styles.ghostText}>Close</Text>
            </Pressable>
            <Pressable onPress={onOpen} style={styles.btn} accessibilityRole="button">
              <Text style={styles.btnText}>Open student</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  back: { flex: 1, backgroundColor: 'rgba(16,26,51,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  box: { width: '100%', maxWidth: 480, maxHeight: '85%', gap: spacing.sm, padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.surface },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted, marginTop: -4 },
  loader: { marginVertical: spacing.xl },
  summary: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
  big: { fontSize: fontSize.heading, fontWeight: fontWeight.bold },
  good: { color: colors.success },
  warn: { color: colors.warning },
  muted: { flexShrink: 1, fontSize: fontSize.caption, color: colors.textMuted },
  list: { marginTop: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  icon: { fontSize: fontSize.body, width: 24 },
  name: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  missing: { color: colors.warning },
  error: { fontSize: fontSize.small, color: colors.danger },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  btn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.sm, backgroundColor: colors.primary },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  ghost: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  ghostText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textMuted },
});
