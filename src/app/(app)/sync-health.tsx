import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  BACKLOG_LIMIT,
  STATUS_INFO,
  cooldownLeft,
  countByStatus,
  forgetSyncDevice,
  formatAgo,
  listSyncHealth,
  needsReminder,
  reminderLine,
  type HealthRow,
  type HealthStatus,
} from '@/features/call-sync/health';
import { NUDGE_MESSAGE_MAX, describeSendResult, sendSyncNudge } from '@/features/nudges/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// The summary boxes at the top (tap one to show only that status)
const SUMMARY: HealthStatus[] = ['problem', 'late', 'not_set_up', 'ok'];

/** People to remind (a user with two phones appears once) */
type Recipient = { userId: string; userName: string };

function uniqueRecipients(rows: HealthRow[]): Recipient[] {
  const seen = new Map<string, Recipient>();
  for (const r of rows) if (!seen.has(r.userId)) seen.set(r.userId, { userId: r.userId, userName: r.userName });
  return [...seen.values()];
}

export default function SyncHealthScreen() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role_key === 'super_admin';

  const [rows, setRows] = useState<HealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<HealthStatus | null>(null);

  // Reminder sheet
  const [remindTo, setRemindTo] = useState<Recipient[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRows(await listSyncHealth());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sync health.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const counts = useMemo(() => countByStatus(rows), [rows]);

  const shown = rows.filter((r) => r.status !== 'not_allowed' && (!only || r.status === only));
  const notAllowed = rows.filter((r) => r.status === 'not_allowed');

  // Everyone who needs a reminder and can get one now
  const remindable = useMemo(
    () => uniqueRecipients(rows.filter((r) => needsReminder(r) && cooldownLeft(r) === 0)),
    [rows],
  );

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 4000);
  };

  const forget = (row: HealthRow) => {
    if (!row.deviceId) return;
    Alert.alert(
      'Remove this phone?',
      `${row.deviceLabel ?? 'This phone'} will be removed from ${row.userName}'s list. Calls already saved stay. ` +
        'If the phone syncs again, it will come back.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await forgetSyncDevice(row.userId, row.deviceId!);
              load();
            } catch (e) {
              Alert.alert('Could not remove', e instanceof Error ? e.message : '');
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Sync health' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.screen}
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
      >
        <Stack.Screen options={{ title: 'Sync health' }} />

        {/* Summary: tap to show only that status */}
        <View style={styles.summary}>
          {SUMMARY.map((s) => {
            const info = STATUS_INFO[s];
            const on = only === s;
            return (
              <Pressable
                key={s}
                onPress={() => setOnly(on ? null : s)}
                style={({ pressed }) => [
                  styles.summaryBox,
                  on && { borderColor: info.color, backgroundColor: info.color + '14' },
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${info.label}: ${counts[s]}`}
              >
                <Text style={[styles.summaryCount, { color: counts[s] > 0 ? info.color : colors.textMuted }]}>
                  {counts[s]}
                </Text>
                <Text style={styles.summaryLabel} numberOfLines={1}>
                  {info.icon} {info.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Remind everyone who needs it (Super Admin only) */}
        {isSuperAdmin && remindable.length > 0 && (
          <Button
            title={`🔔 Remind all (${remindable.length})`}
            variant="secondary"
            onPress={() => setRemindTo(remindable)}
            fullWidth
          />
        )}

        {only && (
          <Pressable onPress={() => setOnly(null)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Show everyone</Text>
          </Pressable>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* One card per user + phone */}
        {shown.length === 0 && !error ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{only ? 'Nobody here' : 'No users yet'}</Text>
            <Text style={styles.muted}>
              {only ? 'No one has this status right now.' : 'Users appear here once call sync is allowed for them.'}
            </Text>
          </View>
        ) : (
          shown.map((row) => (
            <HealthCard
              key={`${row.userId}:${row.deviceId ?? 'none'}`}
              row={row}
              canRemind={isSuperAdmin}
              onRemind={() => setRemindTo([{ userId: row.userId, userName: row.userName }])}
              onLongPress={() => forget(row)}
            />
          ))
        )}

        {/* Users who are not allowed to sync */}
        {!only && notAllowed.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>🚫 Not allowed to sync ({notAllowed.length})</Text>
            <Text style={styles.muted}>{notAllowed.map((r) => r.userName).join(', ')}</Text>
            <Text style={styles.hint}>Change this in Settings → Call log sync → Who can sync.</Text>
          </View>
        )}

        <Text style={styles.hint}>
          Each phone reports here after every sync. A phone that is switched off, or where the app hasn’t been
          opened, won’t update. Press and hold a card to remove an old phone.
          {isSuperAdmin ? ' A reminder shows up in the app the next time the person opens it.' : ''}
        </Text>
      </ScrollView>

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {remindTo && (
        <RemindSheet
          recipients={remindTo}
          onClose={() => setRemindTo(null)}
          onSent={(message) => {
            setRemindTo(null);
            showToast(message);
            load();
          }}
        />
      )}
    </View>
  );
}

// =====================================================================
// One user + phone
// =====================================================================
function HealthCard({
  row,
  canRemind,
  onRemind,
  onLongPress,
}: {
  row: HealthRow;
  canRemind: boolean;
  onRemind: () => void;
  onLongPress: () => void;
}) {
  const info = STATUS_INFO[row.status];
  const phoneLine = [row.deviceLabel, row.appVersion && `v${row.appVersion}`, row.simLabel]
    .filter(Boolean)
    .join(' · ');
  const reminded = reminderLine(row);
  const wait = cooldownLeft(row);
  const showRemind = canRemind && needsReminder(row);

  return (
    <Pressable
      onLongPress={row.deviceId ? onLongPress : undefined}
      delayLongPress={400}
      style={({ pressed }) => [styles.card, { borderLeftColor: info.color, borderLeftWidth: 4 }, pressed && styles.pressed]}
      accessibilityRole="summary"
      accessibilityLabel={`${row.userName}, ${info.label}`}
      accessibilityHint={row.deviceId ? 'Press and hold to remove this phone' : undefined}
    >
      {/* Name + status */}
      <View style={styles.cardTop}>
        <Text style={styles.name} numberOfLines={1}>
          {row.userName}
        </Text>
        <View style={[styles.statusPill, { backgroundColor: info.color + '1A' }]}>
          <Text style={[styles.statusText, { color: info.color }]}>
            {info.icon} {info.label}
          </Text>
        </View>
      </View>

      {row.deviceId ? (
        <>
          {phoneLine ? <Text style={styles.phoneLine}>📱 {phoneLine}</Text> : null}

          {/* Numbers */}
          <View style={styles.stats}>
            <Stat label="Last sync" value={formatAgo(row.lastSyncAt)} />
            <Stat
              label="Waiting"
              value={String(row.pendingCount)}
              color={row.pendingCount >= BACKLOG_LIMIT ? colors.warning : undefined}
            />
            <Stat label="Today" value={`${row.phoneCallsToday} ${row.phoneCallsToday === 1 ? 'call' : 'calls'}`} />
          </View>

          {/* 💬 WhatsApp on this phone */}
          {row.deviceId && row.waOn != null && (
            <Text style={[styles.waLine, row.waOn && row.waAccess === false && { color: colors.warning }]}>
              💬 WhatsApp:{' '}
              {!row.waOn
                ? 'off'
                : row.waAccess === false
                  ? 'on, but “Notification access” is not allowed'
                  : `on · ${row.waToday} today`}
            </Text>
          )}

          {/* What is wrong */}
          {row.problems.map((p) => (
            <Text
              key={p}
              style={[styles.problem, { color: row.status === 'problem' ? colors.danger : colors.warning }]}
            >
              • {p}
            </Text>
          ))}

          <Text style={styles.meta}>
            Last call from phone: {formatAgo(row.lastPhoneCallAt)}
            {row.updatedAt ? ` · Reported ${formatAgo(row.updatedAt)}` : ''}
          </Text>
        </>
      ) : (
        <Text style={styles.muted}>
          {row.problems[0] ?? 'No phone yet.'} They can turn it on in More → Call log sync.
        </Text>
      )}

      {/* Reminder */}
      {reminded && <Text style={styles.reminded}>{reminded}</Text>}
      {showRemind && (
        <Pressable
          onPress={onRemind}
          disabled={wait > 0}
          style={({ pressed }) => [styles.remindBtn, wait > 0 && styles.remindBtnOff, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={wait > 0 ? `Can remind again in ${wait} minutes` : `Remind ${row.userName}`}
        >
          <Text style={[styles.remindText, wait > 0 && styles.remindTextOff]}>
            {wait > 0 ? `🔔 Remind again in ${wait} min` : '🔔 Remind'}
          </Text>
        </Pressable>
      )}
    </Pressable>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// =====================================================================
// Reminder sheet: who + optional message
// =====================================================================
function RemindSheet({
  recipients,
  onClose,
  onSent,
}: {
  recipients: Recipient[];
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = recipients.map((r) => r.userName);
  const who =
    names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await sendSyncNudge(
        recipients.map((r) => r.userId),
        message,
      );
      onSent(describeSendResult(result));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the reminder.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>🔔 Remind to set up call sync</Text>
            <Text style={styles.muted}>
              To: <Text style={styles.bold}>{who}</Text>
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Message (optional)</Text>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="e.g. Please do this before 5 pm"
                placeholderTextColor={colors.textMuted}
                maxLength={NUDGE_MESSAGE_MAX}
                multiline
                style={styles.input}
              />
              <Text style={styles.counter}>
                {message.length}/{NUDGE_MESSAGE_MAX}
              </Text>
            </View>

            <Text style={styles.hint}>
              They’ll see it in the app the next time they open it, with a one-tap “Set up now” button. The reminder
              closes by itself once their phone is syncing.
            </Text>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Button
              title={recipients.length === 1 ? 'Send reminder' : `Send to ${recipients.length} people`}
              onPress={send}
              loading={sending}
              fullWidth
            />
            <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  pressed: { opacity: 0.8 },
  bold: { fontWeight: fontWeight.bold, color: colors.text },

  summary: { flexDirection: 'row', gap: spacing.sm },
  summaryBox: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  summaryCount: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  summaryLabel: { fontSize: 11, fontWeight: fontWeight.semibold, color: colors.textMuted },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },

  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  statusPill: { paddingVertical: 3, paddingHorizontal: spacing.md, borderRadius: radius.pill },
  statusText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  phoneLine: { fontSize: fontSize.caption, color: colors.textMuted },

  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background },
  statValue: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  problem: { fontSize: fontSize.small, fontWeight: fontWeight.semibold },
  waLine: { fontSize: fontSize.small, color: colors.textMuted },
  meta: { fontSize: 11, color: colors.textMuted },
  reminded: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },

  remindBtn: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  remindBtnOff: { borderColor: colors.border, backgroundColor: colors.background },
  remindText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  remindTextOff: { color: colors.textMuted },

  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  empty: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xxl },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.text,
  },
  toastText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.surface, textAlign: 'center' },

  // Reminder sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '85%',
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
  sheetContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  field: { gap: spacing.xs },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    minHeight: 80,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
    textAlignVertical: 'top',
  },
  counter: { alignSelf: 'flex-end', fontSize: 11, color: colors.textMuted },
});