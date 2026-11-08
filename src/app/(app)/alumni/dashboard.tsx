import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { alumniDashboard, type AlumniDashboard } from '@/features/alumni/api';
import { s as ui, useAlumniAccess } from '@/features/alumni/ui';
import { MIcon, md, Tap, type MIconName } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📊 Alumni dashboard (one request): how many, how many we talk to, the
//   referral funnel (link opened → referred → lead → admitted), the last
//   6 months, districts, rewards; and the other alumni screens.
// =====================================================================

const MONTH = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });

export default function AlumniDashboardScreen() {
  const access = useAlumniAccess();
  const [d, setD] = useState<AlumniDashboard | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await alumniDashboard());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setD((o) => o ?? null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const funnel = d
    ? [
        { label: 'Link opened', value: d.funnel.opens, color: md.skyC },
        { label: 'Referred', value: d.funnel.referrals, color: md.primaryC },
        { label: 'Became leads', value: d.funnel.leads, color: md.warnC },
        { label: 'Admitted', value: d.funnel.admitted, color: md.okC },
      ]
    : [];
  const top = Math.max(1, ...funnel.map((f) => f.value));
  const monthTop = Math.max(1, ...(d?.months ?? []).map((m) => Math.max(m.referrals, m.admitted)));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => (setRefreshing(true), load().finally(() => setRefreshing(false)))}
        />
      }
    >
      <Stack.Screen options={{ title: 'Alumni dashboard' }} />

      {/* Shortcuts */}
      <View style={styles.links}>
        <Link icon="emoji-events" label="Top referrers" to="/alumni/top" />
        <Link icon="campaign" label="Campaigns" to="/alumni/campaigns" />
        <Link icon="apartment" label="Schools" to="/alumni/schools" />
        {access.manage && (
          <Link
            icon="how-to-reg"
            label={`Updates${d?.updates_waiting ? ` · ${d.updates_waiting}` : ''}`}
            to="/alumni/updates"
          />
        )}
        {access.manage && <Link icon="people-alt" label="Duplicates" to="/alumni/duplicates" />}
      </View>

      {d === undefined && <ActivityIndicator color={colors.primary} />}
      {error && <Text style={ui.error}>{error}</Text>}

      {d && (
        <>
          <View style={styles.tiles}>
            <Tile value={d.alumni} label="Alumni" />
            <Tile value={d.contacted_90} label="Talked to (90 days)" />
            <Tile value={d.never_contacted} label="Never contacted" warn={d.never_contacted > 0} />
            <Tile value={d.referrers} label="Have referred" />
            <Tile value={d.with_workplace} label="Workplace known" />
            <Tile value={d.campaigns} label="Campaigns" />
          </View>

          <View style={ui.card}>
            <Text style={ui.label}>THE FUNNEL (ALL TIME)</Text>
            {funnel.map((f, i) => (
              <View key={f.label} style={styles.fRow}>
                <Text style={styles.fLabel}>{f.label}</Text>
                <View style={styles.fTrack}>
                  <View
                    style={[styles.fBar, { width: `${Math.max(2, (f.value / top) * 100)}%`, backgroundColor: f.color }]}
                  />
                </View>
                <Text style={styles.fValue}>
                  {f.value}
                  {i > 0 && funnel[i - 1].value > 0 ? (
                    <Text style={styles.pct}> {Math.round((f.value / funnel[i - 1].value) * 100)}%</Text>
                  ) : null}
                </Text>
              </View>
            ))}
          </View>

          <View style={ui.card}>
            <Text style={ui.label}>LAST 6 MONTHS</Text>
            <View style={styles.months}>
              {d.months.map((m) => (
                <View key={m.month} style={styles.month}>
                  <View style={styles.cols}>
                    <View
                      style={[
                        styles.col,
                        { height: `${(m.referrals / monthTop) * 100}%`, backgroundColor: md.primaryC },
                      ]}
                    />
                    <View
                      style={[
                        styles.col,
                        { height: `${(m.admitted / monthTop) * 100}%`, backgroundColor: colors.success },
                      ]}
                    />
                  </View>
                  <Text style={styles.mLabel}>{MONTH(m.month)}</Text>
                  <Text style={styles.mNums}>
                    {m.referrals}/{m.admitted}
                  </Text>
                </View>
              ))}
            </View>
            <Text style={ui.muted}>
              Bars: referrals / admitted. 🔗 link opens this month: {d.months[d.months.length - 1]?.opens ?? 0}
            </Text>
          </View>

          {d.districts.length > 0 && (
            <View style={ui.card}>
              <Text style={ui.label}>DISTRICTS</Text>
              {d.districts.map((x) => (
                <View key={x.name} style={styles.dRow}>
                  <Text style={[styles.dName, styles.flex]} numberOfLines={1}>
                    {x.name}
                  </Text>
                  <Text style={styles.dNums}>
                    {x.alumni} alumni · 📨 {x.referrals} · <Text style={styles.ok}>🎓 {x.admitted}</Text>
                  </Text>
                </View>
              ))}
            </View>
          )}

          {d.rewards_due !== null && (
            <View style={ui.card}>
              <Text style={ui.label}>REWARDS</Text>
              <Text style={styles.money}>
                Due ৳{Math.round(d.rewards_due ?? 0)} · Paid ৳{Math.round(d.rewards_paid ?? 0)}
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Tile({ value, label, warn }: { value: number; label: string; warn?: boolean }) {
  return (
    <View style={[styles.tile, warn && styles.tileWarn]}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

function Link({ icon, label, to }: { icon: MIconName; label: string; to: string }) {
  return (
    <Tap onPress={() => router.push(to as Href)} style={styles.link} label={label}>
      <MIcon name={icon} size={20} color={md.onPrimaryC} />
      <Text style={styles.linkText}>{label}</Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    backgroundColor: md.primaryC,
    overflow: 'hidden',
  },
  linkText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '30%',
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: md.surface1,
    gap: 2,
  },
  tileWarn: { backgroundColor: md.warnC },
  tileValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  tileLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  fRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fLabel: { width: 96, fontSize: fontSize.small, color: colors.text },
  fTrack: { flex: 1, height: 18, borderRadius: 9, backgroundColor: md.surface2, overflow: 'hidden' },
  fBar: { height: '100%', borderRadius: 9 },
  fValue: { width: 74, textAlign: 'right', fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  pct: { fontSize: fontSize.caption, fontWeight: fontWeight.medium, color: colors.textMuted },
  months: { flexDirection: 'row', gap: spacing.sm, height: 140, alignItems: 'flex-end' },
  month: { flex: 1, alignItems: 'center', gap: 2, height: '100%' },
  cols: { flex: 1, width: '100%', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 3 },
  col: { width: 10, minHeight: 2, borderRadius: 3 },
  mLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  mNums: { fontSize: fontSize.caption, color: colors.text },
  dRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  dName: { fontSize: fontSize.body, color: colors.text },
  dNums: { fontSize: fontSize.small, color: colors.textMuted },
  ok: { color: colors.success, fontWeight: fontWeight.bold },
  money: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
});
