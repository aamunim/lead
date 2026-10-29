import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_TIMING,
  KIND_INFO,
  getMyMuted,
  getNotificationSettings,
  getTimingSettings,
  saveNotificationSettings,
  saveTimingSettings,
  setMyMuted,
  type NotificationKind,
  type NotificationSettings,
  type TimingSettings,
} from '@/features/notifications/api';
import {
  getAssignmentSettings,
  saveAssignmentSettings,
  type HandoverRule,
} from '@/features/settings/assignment';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

const HANDOVER: { value: HandoverRule; title: string; text: string }[] = [
  { value: 'anyone', title: 'Anyone', text: 'Everyone, callers too, can give a lead to any active user.' },
  { value: 'team', title: 'Own team', text: 'To people in the same team, or to their Team Lead.' },
  { value: 'managers', title: 'Team Leads and admins', text: 'Callers can only give leads upwards.' },
  { value: 'off', title: 'Off', text: 'Only people who may assign (admins, Team Leads).' },
];

const QUIET: { label: string; start: string; end: string }[] = [
  { label: 'Off', start: '00:00', end: '00:00' },
  { label: '9 pm – 8 am', start: '21:00', end: '08:00' },
  { label: '10 pm – 8 am', start: '22:00', end: '08:00' },
  { label: '11 pm – 7 am', start: '23:00', end: '07:00' },
];

export default function NotificationSettingsScreen() {
  const { hasPermission, refreshAssignment } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_NOTIFICATIONS);
  const [timing, setTiming] = useState<TimingSettings>(DEFAULT_TIMING);
  const [handover, setHandover] = useState<HandoverRule>('anyone');
  const [muted, setMuted] = useState<NotificationKind[]>([]);
  const [isSuper, setIsSuper] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { profile } = useAuth();

  useEffect(() => {
    setIsSuper(profile?.role_key === 'super_admin');
    Promise.all([getNotificationSettings(), getTimingSettings(), getAssignmentSettings(), getMyMuted().catch(() => [])])
      .then(([n, t, a, m]) => {
        setSettings(n);
        setTiming(t);
        setHandover(a.handover ?? 'anyone');
        setMuted(m);
      })
      .finally(() => setLoading(false));
  }, [profile?.role_key]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const assignment = await getAssignmentSettings();
      await Promise.all([
        saveNotificationSettings(settings),
        saveTimingSettings(timing),
        saveAssignmentSettings({ ...assignment, handover }),
        isSuper ? setMyMuted(muted) : Promise.resolve(),
      ]);
      await refreshAssignment();
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Notifications' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Notifications' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const setKind = (k: NotificationKind, on: boolean) => setSettings((s) => ({ ...s, kinds: { ...s.kinds, [k]: on } }));
  const setNum = (k: keyof Omit<TimingSettings, 'quiet_hours'>, v: number) => setTiming((t) => ({ ...t, [k]: v }));
  const quietLabel = QUIET.find((q) => q.start === timing.quiet_hours.start && q.end === timing.quiet_hours.end);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Notifications' }} />

      <Text style={styles.intro}>
        Push notifications to the phone, and the 🔔 list in the app. Phones need the latest app and notification
        permission.
      </Text>

      {/* Kinds */}
      <Text style={styles.sectionLabel}>WHAT SENDS A NOTIFICATION</Text>
      <View style={styles.card}>
        {KIND_INFO.map((k, i) => (
          <View key={k.kind}>
            {i > 0 && <View style={styles.divider} />}
            <SwitchRow
              title={`${k.icon} ${k.title}`}
              text={k.text}
              value={settings.kinds[k.kind]}
              onChange={(v) => setKind(k.kind, v)}
            />
          </View>
        ))}
      </View>

      {/* Quiet hours */}
      <Text style={styles.sectionLabel}>QUIET HOURS</Text>
      <Choices
        options={QUIET.map((q) => q.label)}
        value={quietLabel?.label ?? `${timing.quiet_hours.start} – ${timing.quiet_hours.end}`}
        onPick={(label) => {
          const q = QUIET.find((x) => x.label === label);
          if (q) setTiming((t) => ({ ...t, quiet_hours: { start: q.start, end: q.end } }));
        }}
      />
      <View style={styles.card}>
        <SwitchRow
          title="“Lead given to you” comes at once"
          text={
            settings.assigned_in_quiet_hours
              ? 'Even in quiet hours. Other notifications wait until the morning.'
              : 'Waits until quiet hours end, like the others.'
          }
          value={settings.assigned_in_quiet_hours}
          onChange={(v) => setSettings((s) => ({ ...s, assigned_in_quiet_hours: v }))}
        />
      </View>

      {/* Timing */}
      <Text style={styles.sectionLabel}>NEXT CALL REMINDER</Text>
      <Text style={styles.label}>Before the call</Text>
      <Choices options={['5', '10', '15', '30']} suffix=" min" value={String(timing.early_reminder_minutes)} onPick={(v) => setNum('early_reminder_minutes', Number(v))} />
      <Text style={styles.label}>Once more when it is late by</Text>
      <Choices options={['15', '30', '60']} suffix=" min" value={String(timing.repeat_reminder_minutes)} onPick={(v) => setNum('repeat_reminder_minutes', Number(v))} />

      <Text style={styles.sectionLabel}>NEW LEAD NOT CALLED</Text>
      <Text style={styles.label}>Tell the person after</Text>
      <Choices options={['5', '15', '30', '60']} suffix=" min" value={String(timing.speed_to_lead_minutes)} onPick={(v) => setNum('speed_to_lead_minutes', Number(v))} />
      <Text style={styles.label}>Then their Team Lead after</Text>
      <Choices options={['2', '4', '8']} suffix=" h" value={String(timing.escalate_team_lead_hours)} onPick={(v) => setNum('escalate_team_lead_hours', Number(v))} />
      <Text style={styles.label}>Then admins after</Text>
      <Choices options={['12', '24', '48']} suffix=" h" value={String(timing.escalate_admin_hours)} onPick={(v) => setNum('escalate_admin_hours', Number(v))} />

      {/* Hand over */}
      <Text style={styles.sectionLabel}>WHO CAN GIVE LEADS TO WHOM (HAND OVER)</Text>
      <View style={styles.card}>
        {HANDOVER.map((h, i) => {
          const on = handover === h.value;
          return (
            <View key={h.value}>
              {i > 0 && <View style={styles.divider} />}
              <Pressable
                onPress={() => setHandover(h.value)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{h.title}</Text>
                  <Text style={styles.rowText}>{h.text}</Text>
                </View>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Text style={styles.hint}>Long press a lead → Give to. A note is optional; the person gets it in the notification.</Text>

      {/* The Super Admin's own */}
      {isSuper && (
        <>
          <Text style={styles.sectionLabel}>MY OWN NOTIFICATIONS (SUPER ADMIN ONLY)</Text>
          <View style={styles.card}>
            {KIND_INFO.map((k, i) => (
              <View key={k.kind}>
                {i > 0 && <View style={styles.divider} />}
                <SwitchRow
                  title={`${k.icon} ${k.title}`}
                  text={muted.includes(k.kind) ? 'Off for me' : 'On for me'}
                  value={!muted.includes(k.kind)}
                  onChange={(v) =>
                    setMuted((m) => (v ? m.filter((x) => x !== k.kind) : [...m.filter((x) => x !== k.kind), k.kind]))
                  }
                />
              </View>
            ))}
          </View>
        </>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Button title="Save" onPress={handleSave} loading={saving} fullWidth />
    </ScrollView>
  );
}

function Choices({
  options,
  value,
  suffix = '',
  onPick,
}: {
  options: string[];
  value: string;
  suffix?: string;
  onPick: (v: string) => void;
}) {
  return (
    <View style={styles.choices}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => onPick(o)}
            style={[styles.choice, on && styles.choiceOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
          >
            <Text style={[styles.choiceText, on && styles.choiceTextOn]}>
              {o}
              {suffix}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SwitchRow({
  title,
  text,
  value,
  onChange,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  pressed: { opacity: 0.7 },
  intro: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginLeft: spacing.xs,
  },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
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
  choices: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  choice: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  choiceTextOn: { color: colors.textOnPrimary },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
