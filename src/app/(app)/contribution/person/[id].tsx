import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  credits,
  getContribPerson,
  periodRange,
  personColor,
  type ContribPersonPage,
  type Period,
} from '@/features/contribution/api';
import { ContribFilterBar, Dot, Stat, cs } from '@/features/contribution/ui';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

// =====================================================================
// 🤝 One person: their admissions' worth, month by month, and every
//   admission they were part of — their share, place and the AI's reason.
// =====================================================================

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

export default function ContributionPersonScreen() {
  const params = useLocalSearchParams<{ id: string; from?: string; to?: string }>();
  const [period, setPeriod] = useState<Period>(params.from ? 'custom' : 'this_month');
  const [f, setF] = useState({
    from: params.from ?? periodRange('this_month').from,
    to: params.to ?? periodRange('this_month').to,
    courseId: null as string | null,
    batchId: null as string | null,
  });
  const [p, setP] = useState<ContribPersonPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    setP(null);
    getContribPerson(params.id, f.from, f.to)
      .then(setP)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, [params.id, f.from, f.to]);

  const maxMonth = Math.max(1, ...(p?.by_month ?? []).map((m) => m.credit));
  const color = params.id ? personColor(params.id) : colors.primary;

  return (
    <ScrollView style={cs.screen} contentContainerStyle={[cs.content, cs.wide]}>
      <Stack.Screen options={{ title: p?.name ?? 'Admission Contribution' }} />
      <ContribFilterBar
        value={f}
        period={period}
        onChange={(next, np) => {
          setF(next);
          setPeriod(np);
        }}
      />
      {error && <Text style={[cs.text, cs.bad]}>{error}</Text>}
      {!p ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <View style={cs.card}>
            <View style={cs.row}>
              <Dot userId={p.user_id} size={14} />
              <Text style={[cs.title, { flex: 1 }]}>{p.name ?? 'No name'}</Text>
            </View>
            <View style={cs.stats}>
              <Stat n={credits(p.credit)} label="Admissions’ worth" tone={color} />
              <Stat n={p.admissions} label="Took part in" />
              <Stat n={p.top_count} label="Biggest share" />
              <Stat n={p.avg_share != null ? `${Math.round(p.avg_share)}%` : '—'} label="Average share" />
            </View>
          </View>

          {p.by_month.length > 1 && (
            <>
              <Text style={cs.label}>MONTH BY MONTH</Text>
              <View style={[cs.card, styles.chart]}>
                {p.by_month.map((m) => (
                  <View key={m.month} style={styles.col}>
                    <Text style={styles.colN}>{credits(m.credit)}</Text>
                    <View style={[styles.colBar, { height: 8 + (m.credit / maxMonth) * 90, backgroundColor: color }]} />
                    <Text style={cs.small}>{monthLabel(m.month)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          <Text style={cs.label}>ADMISSIONS ({p.items.length})</Text>
          {p.items.length === 0 ? (
            <Text style={cs.muted}>No worked-out admissions in this period.</Text>
          ) : (
            p.items.map((i) => (
              <Pressable
                key={i.lead_id}
                onPress={() => router.push(`/contribution/${i.lead_id}` as Href)}
                style={({ pressed }) => [cs.card, pressed && cs.pressed]}
                accessibilityRole="button"
              >
                <View style={cs.row}>
                  <Text style={[cs.title, { flex: 1 }]} numberOfLines={1}>
                    {i.name}
                  </Text>
                  <Text style={[styles.share, { color }]}>{Math.round(i.share)}%</Text>
                </View>
                <Text style={cs.small} numberOfLines={1}>
                  {[i.student_ref, i.course, i.admitted_at.slice(0, 10)].filter(Boolean).join(' · ')} ·{' '}
                  {i.place === 1 ? '🥇 biggest share' : `#${i.place} of ${i.people}`}
                </Text>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${Math.min(100, i.share)}%`, backgroundColor: color }]} />
                </View>
                {!!i.reason && <Text style={cs.text}>{i.reason}</Text>}
              </Pressable>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, minHeight: 140 },
  col: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  colN: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.text },
  colBar: { width: '70%', maxWidth: 36, borderRadius: 4 },
  share: { fontSize: fontSize.body, fontWeight: fontWeight.bold },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.background, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
});
