import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
    askCallPermissions,
    askNotificationPermission,
    callPermissionState,
    canSyncCalls,
    hasCallNotifications,
    isCallLogAvailable,
    notificationPermissionState,
    setPhoneCallSync,
    syncCallsNow,
} from '@/features/call-sync/api';
import { closeMySyncNudges, nudgeText, nudgeTitle, type Nudge } from '@/features/nudges/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// One-tap setup for call log sync, opened from a Super Admin reminder.
// The user only has to tap "Allow" on Android's own dialogs.
// =====================================================================

type Phase = 'intro' | 'working' | 'blocked' | 'done';
type StepState = 'waiting' | 'running' | 'ok' | 'skipped' | 'failed';

type Steps = {
  permission: StepState;
  notifications: StepState;
  turnOn: StepState;
  firstSync: StepState;
};

const FRESH_STEPS: Steps = { permission: 'waiting', notifications: 'waiting', turnOn: 'waiting', firstSync: 'waiting' };

/** Phone makers that stop apps in the background unless the user changes a setting */
const STRICT_MAKERS = ['xiaomi', 'redmi', 'poco', 'oppo', 'vivo', 'realme', 'oneplus', 'huawei', 'honor', 'infinix', 'tecno'];

function phoneMaker(): string {
  const c = (Platform.constants ?? {}) as { Manufacturer?: string; Brand?: string };
  return `${c.Manufacturer ?? ''} ${c.Brand ?? ''}`.toLowerCase();
}

const isStrictPhone = () => STRICT_MAKERS.some((m) => phoneMaker().includes(m));

type Props = {
  visible: boolean;
  nudge: Nudge;
  /** "Later" or closed without finishing */
  onLater: () => void;
  /** Setup finished */
  onDone: () => void;
};

export function SyncSetupSheet({ visible, nudge, onLater, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [steps, setSteps] = useState<Steps>(FRESH_STEPS);
  const [error, setError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPhase('intro');
    setSteps(FRESH_STEPS);
    setError(null);
    setSyncWarning(null);
  }, [visible]);

  const mark = (key: keyof Steps, state: StepState) => setSteps((s) => ({ ...s, [key]: state }));

  // --- the whole setup, one step after another ---------------------------
  const run = async () => {
    setError(null);
    setSyncWarning(null);
    setPhase('working');
    setSteps(FRESH_STEPS);

    try {
      // 0. Still allowed? (an admin may have changed the setting)
      if (!(await canSyncCalls())) {
        setPhase('intro');
        setError('Call log sync is not turned on for you any more. Ask your admin.');
        return;
      }

      // 1. Call log + phone permission
      mark('permission', 'running');
      let perm = callPermissionState();
      if (perm !== 'granted') perm = await askCallPermissions();
      if (perm === 'blocked') {
        mark('permission', 'failed');
        setPhase('blocked');
        return;
      }
      if (perm !== 'granted') {
        mark('permission', 'failed');
        setPhase('intro');
        setError('Please tap “Allow” when the phone asks. Without it, calls can’t be saved.');
        return;
      }
      mark('permission', 'ok');

      // 2. Notifications (nice to have; setup goes on without them)
      if (hasCallNotifications) {
        mark('notifications', 'running');
        let n = notificationPermissionState();
        if (n !== 'granted') n = await askNotificationPermission().catch(() => 'denied' as const);
        mark('notifications', n === 'granted' ? 'ok' : 'skipped');
      } else {
        mark('notifications', 'skipped');
      }

      // 3. Switch sync on (also saves lead names on the phone)
      mark('turnOn', 'running');
      setPhoneCallSync(true);
      mark('turnOn', 'ok');

      // 4. First sync (reports to the server, which closes the reminder)
      mark('firstSync', 'running');
      try {
        await syncCallsNow();
        mark('firstSync', 'ok');
      } catch (e) {
        // Sync is on; calls wait on the phone and go up next time
        mark('firstSync', 'failed');
        setSyncWarning(
          `${e instanceof Error ? e.message : 'The first sync didn’t work.'} Your calls are kept on the phone and will sync next time.`,
        );
      }

      await closeMySyncNudges().catch(() => undefined);
      setPhase('done');
    } catch (e) {
      setPhase('intro');
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    }
  };

  // --- render -------------------------------------------------------------
  const from = nudge.sentByName ? `${nudge.sentByName} asked you to do this.` : 'Your admin asked you to do this.';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={phase === 'done' ? onDone : onLater}>
      <View style={styles.backdrop}>
        <Pressable
          style={styles.flex}
          onPress={phase === 'working' ? undefined : phase === 'done' ? onDone : onLater}
          accessibilityLabel="Close"
        />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content}>
            {/* ---------- Not possible here ---------- */}
            {!isCallLogAvailable ? (
              <>
                <Header icon="phone-portrait-outline" title={nudgeTitle(nudge.reason)} />
                <Text style={styles.text}>
                  Call log sync only works in the Android app. Please open the Lead Management app on your Android
                  phone and set it up there.
                </Text>
                <Button title="OK" variant="secondary" onPress={onLater} fullWidth />
              </>
            ) : phase === 'done' ? (
              /* ---------- Finished ---------- */
              <>
                <Header icon="checkmark-circle" color={colors.success} title="All set!" />
                <Text style={styles.text}>Your lead calls will now be saved automatically.</Text>

                {syncWarning && <Text style={styles.warn}>{syncWarning}</Text>}

                {isStrictPhone() && (
                  <View style={styles.tipBox}>
                    <Text style={styles.tipTitle}>One more thing for this phone</Text>
                    <Text style={styles.tipText}>
                      This phone may stop the app in the background. To save calls right after they end:
                    </Text>
                    <Text style={styles.tipStep}>1. Open app settings</Text>
                    <Text style={styles.tipStep}>2. Turn on “Autostart”</Text>
                    <Text style={styles.tipStep}>3. Battery saver → “No restrictions”</Text>
                    <Button title="Open app settings" variant="ghost" onPress={() => Linking.openSettings()} fullWidth />
                  </View>
                )}

                <Button title="Done" onPress={onDone} fullWidth />
              </>
            ) : phase === 'blocked' ? (
              /* ---------- Permission blocked earlier ---------- */
              <>
                <Header icon="lock-closed" color={colors.warning} title="Permission is turned off" />
                <Text style={styles.text}>
                  Call log permission was turned off for this app before, so the phone won’t ask again. Turn it on
                  yourself:
                </Text>
                <Text style={styles.tipStep}>1. Tap “Open app settings”</Text>
                <Text style={styles.tipStep}>2. Permissions → Call logs → Allow</Text>
                <Text style={styles.tipStep}>3. Permissions → Phone → Allow</Text>
                <Text style={styles.tipStep}>4. Come back here and tap “I’ve turned it on”</Text>
                <Button title="Open app settings" onPress={() => Linking.openSettings()} fullWidth />
                <Button title="I’ve turned it on" variant="secondary" onPress={run} fullWidth />
                <Button title="Later" variant="ghost" onPress={onLater} fullWidth />
              </>
            ) : (
              /* ---------- Intro / working ---------- */
              <>
                <Header icon="call" title={nudgeTitle(nudge.reason)} />
                <Text style={styles.from}>{from}</Text>

                {nudge.message && (
                  <View style={styles.messageBox}>
                    <Text style={styles.messageText}>“{nudge.message}”</Text>
                  </View>
                )}

                <Text style={styles.text}>{nudgeText(nudge.reason)}</Text>

                {phase === 'working' && (
                  <View style={styles.steps}>
                    <StepRow label="Call log permission" state={steps.permission} />
                    {hasCallNotifications && <StepRow label="Notifications" state={steps.notifications} />}
                    <StepRow label="Turn on sync" state={steps.turnOn} />
                    <StepRow label="First sync" state={steps.firstSync} />
                  </View>
                )}

                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}

                <View style={styles.privacy}>
                  <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                  <Text style={styles.privacyText}>
                    Only calls with your leads are saved. Other numbers never leave your phone.
                  </Text>
                </View>

                <Button
                  title={phase === 'working' ? 'Setting up…' : 'Set up now'}
                  onPress={run}
                  loading={phase === 'working'}
                  disabled={phase === 'working'}
                  fullWidth
                />
                {phase !== 'working' && <Button title="Later" variant="ghost" onPress={onLater} fullWidth />}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function Header({
  icon,
  title,
  color = colors.primary,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  color?: string;
}) {
  return (
    <View style={styles.header}>
      <View style={[styles.headerIcon, { backgroundColor: color + '1A' }]}>
        <Ionicons name={icon} size={28} color={color} />
      </View>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

function StepRow({ label, state }: { label: string; state: StepState }) {
  const icon =
    state === 'ok' ? (
      <Ionicons name="checkmark-circle" size={20} color={colors.success} />
    ) : state === 'failed' ? (
      <Ionicons name="close-circle" size={20} color={colors.danger} />
    ) : state === 'skipped' ? (
      <Ionicons name="remove-circle" size={20} color={colors.textMuted} />
    ) : state === 'running' ? (
      <ActivityIndicator size="small" color={colors.primary} />
    ) : (
      <Ionicons name="ellipse-outline" size={20} color={colors.border} />
    );

  return (
    <View style={styles.stepRow}>
      <View style={styles.stepIcon}>{icon}</View>
      <Text style={[styles.stepLabel, state === 'waiting' && styles.stepWaiting]}>
        {label}
        {state === 'skipped' ? ' (skipped)' : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },

  header: { alignItems: 'center', gap: spacing.sm },
  headerIcon: { width: 56, height: 56, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  from: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary, textAlign: 'center' },
  text: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
  warn: { fontSize: fontSize.small, lineHeight: 20, color: colors.warning, textAlign: 'center' },

  messageBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  messageText: { fontSize: fontSize.small, fontStyle: 'italic', color: colors.text, textAlign: 'center' },

  steps: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepIcon: { width: 22, alignItems: 'center' },
  stepLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  stepWaiting: { color: colors.textMuted },

  tipBox: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tipTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  tipText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  tipStep: { fontSize: fontSize.small, color: colors.text, marginLeft: spacing.sm },

  privacy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  privacyText: { flex: 1, fontSize: fontSize.caption, color: colors.text },

  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger, textAlign: 'center' },
});