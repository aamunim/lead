import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import {
  askCallPermissions,
  askNotificationPermission,
  callPermissionState,
  canSyncCalls,
  directorySize,
  getCallNotifySettings,
  hasCallNotifications,
  hasWhatsAppSync,
  isCallLogAvailable,
  isCallSyncEnabled,
  lastSyncAt,
  notificationPermissionState,
  openAppDetails,
  openNotificationAccess,
  pendingCount,
  refreshLeadDirectory,
  setCallNotifySettings,
  setPhoneCallSync,
  setWhatsAppSync,
  syncCallsNow,
  whatsAppPendingCount,
  whatsAppStatus,
  type CallPermissionState,
  type NotifySettings,
  type SyncResult,
  type WhatsAppStatus,
} from '@/features/call-sync/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { getSimFilter, getSims, setSimFilter, type Sim } from '../../../modules/call-log';

const ALL_SIMS = '__all__';

function timeAgo(d: Date | null): string {
  if (!d) return 'Never';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function CallSyncScreen() {
  const [allowed, setAllowed] = useState<boolean | null>(null); // admin setting
  const [permission, setPermission] = useState<CallPermissionState>(callPermissionState());
  const [enabled, setEnabled] = useState(isCallSyncEnabled());
  const [sims, setSims] = useState<Sim[]>([]);
  const [simChoice, setSimChoice] = useState<string>(ALL_SIMS);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Notifications ("add a note" after a call, "lead is calling")
  const [notifyPermission, setNotifyPermission] = useState<CallPermissionState>(notificationPermissionState());
  const [notify, setNotify] = useState<NotifySettings>(getCallNotifySettings());
  const [savedLeads, setSavedLeads] = useState(0);

  // 💬 WhatsApp (read from WhatsApp's notifications)
  const [wa, setWa] = useState<WhatsAppStatus>(whatsAppStatus());
  const [waWaiting, setWaWaiting] = useState(0);

  const refreshStatus = useCallback(async () => {
    setPermission(callPermissionState());
    setEnabled(isCallSyncEnabled());
    setSims(getSims());
    setSimChoice(getSimFilter() ?? ALL_SIMS);
    setWaiting(pendingCount());
    setNotifyPermission(notificationPermissionState());
    setNotify(getCallNotifySettings());
    setSavedLeads(directorySize());
    setWa(whatsAppStatus());
    setWaWaiting(whatsAppPendingCount());
    setLastSync(await lastSyncAt());
  }, []);

  useEffect(() => {
    canSyncCalls().then(setAllowed).catch(() => setAllowed(false));
    refreshStatus();
  }, [refreshStatus]);

  // Coming back from the phone's settings: show the new permissions
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshStatus();
    });
    return () => sub.remove();
  }, [refreshStatus]);

  // --- actions -------------------------------------------------------------
  const allow = async () => {
    const state = await askCallPermissions();
    setPermission(state);
    if (state === 'granted') {
      setPhoneCallSync(true);
      // Ask for notifications too (Android 13+); the rest works without them
      if (hasCallNotifications) await askNotificationPermission().catch(() => undefined);
      await refreshStatus();
      syncNow();
    }
  };

  const allowNotifications = async () => {
    const state = await askNotificationPermission();
    if (state === 'blocked') {
      Linking.openSettings();
      return;
    }
    setNotifyPermission(state);
    if (state === 'granted') {
      // Make sure the names are on the phone right away
      await refreshLeadDirectory(true).catch(() => undefined);
      refreshStatus();
    }
  };

  const toggleWhatsApp = (on: boolean) => {
    setWa(setWhatsAppSync(on));
    // Without access nothing can be read: take the user to the steps right away
    if (on && !whatsAppStatus().access) openNotificationAccess();
  };

  const changeNotify = (change: Partial<NotifySettings>) => {
    setCallNotifySettings(change);
    setNotify((now) => ({ ...now, ...change }));
  };

  const toggle = (on: boolean) => {
    setPhoneCallSync(on);
    setEnabled(isCallSyncEnabled());
    if (on) syncNow();
  };

  const chooseSim = (id: string) => {
    setSimFilter(id === ALL_SIMS ? null : id);
    setSimChoice(id);
  };

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      setResult(await syncCallsNow());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sync. Calls are kept on the phone for next time.');
    } finally {
      setSyncing(false);
      refreshStatus();
    }
  };

  // --- screens before the settings ---------------------------------------
  if (!isCallLogAvailable) {
    return (
      <Center icon="phone-portrait-outline" title="Only in the Android app">
        Call log sync works in the installed Android app. It isn’t available in Expo Go or on iPhone.
      </Center>
    );
  }

  if (allowed === null) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Call log sync' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!allowed) {
    return (
      <Center icon="lock-closed" title="Not turned on for you">
        An admin can turn call log sync on for you in Settings → Call log sync.
      </Center>
    );
  }

  if (permission !== 'granted') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.centerContent}>
        <Stack.Screen options={{ title: 'Call log sync' }} />
        <View style={styles.bigIcon}>
          <Ionicons name="call" size={38} color={colors.primary} />
        </View>
        <Text style={styles.bigTitle}>Save lead calls automatically</Text>
        <Text style={styles.centerText}>
          The app reads your phone’s call history and saves calls with your leads: real call time, incoming and
          missed calls, even calls made from the phone’s own dialer.
        </Text>
        <PrivacyNote />
        {permission === 'blocked' ? (
          <>
            <Text style={styles.warn}>Call log permission is turned off for this app.</Text>
            <Button title="Open app settings" onPress={() => Linking.openSettings()} fullWidth />
            <Button title="I’ve turned it on" variant="ghost" onPress={refreshStatus} fullWidth />
          </>
        ) : (
          <Button title="Allow call log access" onPress={allow} fullWidth />
        )}
      </ScrollView>
    );
  }

  // --- settings ---------------------------------------------------------------
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Call log sync' }} />

      {/* On / off */}
      <View style={[styles.card, styles.mainCard]}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.cardTitle}>Sync calls on this phone</Text>
            <Text style={styles.rowText}>
              {enabled
                ? 'On. Lead calls are saved, even right after a call with the app closed.'
                : 'Off. Calls are not read or saved.'}
            </Text>
          </View>
          <Switch value={enabled} onValueChange={toggle} />
        </View>
      </View>

      {enabled && (
        <>
          {/* Status */}
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <Stat label="Last sync" value={timeAgo(lastSync)} />
              <Stat label="Waiting on phone" value={String(waiting)} />
              {hasCallNotifications && <Stat label="Lead names on phone" value={String(savedLeads)} />}
            </View>

            {result && (
              <Text style={styles.okText}>
                ✓ {result.added} new {result.added === 1 ? 'call' : 'calls'} saved
                {result.matched > 0 ? ` · ${result.matched} matched` : ''}
                {result.sent === 0 ? ' · nothing new' : ''}
              </Text>
            )}
            {error && <Text style={styles.errorText}>{error}</Text>}

            <Button title="Sync now" variant="secondary" onPress={syncNow} loading={syncing} fullWidth />
          </View>

          {/* Notifications */}
          {hasCallNotifications && (
            <>
              <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
              <View style={styles.card}>
                {notifyPermission !== 'granted' ? (
                  <>
                    <Text style={styles.helpText}>
                      Allow notifications to get a reminder to add a note after a lead call, and to see the lead’s
                      name when they call you.
                    </Text>
                    <Button
                      title={notifyPermission === 'blocked' ? 'Open app settings' : 'Allow notifications'}
                      onPress={allowNotifications}
                      fullWidth
                    />
                  </>
                ) : (
                  <>
                    <View style={styles.row}>
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle}>After a lead call</Text>
                        <Text style={styles.rowText}>
                          “📞 Karim · 2m 15s — Tap to add a note”. Not shown for calls made with the app’s Call
                          button (the app asks there).
                        </Text>
                      </View>
                      <Switch value={notify.afterCall} onValueChange={(v) => changeNotify({ afterCall: v })} />
                    </View>
                    <View style={styles.divider} />
                    <View style={styles.row}>
                      <View style={styles.flex}>
                        <Text style={styles.rowTitle}>When a lead calls</Text>
                        <Text style={styles.rowText}>
                          Shows the lead’s name, rating, course and last note while the phone rings.
                        </Text>
                      </View>
                      <Switch value={notify.incoming} onValueChange={(v) => changeNotify({ incoming: v })} />
                    </View>
                    <Text style={styles.hint}>
                      {savedLeads} lead {savedLeads === 1 ? 'name is' : 'names are'} kept on this phone for this,
                      and removed when you log out.
                    </Text>
                  </>
                )}
              </View>
            </>
          )}

          {/* 💬 WhatsApp */}
          {hasWhatsAppSync && (
            <>
              <Text style={styles.sectionLabel}>💬 WHATSAPP CALLS</Text>
              <View style={styles.card}>
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>Save WhatsApp calls with leads</Text>
                    <Text style={styles.rowText}>
                      WhatsApp and WhatsApp Business calls (incoming, outgoing, missed) and when a lead sends a
                      message. Read from WhatsApp’s notifications; message text is never read.
                    </Text>
                  </View>
                  <Switch value={wa.enabled} onValueChange={toggleWhatsApp} />
                </View>

                {wa.enabled && !wa.access && (
                  <>
                    <View style={styles.divider} />
                    <Text style={styles.warnText}>⚠ One more step: allow “Notification access”.</Text>
                    {Number(Platform.Version) >= 33 && (
                      <>
                        <Text style={styles.helpText}>
                          Android may say “Restricted setting” (the app is not from the Play Store). Then first:
                        </Text>
                        <Text style={styles.helpStep}>1. Open app info below</Text>
                        <Text style={styles.helpStep}>2. Tap ⋮ (top right) → “Allow restricted settings”</Text>
                        <Text style={styles.helpStep}>3. Come back and tap “Notification access”</Text>
                        <Button title="Open app info" variant="ghost" onPress={openAppDetails} fullWidth />
                      </>
                    )}
                    <Text style={styles.helpText}>Find “Lead Management” in the list and turn it on.</Text>
                    <Button title="Notification access" onPress={openNotificationAccess} fullWidth />
                  </>
                )}

                {wa.enabled && wa.access && (
                  <Text style={styles.hint}>
                    ✓ On. WhatsApp calls are saved with the lead, and you get the same “add a note” and “lead is
                    calling” notifications as phone calls.
                    {waWaiting > 0 ? ` ${waWaiting} waiting to upload.` : ''}
                  </Text>
                )}
                <Text style={styles.hint}>
                  Works for leads whose phone, WhatsApp number or username is saved, or whose name in your contacts
                  matches. WhatsApp’s own notifications must be on.
                </Text>
              </View>
            </>
          )}

          {/* SIM */}
          <Text style={styles.sectionLabel}>WHICH SIM</Text>
          <View style={styles.card}>
            {[{ id: ALL_SIMS, label: 'All SIMs' }, ...sims].map((s, index) => {
              const on = simChoice === s.id;
              return (
                <View key={s.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <Pressable
                    onPress={() => chooseSim(s.id)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
                    <Text style={styles.rowTitle}>{s.label}</Text>
                  </Pressable>
                </View>
              );
            })}
            <Text style={styles.hint}>
              Using a personal SIM too? Choose the office SIM so only its calls are synced.
            </Text>
          </View>

          {/* Xiaomi / POCO / Redmi help */}
          <Text style={styles.sectionLabel}>IF CALLS DON’T APPEAR</Text>
          <View style={styles.card}>
            <Text style={styles.helpText}>
              Some phones (Xiaomi, Redmi, POCO, Oppo, Vivo, Realme) stop apps in the background. To save calls right
              after they end:
            </Text>
            <Text style={styles.helpStep}>1. Open app settings below</Text>
            <Text style={styles.helpStep}>2. Turn on “Autostart”</Text>
            <Text style={styles.helpStep}>3. Battery saver → “No restrictions”</Text>
            <Text style={styles.helpStep}>4. Other permissions → allow “Call logs”</Text>
            <Button title="Open app settings" variant="ghost" onPress={() => Linking.openSettings()} fullWidth />
          </View>
        </>
      )}

      <PrivacyNote />
    </ScrollView>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function Center({ icon, title, children }: { icon: keyof typeof Ionicons.glyphMap; title: string; children: string }) {
  return (
    <View style={styles.center}>
      <Stack.Screen options={{ title: 'Call log sync' }} />
      <Ionicons name={icon} size={40} color={colors.textMuted} />
      <Text style={styles.bigTitle}>{title}</Text>
      <Text style={styles.centerText}>{children}</Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function PrivacyNote() {
  return (
    <View style={styles.privacy}>
      <Ionicons name="shield-checkmark" size={18} color={colors.success} />
      <Text style={styles.privacyText}>
        Only calls with your leads are saved. Other numbers never leave your phone. Numbers are sent as a secure
        code, not as the number itself.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  centerContent: { alignItems: 'center', gap: spacing.md, padding: spacing.xl, paddingTop: spacing.xxl },
  bigIcon: {
    width: 80,
    height: 80,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  bigTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  centerText: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
  warn: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mainCard: { borderColor: colors.primary, borderWidth: 1.5 },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  radio: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  warnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.warning },
  statusRow: { flexDirection: 'row', gap: spacing.md },
  stat: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  statValue: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  okText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  helpText: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  helpStep: { fontSize: fontSize.small, color: colors.textMuted, marginLeft: spacing.sm },
  privacy: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
    alignSelf: 'stretch',
  },
  privacyText: { flex: 1, fontSize: fontSize.caption, lineHeight: 18, color: colors.text },
});