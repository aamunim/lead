import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { duplicatesOf, ignoreDuplicates, type DuplicateOf } from '@/features/leads/merge';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// ⚠️ On the lead page: other leads with one of this lead's numbers
//   (only for people who may merge). Merge, or "not the same person".
// =====================================================================

export function DuplicateWarning({ leadId }: { leadId: string }) {
  const [dups, setDups] = useState<DuplicateOf[]>([]);

  useEffect(() => {
    let live = true;
    duplicatesOf(leadId)
      .then((d) => live && setDups(d))
      .catch(() => live && setDups([]));
    return () => {
      live = false;
    };
  }, [leadId]);

  if (dups.length === 0) return null;

  return (
    <View style={styles.box}>
      <Text style={styles.title}>
        ⚠️ Same number as {dups.length === 1 ? 'another lead' : `${dups.length} other leads`}
      </Text>
      {dups.map((d) => (
        <Pressable
          key={d.id}
          onPress={() => router.push(`/leads/${d.id}` as Href)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${d.name}`}
        >
          <Text style={styles.line} numberOfLines={1}>
            {d.name} · {[d.stage, d.owner ?? 'Unassigned'].filter(Boolean).join(' · ')} ›
          </Text>
        </Pressable>
      ))}
      <View style={styles.row}>
        <Pressable
          onPress={() => router.push(`/leads/merge?ids=${[leadId, ...dups.map((d) => d.id)].join(',')}` as Href)}
          style={styles.btn}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>🔗 Merge</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            // this lead and each of the others (not the others among themselves)
            const shown = dups;
            setDups([]);
            Promise.all(shown.map((d) => ignoreDuplicates([leadId, d.id]))).catch((e) => {
              setDups(shown);
              const msg = e instanceof Error ? e.message : 'Please try again.';
              // eslint-disable-next-line no-alert
              if (Platform.OS === 'web') window.alert(`Could not save: ${msg}`);
              else Alert.alert('Could not save', msg);
            });
          }}
          style={styles.btn}
          accessibilityRole="button"
        >
          <Text style={styles.btnMuted}>Not the same person</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
  },
  title: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  line: { fontSize: fontSize.small, color: colors.text },
  row: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
  btn: { paddingVertical: spacing.xs },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  btnMuted: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
});
