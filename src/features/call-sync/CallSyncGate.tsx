import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { signOut } from '@/features/auth/api';
import {
  askCallPermissions,
  callPermissionState,
  canSyncCalls,
  isCallSyncEnabled,
  reportSyncStatus,
  setPhoneCallSync,
  syncCallsNow,
  type CallPermissionState,
} from '@/features/call-sync/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { isCallLogAvailable } from '../../../modules/call-log';

// =====================================================================
// 📞 Call log sync required (Users → a person → Super Admin only):
//   their Android app does not open until call log permission is given
//   and Call log sync is on in this phone. Checked again every time the
//   app comes back, so turning it off later shows this screen again.
//   Not on the website, iPhone or an app without the call log part.
// =====================================================================

const PROFILE_CHECK_MS = 5 * 60 * 1000;
let lastProfileCheck = Date.now();

export function CallSyncGate({ children }: { children: ReactNode }) {
  const { profile, refreshProfile } = useAuth();
  const required = !!profile?.call_sync_required && Platform.OS === 'android' && isCallLogAvailable;

  const [perm, setPerm] = useState<CallPermissionState>(callPermissionState());
  const [on, setOn] = useState(isCallSyncEnabled());
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    setPerm(callPermissionState());
    setOn(isCallSyncEnabled());
  }, []);

  useEffect(() => {
    if (!required) return;
    canSyncCalls()
      .then(setAllowed)
      .catch(() => setAllowed(true));
  }, [required]);

  // Back from the phone's settings (or the app opened again): look again,
  // and pick up a change the Super Admin made meanwhile
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      check();
      // ⚡ the Super Admin's change: looked up at most every 5 minutes, not
      //   after every phone call (each look re-drew the whole app)
      if (Date.now() - lastProfileCheck < PROFILE_CHECK_MS) return;
      lastProfileCheck = Date.now();
      refreshProfile().catch(() => undefined);
    });
    return () => sub.remove();
  }, [check, refreshProfile]);

  const ok = perm === 'granted' && on;
  const blocking = required && allowed !== false && !ok;

  // Just fixed: tell Sync health, and send the waiting calls
  const [wasBlocking, setWasBlocking] = useState(false);
  useEffect(() => {
    if (blocking) setWasBlocking(true);
    else if (wasBlocking) {
      setWasBlocking(false);
      reportSyncStatus().catch(() => undefined);
      syncCallsNow().catch(() => undefined);
    }
  }, [blocking, wasBlocking]);

  if (!blocking) return <>{children}</>;
  if (allowed === null)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );

  const allow = async () => {
    setBusy(true);
    try {
      const state = await askCallPermissions();
      if (state === 'blocked') await Linking.openSettings();
      check();
      // permission given: turn sync on as well, in one go
      if (state === 'granted' && !isCallSyncEnabled()) {
        setPhoneCallSync(true);
        check();
      }
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () => {
    setPhoneCallSync(true);
    check();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.icon}>📞</Text>
      <Text style={styles.title}>Turn on Call log sync</Text>
      <Text style={styles.text}>
        The Super Admin made Call log sync necessary for you. The app opens as soon as these two are done.
      </Text>

      <View style={styles.card}>
        <Step
          done={perm === 'granted'}
          title="Call log permission"
          text={
            perm === 'blocked'
              ? 'Turned off for this app: open the phone’s settings → Permissions → Call logs and Phone → Allow.'
              : 'The app reads only calls with your leads.'
          }
        />
        {perm !== 'granted' && (
          <Button
            title={perm === 'blocked' ? 'Open phone settings' : 'Allow'}
            onPress={perm === 'blocked' ? () => Linking.openSettings() : allow}
            loading={busy}
            fullWidth
          />
        )}

        <Step done={on} title="Call log sync on this phone" text="Calls with leads are saved by themselves." />
        {perm === 'granted' && !on && <Button title="Turn on" onPress={turnOn} fullWidth />}
      </View>

      <Text style={styles.small}>
        Xiaomi / Redmi / POCO: also Other permissions → allow “Call logs”. Problems? Ask your admin.
      </Text>
      <Button title="Check again" variant="secondary" onPress={check} fullWidth />
      <Button title="Sign out" variant="ghost" onPress={() => signOut().catch(() => undefined)} fullWidth />
    </ScrollView>
  );
}

function Step({ done, title, text }: { done: boolean; title: string; text: string }) {
  return (
    <View style={styles.step}>
      <Text style={styles.stepIcon}>{done ? '✅' : '❌'}</Text>
      <View style={styles.flex}>
        <Text style={[styles.stepTitle, done && styles.stepDone]}>{title}</Text>
        {!done && <Text style={styles.small}>{text}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  flex: { flex: 1 },
  icon: { fontSize: 52, textAlign: 'center' },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  text: { fontSize: fontSize.body, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  step: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  stepIcon: { fontSize: 20 },
  stepTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  stepDone: { color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted, lineHeight: 18 },
});
