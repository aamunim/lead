import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

import { schoolAlumni, type SchoolAlumni } from './api';
import { useAlumniAccess } from './ui';

// =====================================================================
// 🏫 On the lead page: our alumni who work at the lead's workplace
//   ("3 alumni work at Mirpur Ideal School: Rahim, Karim…") — someone the
//   lead may know. Asked only when the lead has a workplace and the person
//   sees alumni; otherwise just the workplace.
// =====================================================================

export function LeadSchoolAlumni({ workplace }: { workplace: string | null | undefined }) {
  const access = useAlumniAccess();
  const [data, setData] = useState<SchoolAlumni | null>(null);

  useEffect(() => {
    setData(null);
    if (!access.view || !workplace?.trim()) return;
    let live = true;
    schoolAlumni(workplace).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [workplace, access.view]);

  if (!workplace?.trim()) return null;
  if (!data) {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>Workplace</Text>
        <Text style={[styles.flex, styles.value]}>{workplace}</Text>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={styles.label}>Workplace</Text>
      <View style={styles.flex}>
        <Text style={styles.value}>{workplace}</Text>
        <Text style={styles.muted}>
          🎓 {data.count} of our alumni work here:{' '}
          {data.list.map((a, i) => (
            <Text key={a.id}>
              {i > 0 ? ', ' : ''}
              <Text style={styles.link} onPress={() => router.push(`/alumni/${a.id}` as Href)}>
                {a.name}
              </Text>
            </Text>
          ))}
          {data.count > data.list.length ? '…' : ''}
        </Text>
      </View>
      <Pressable
        onPress={() =>
          router.push(
            `/alumni?school=${encodeURIComponent(data.key)}&schoolName=${encodeURIComponent(workplace)}` as Href,
          )
        }
        hitSlop={8}
        accessibilityRole="button"
      >
        <Text style={styles.link}>All ›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6, gap: spacing.sm },
  label: { width: 120, fontSize: fontSize.small, color: colors.textMuted },
  flex: { flex: 1, gap: 2 },
  value: { fontSize: fontSize.small, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});
