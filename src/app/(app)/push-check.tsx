import * as Device from 'expo-device';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  myPushStatus,
  registerForPush,
  sendTestPush,
  type MyPushStatus,
  type PushState,
  checkPushNow,
} from '@/features/notifications/push';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { isMissingFirebase, StoreUpdateCard } from '@/features/updates/StoreUpdateCard';

// =====================================================================
// 🔔 Notification check: why this phone gets no notifications, and a
//   test push. Every check, the phone also tells the database its state
//   (admins see it on Push health).
// =====================================================================

type Line = { ok: boolean | null; title: string; text: string; fix?: { label: string; run: () => void } };

/** What to switch on, by phone brand (they stop apps in the background) */
function batteryTips(): { brand: string; steps: string[] } {
  const m = (Device.manufacturer ?? '').toLowerCase();
  if (/xiaomi|redmi|poco/.test(m))
    return {
      brand: 'Xiaomi / Redmi / POCO',
      steps: [
        'Settings → Apps → Manage apps → this app → Autostart: ON',
        'Battery saver → No restrictions',
        'Notifications → Allow, and “Leads” on',
        'Recent apps: pull this app down a little → 🔒 lock it',
      ],
    };
  if (/oppo|realme|oneplus/.test(m))
    return {
      brand: 'Oppo / Realme / OnePlus',
      steps: [
        'Settings → Apps → App management → this app → Battery usage → Allow background activity',
        'Allow auto launch: ON',
        'Notifications → Allow',
        'Recent apps: tap ⋮ on the app → Lock',
      ],
    };
  if (/vivo|iqoo/.test(m))
    return {
      brand: 'Vivo / iQOO',
      steps: [
        'Settings → Battery → Background power consumption → this app → Allow',
        'Settings → Apps → Autostart → this app: ON',
        'Notifications → Allow',
      ],
    };
  if (/samsung/.test(m))
    return {
      brand: 'Samsung',
      steps: [
        'Settings → Apps → this app → Battery → Unrestricted',
        'Settings → Battery → Background usage limits → not in “Sleeping apps”',
        'Notifications → Allow',
      ],
    };
  if (/infinix|tecno|itel/.test(m))
    return {
      brand: 'Infinix / Tecno / itel',
      steps: [
        'Phone Master → App management → Auto-start → this app: ON',
        'Settings → Battery → App battery saver → this app: Off',
        'Notifications → Allow',
      ],
    };
  if (/huawei|honor/.test(m))
    return {
      brand: 'Huawei / Honor',
      steps: ['Settings → Battery → App launch → this app → Manage manually: all ON', 'Notifications → Allow'],
    };
  return {
    brand: Device.manufacturer ?? 'This phone',
    steps: [
      'Settings → Apps → this app → Battery → Unrestricted (no optimisation)',
      'Allow running in the background / auto start, if there is such a setting',
      'Notifications → Allow',
    ],
  };
}

const ago = (d: Date) => {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export default function PushCheckScreen() {
  const [state, setState] = useState<PushState | null>(null);
  const [server, setServer] = useState<MyPushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const check = useCallback(async (ask = false) => {
    setBusy(true);
    // The server's part loads by itself: a slow server never holds up the phone's lines
    myPushStatus()
      .then(setServer)
      .catch(() => undefined);
    try {
      // asked once, with time limits (never loads for ever)
      setState(await checkPushNow(ask));
      // the server's view again, after this phone checked in
      setTimeout(
        () =>
          myPushStatus()
            .then(setServer)
            .catch(() => undefined),
        2500,
      );
    } catch (e) {
      setState({
        permission: 'undetermined',
        channelOn: null,
        token: null,
        tokenError: e instanceof Error ? e.message : 'Could not check this phone. Tap Try again.',
      });
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    check(false);
  }, [check]);

  const test = async () => {
    setTestMsg('Sending…');
    try {
      await registerForPush(false);
      const r = await sendTestPush();
      if (r.phones === 0) {
        setTestMsg('⚠ This phone is not registered for notifications yet. Fix the red lines above, then try again.');
        return;
      }
      if (!state?.token) {
        setTestMsg(
          `⚠ This phone is not registered, so the test went only to your other phone${r.phones === 1 ? '' : 's'}. Fix “Phone registered” first.`,
        );
        return;
      }
      setTestMsg('✅ Sent. A “🔔 Test notification” should come in a few seconds.');
      // Expo's answer comes a moment later
      setTimeout(() => myPushStatus().then(setServer), 70_000);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : 'Could not send.');
    }
  };

  const web = Platform.OS === 'web';
  const lines: Line[] = state
    ? [
        {
          ok: state.permission === 'granted',
          title: 'Notifications allowed',
          text:
            state.permission === 'granted'
              ? 'This app may show notifications.'
              : state.permission === 'denied'
                ? 'Notifications are blocked for this app.'
                : 'Not asked yet.',
          fix:
            state.permission === 'granted'
              ? undefined
              : state.permission === 'denied'
                ? { label: 'Open phone settings', run: () => Linking.openSettings() }
                : { label: 'Allow notifications', run: () => check(true) },
        },
        ...(Platform.OS === 'android'
          ? [
              {
                ok: state.channelOn,
                title: '“Leads” notifications on',
                text:
                  state.channelOn === false
                    ? 'The “Leads” kind of notification is switched off in the phone’s settings.'
                    : state.channelOn
                      ? 'On.'
                      : 'Not known on this phone.',
                fix:
                  state.channelOn === false
                    ? { label: 'Open phone settings', run: () => Linking.openSettings() }
                    : undefined,
              } as Line,
            ]
          : []),
        {
          ok: !!state.token,
          title: 'Phone registered',
          text: state.token
            ? `Registered${server ? ` · ${server.tokens} phone${server.tokens === 1 ? '' : 's'} on your account` : ''}.`
            : isMissingFirebase(state.tokenError)
              ? 'This app is too old: it is missing the part notifications need. Update it from the Play Store (above).'
              : (state.tokenError ?? 'Not registered (notifications not allowed yet).'),
          fix: state.token ? undefined : { label: 'Try again', run: () => check(true) },
        },
        {
          ok: server?.lastOkAt ? true : server?.lastError ? false : null,
          title: 'Last notification reached the phone',
          text: server?.lastOkAt
            ? `Yes, ${ago(server.lastOkAt)}.`
            : server?.lastError
              ? `No: ${server.lastError}`
              : 'Not known yet (send a test).',
        },
      ]
    : [];

  const tips = batteryTips();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Notification check' }} />
      {/* 📲 An app from before 2.8.4 can't get push at all: only the Play Store fixes it */}
      {!web && <StoreUpdateCard always />}
      {web ? (
        <Text style={styles.muted}>Open this on the phone: notifications come to the phone app.</Text>
      ) : !state ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : (
        <>
          <View style={styles.card}>
            {lines.map((l) => (
              <View key={l.title} style={styles.line}>
                <Text style={styles.icon}>{l.ok === true ? '✅' : l.ok === false ? '❌' : '➖'}</Text>
                <View style={styles.flex}>
                  <Text style={styles.title}>{l.title}</Text>
                  <Text style={[styles.text, l.ok === false && styles.bad]}>{l.text}</Text>
                  {l.fix && (
                    <Text style={styles.link} onPress={l.fix.run} accessibilityRole="button">
                      {l.fix.label} ›
                    </Text>
                  )}
                </View>
              </View>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>🔔 Test</Text>
            <Text style={styles.text}>Sends a notification to this phone now.</Text>
            {testMsg && <Text style={styles.testMsg}>{testMsg}</Text>}
            {server?.lastTest && state.token && (
              <Text style={styles.muted}>
                Last test {ago(server.lastTest.at)}:{' '}
                {server.lastTest.status === 'delivered' || server.lastTest.status === 'accepted'
                  ? 'reached the push service ✓'
                  : server.lastTest.status === 'failed'
                    ? `failed (${server.lastTest.error ?? 'error'})`
                    : server.lastTest.status === 'no_device'
                      ? 'no phone registered'
                      : (server.lastTest.status ?? '…')}
              </Text>
            )}
            <Button title="Send a test notification" onPress={test} fullWidth />
            <Button title="Check again" variant="ghost" onPress={() => check(false)} loading={busy} fullWidth />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>🔋 Test came late or never? {tips.brand}</Text>
            <Text style={styles.text}>Many phones stop apps in the background to save battery. Switch these on:</Text>
            {tips.steps.map((s, i) => (
              <Text key={s} style={styles.step}>
                {i + 1}. {s}
              </Text>
            ))}
            <Button
              title="Open this app’s settings"
              variant="secondary"
              onPress={() => Linking.openSettings()}
              fullWidth
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  loader: { marginTop: spacing.xl },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  line: { flexDirection: 'row', gap: spacing.md, paddingVertical: 6 },
  icon: { fontSize: 18, width: 24 },
  title: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.small, color: colors.textMuted },
  bad: { color: colors.danger },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: 4 },
  testMsg: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  muted: { fontSize: fontSize.caption, color: colors.textMuted },
  step: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
});
