import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { compareVersions, isMissingFirebase, MIN_NATIVE_FOR_PUSH } from '@/features/updates/StoreUpdateCard';
import { isWeb } from '@/features/web/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🩺 Push health (admins): for each person, can their phone get
//   notifications, and what happened to the last ones.
// =====================================================================

type Device = {
  device: string | null;
  platform: string | null;
  app: string | null;
  permission: string | null;
  channel_on: boolean | null;
  has_token: boolean;
  token_error: string | null;
  checked_at: string;
};

type Row = {
  user_id: string;
  full_name: string | null;
  role_name: string | null;
  tokens: number;
  devices: Device[];
  last_push_at: string | null;
  last_status: string | null;
  last_error: string | null;
  sent_7d: number;
  ok_7d: number;
  failed_7d: number;
  no_device_7d: number;
  last_ok_at: string | null;
  app_last_open: string | null;
};

type Verdict = { tone: 'good' | 'warn' | 'bad'; text: string; why: string };

// 🧪 Google's own test phones (Play review / pre-launch report): emulators, not staff phones
function isTestPhone(d: Device): boolean {
  return /sdk_gphone|emulator|android sdk built|generic_x86|google sdk/i.test(d.device ?? '');
}

const OK_STATUS = ['accepted', 'delivered', 'sent'];

function verdict(r: Row): Verdict {
  const real = r.devices.filter((x) => !isTestPhone(x));
  if (r.devices.length > 0 && real.length === 0)
    return {
      tone: 'good',
      text: 'Test phones only',
      why: 'Only Google’s Play test phones (emulators) used this account. Ignored.',
    };
  const d = real[0];
  if (d?.permission === 'denied')
    return { tone: 'bad', text: 'Blocked', why: 'Notifications are not allowed on the phone' };
  if (d?.channel_on === false)
    return { tone: 'bad', text: 'Channel off', why: '“Leads” notifications are switched off' };
  // An app from before 2.8.4 has no Firebase part: only the Play Store fixes it
  if (
    d &&
    !d.has_token &&
    (isMissingFirebase(d.token_error) || (d.app && compareVersions(d.app, MIN_NATIVE_FOR_PUSH) < 0))
  )
    return {
      tone: 'bad',
      text: 'Old app',
      why: `App ${d.app ?? '?'} on this phone can’t get notifications. Ask them to update to ${MIN_NATIVE_FOR_PUSH} or newer from the Play Store (Home shows them a button).`,
    };
  if (r.tokens === 0) {
    if (d?.token_error) return { tone: 'bad', text: 'No token', why: d.token_error };
    if (!d)
      return {
        tone: 'warn',
        text: 'Not checked',
        why: 'The phone has not reported yet (old app, or not opened since)',
      };
    return { tone: 'bad', text: 'Not registered', why: 'No phone can get this person’s notifications' };
  }
  // The latest one reached the phone: older failures (before a fix) don't count
  const lastOk = OK_STATUS.includes(r.last_status ?? '');
  if (r.failed_7d > 0 && r.failed_7d >= r.ok_7d && !lastOk)
    return { tone: 'bad', text: 'Failing', why: r.last_error ?? 'The push service refused them' };
  if (r.failed_7d > 0 && !lastOk)
    return { tone: 'warn', text: 'Some fail', why: r.last_error ?? 'Some pushes did not reach the phone' };
  return {
    tone: 'good',
    text: 'OK',
    why:
      (r.last_ok_at ? `Last reached ${ago(r.last_ok_at)}` : 'Registered') +
      (r.failed_7d > 0 ? ` · ${r.failed_7d} failed earlier this week` : ''),
  };
}

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export default function PushHealthScreen() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('push_health' as never);
    if (e) setError(/could not find the function/i.test(e.message) ? 'The database is not updated yet.' : e.message);
    else {
      setError(null);
      setRows((data ?? []) as unknown as Row[]);
    }
    setRefreshing(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const list = useMemo(() => {
    const all = (rows ?? []).map((r) => ({ r, v: verdict(r) }));
    return onlyProblems ? all.filter((x) => x.v.tone !== 'good') : all;
  }, [rows, onlyProblems]);
  const problems = (rows ?? []).filter((r) => verdict(r).tone !== 'good').length;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Push health' }} />
      {!rows ? (
        error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        )
      ) : (
        <FlatList
          data={list}
          keyExtractor={(x) => x.r.user_id}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
            />
          }
          ListHeaderComponent={
            <View style={styles.head}>
              <Text style={styles.summary}>
                {problems === 0
                  ? '✅ Every phone can get notifications.'
                  : `⚠ ${problems} of ${rows.length} people have a problem.`}
              </Text>
              <Text style={styles.muted}>
                Tell them: More → Notification check → follow the red lines, then “Send a test notification”.
              </Text>
              <View style={styles.seg}>
                {[
                  [true, `Problems · ${problems}`],
                  [false, `Everyone · ${rows.length}`],
                ].map(([v, label]) => (
                  <Pressable
                    key={String(v)}
                    onPress={() => setOnlyProblems(v as boolean)}
                    style={[styles.segBtn, onlyProblems === v && styles.segOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: onlyProblems === v }}
                  >
                    <Text style={[styles.segText, onlyProblems === v && styles.segTextOn]}>{label as string}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          }
          ListEmptyComponent={<Text style={styles.muted}>Nothing to fix. 👍</Text>}
          renderItem={({ item: { r, v } }) => (
            <View style={styles.card}>
              <View style={styles.top}>
                <View style={styles.flex}>
                  <Text style={styles.name}>{r.full_name ?? 'No name'}</Text>
                  <Text style={styles.muted}>
                    {r.role_name ?? 'No role'} · app opened {ago(r.app_last_open)}
                  </Text>
                </View>
                <View style={[styles.pill, styles[`pill_${v.tone}`]]}>
                  <Text style={[styles.pillText, styles[`text_${v.tone}`]]}>{v.text}</Text>
                </View>
              </View>
              <Text style={[styles.why, v.tone === 'bad' && styles.bad]}>{v.why}</Text>
              {r.devices.slice(0, 3).map((d, i) => (
                <Text key={i} style={[styles.device, isTestPhone(d) && styles.testPhone]} numberOfLines={2}>
                  {isTestPhone(d) ? '🧪 Google test phone (ignored) · ' : '📱 '}
                  {d.device ?? d.platform ?? 'Phone'} · app {d.app ?? '?'} ·{' '}
                  {d.permission === 'granted' ? 'allowed' : (d.permission ?? '?')}
                  {d.channel_on === false ? ' · channel off' : ''} · {d.has_token ? 'registered' : 'no token'} · checked{' '}
                  {ago(d.checked_at)}
                </Text>
              ))}
              <Text style={styles.stats}>
                Last 7 days: {r.sent_7d} sent · {r.ok_7d} ok · {r.failed_7d} failed · {r.no_device_7d} no phone
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 860, width: '100%', alignSelf: 'center' } : {}),
  },
  loader: { marginTop: spacing.xl },
  flex: { flex: 1 },
  head: { gap: spacing.sm, marginBottom: spacing.sm },
  summary: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.caption, color: colors.textMuted },
  error: { margin: spacing.lg, fontSize: fontSize.small, color: colors.danger },
  seg: { flexDirection: 'row', gap: spacing.sm },
  segBtn: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  segText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  segTextOn: { color: colors.textOnPrimary },
  card: {
    gap: 4,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  pill_good: { backgroundColor: colors.successSoft },
  pill_warn: { backgroundColor: colors.warningSoft },
  pill_bad: { backgroundColor: colors.dangerSoft },
  pillText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  text_good: { color: colors.success },
  text_warn: { color: colors.warning },
  text_bad: { color: colors.danger },
  why: { fontSize: fontSize.small, color: colors.text },
  bad: { color: colors.danger },
  device: { fontSize: fontSize.caption, color: colors.textMuted },
  testPhone: { opacity: 0.55 },
  stats: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
});
