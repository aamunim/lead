import { router, type Href } from 'expo-router';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
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
import { PipelineBars } from '@/features/reports/charts';
import { B, Fold, md } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📊 Home: "This month" in one card (tap → Reports)
//   Shown when Settings → Reports allows this person and the card is on.
// =====================================================================
export function ReportHomeCard() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  // ⚡ last time's card at once, then the fresh one
  const [report, setReport] = useSavedState<LeadReport | null>('home:report', null);

  useFocusRefresh(
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
    <Fold
      id="month"
      icon="insights"
      tint={{ bg: md.primaryC, fg: md.onPrimaryC }}
      title="This month"
      summary={
        <>
          <B>{s.admitted}</B> admitted
        </>
      }
    >
      <View style={styles.body}>
        <View style={styles.stats}>
          <Stat value={String(s.new_leads)} label="new" />
          <Stat value={String(s.admitted)} label="admitted" />
          <Stat value={pct(s.cohort_admitted, s.new_leads)} label="conversion" />
          <Stat value={String(s.lost)} label="lost" />
        </View>
        {/* Where this month's new leads are now */}
        {s.new_leads > 0 && <PipelineBars steps={report.pipeline} mode="period" compact />}
        <Pressable onPress={() => router.push('/reports' as Href)} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.link}>Open Reports →</Text>
        </Pressable>
      </View>
    </Fold>
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
  body: { gap: spacing.md, padding: spacing.md, paddingHorizontal: spacing.lg },
  pressed: { opacity: 0.8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted },
});
