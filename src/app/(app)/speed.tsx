import { Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';

import { useAuth } from '@/features/auth/AuthProvider';
import { chatUnread, sendChat } from '@/features/feedback/chat';
import { isDeveloper } from '@/features/feedback/api';
import { countLeads, listLeads } from '@/features/leads/api';
import { currentVersionInfo } from '@/features/updates/api';
import { supabase } from '@/shared/lib/supabase';
import { clearSpeed, speedSummary, type SpeedSummary } from '@/shared/lib/speedLog';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⏱ More → Speed check: how long the server takes on this phone.
//   1. "Run the test": the usual requests one by one, each timed
//   2. Since the app opened: every kind of request, average and slowest
//   📤 Send it to the developer (the chat), to find what is slow.
// =====================================================================

type Step = { label: string; ms: number | null; error?: string };

const TESTS: { label: string; run: (uid: string) => PromiseLike<unknown> }[] = [
  { label: 'Ping (the server answers)', run: () => supabase.from('app_settings').select('key').limit(1) },
  { label: 'My profile', run: (uid) => supabase.from('profiles').select('id, role_key').eq('id', uid).maybeSingle() },
  { label: 'Leads list (first page)', run: (uid) => listLeads({ userId: uid, page: 0 }) },
  { label: 'Leads: count all', run: (uid) => countLeads({ userId: uid }) },
  { label: 'Leads: count hot', run: (uid) => countLeads({ userId: uid, quick: 'hot' }) },
  {
    label: 'Students list (first page)',
    run: (uid) => listLeads({ userId: uid, students: true, page: 0, sort: 'admitted_newest' }),
  },
  { label: 'Students: count due', run: (uid) => countLeads({ userId: uid, students: true, quick: 'due' }) },
  { label: 'Chat unread', run: () => chatUnread() },
];

const ms = (n: number | null) => (n == null ? '—' : `${n} ms`);

export default function SpeedScreen() {
  const { profile } = useAuth();
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<SpeedSummary[]>(() => speedSummary());
  const [sent, setSent] = useState<string | null>(null);

  const run = async () => {
    if (!profile?.id) return;
    setRunning(true);
    setSent(null);
    const out: Step[] = [];
    for (const t of TESTS) {
      const started = Date.now();
      try {
        const r = (await t.run(profile.id)) as { error?: { message: string } | null } | null;
        out.push({ label: t.label, ms: Date.now() - started, error: r && r.error ? r.error.message : undefined });
      } catch (e) {
        out.push({ label: t.label, ms: Date.now() - started, error: e instanceof Error ? e.message : 'failed' });
      }
      setSteps([...out]);
    }
    setSummary(speedSummary());
    setRunning(false);
  };

  const report = () => {
    const u = currentVersionInfo();
    const lines = [
      `⏱ Speed check · ${profile?.full_name ?? ''} (${profile?.role_key ?? ''})`,
      `App ${Constants.expoConfig?.version ?? ''} · ${Platform.OS} · update ${u.builtIn ? 'built in' : (u.updateId ?? '').slice(0, 8)}`,
      '',
      'TEST',
      ...steps.map((s) => `${s.label}: ${ms(s.ms)}${s.error ? ` ✗ ${s.error}` : ''}`),
      '',
      'SINCE THE APP OPENED (count · avg · slowest)',
      ...summary
        .slice(0, 25)
        .map((s) => `${s.key}: ${s.count}× · ${s.avg} · ${s.max} ms${s.failed ? ` · ${s.failed} failed` : ''}`),
    ];
    return lines.join('\n');
  };

  const send = async () => {
    try {
      if (await isDeveloper()) {
        setSent('You are the developer: copy it from here.');
        return;
      }
      await sendChat({ body: report().slice(0, 3900), topicKind: 'bug' });
      setSent('📤 Sent to the developer (More → Contact developer).');
    } catch (e) {
      setSent(e instanceof Error ? e.message : 'Could not send.');
    }
  };

  const total = steps.reduce((n, s) => n + (s.ms ?? 0), 0);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Speed check' }} />
      <Text style={styles.muted}>
        Times how long the server takes on this {Platform.OS === 'web' ? 'computer' : 'phone'}. Only the addresses and
        the times are sent, nothing about the leads.
      </Text>

      <View style={styles.card}>
        <Text style={styles.title}>1. The test</Text>
        {steps.length === 0 && !running && <Text style={styles.muted}>Tap “Run the test” (about 10 seconds).</Text>}
        {steps.map((s) => (
          <View key={s.label} style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>
              {s.label}
            </Text>
            <Text
              style={[styles.value, (s.ms ?? 0) > 1500 ? styles.bad : (s.ms ?? 0) > 600 ? styles.warn : styles.good]}
            >
              {s.error ? '✗ ' : ''}
              {ms(s.ms)}
            </Text>
          </View>
        ))}
        {running && <ActivityIndicator color={colors.primary} />}
        {!running && steps.length > 0 && <Text style={styles.total}>All together: {total} ms</Text>}
        <Button title={running ? 'Testing…' : '⏱ Run the test'} onPress={run} loading={running} fullWidth />
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>2. Since the app opened</Text>
        {summary.length === 0 ? (
          <Text style={styles.muted}>Nothing yet. Use the app a little, then come back.</Text>
        ) : (
          summary.slice(0, 25).map((s) => (
            <View key={s.key} style={styles.row}>
              <Text style={styles.label} numberOfLines={1}>
                {s.key}
              </Text>
              <Text style={styles.small}>
                {s.count}× · avg {s.avg} · max {s.max}
                {s.failed ? ` · ${s.failed}✗` : ''}
              </Text>
            </View>
          ))
        )}
        <View style={styles.btns}>
          <Button title="Refresh" variant="secondary" onPress={() => setSummary(speedSummary())} />
          <Button
            title="Clear"
            variant="ghost"
            onPress={() => {
              clearSpeed();
              setSummary([]);
            }}
          />
        </View>
      </View>

      <Button title="📤 Send to the developer" onPress={send} disabled={running} fullWidth />
      {!!sent && <Text style={styles.muted}>{sent}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { flex: 1, fontSize: fontSize.small, color: colors.text },
  value: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  good: { color: colors.success },
  warn: { color: colors.warning },
  bad: { color: colors.danger },
  total: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  btns: { flexDirection: 'row', gap: spacing.sm },
});
