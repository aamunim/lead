import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  canSeeReports,
  getLeadReport,
  getReportSettings,
  pct,
  periodRange,
  type LeadReport,
} from '@/features/reports/api';
import { FunnelBars } from '@/features/reports/charts';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📊 Home: "This month" in one card (tap → Reports)
//   Shown when Settings → Reports allows this person and the card is on.
// =====================================================================
export function ReportHomeCard() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [report, setReport] = useState<LeadReport | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const settings = await getReportSettings();
        if (!settings.home_card || !canSeeReports(settings, profile, isAdmin)) {
          if (!cancelled) setReport(null);
          return;
        }
        try {
          const r = await getLeadReport(periodRange('month'), false);
          if (!cancelled) setReport(r);
        } catch {
          // no internet: the card just stays hidden
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [profile, isAdmin]),
  );

  if (!report) return null;
  const s = report.summary;

  return (
    <Pressable
      onPress={() => router.push('/reports' as Href)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`This month: ${s.new_leads} new leads, ${s.admitted} admitted. Open reports`}
    >
      <View style={styles.header}>
        <Text style={styles.title}>📊 This month</Text>
        <Text style={styles.link}>Reports ›</Text>
      </View>

      <View style={styles.stats}>
        <Stat value={String(s.new_leads)} label="new" />
        <Stat value={String(s.admitted)} label="admitted" />
        <Stat value={pct(s.cohort_admitted, s.new_leads)} label="conversion" />
        <Stat value={String(s.lost)} label="lost" />
      </View>

      {s.new_leads > 0 && <FunnelBars steps={report.funnel} compact />}
    </Pressable>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted },
});
