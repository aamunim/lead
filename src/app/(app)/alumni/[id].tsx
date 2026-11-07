import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AddReferralSheet } from '@/features/alumni/AddReferralSheet';
import {
  addAlumniEvent,
  customText,
  deleteAlumnus,
  EVENT_TEXT,
  getAlumnus,
  listAlumniEvents,
  listAlumniFields,
  listReferrals,
  listRewards,
  setReward,
  type AlumniEvent,
  type AlumniField,
  type Alumnus,
  type Referral,
  type Reward,
} from '@/features/alumni/api';
import {
  ago,
  alumniChanged,
  Avatar,
  s as ui,
  Stat,
  useAlumniAccess,
  useAlumniVersion,
  when,
} from '@/features/alumni/ui';
import { openWhatsApp } from '@/features/leads/contact';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🎓 One alumnus: contact, details (with custom fields), referrals,
//   rewards and the history (notes, calls, messages)
// =====================================================================

const STATUS: Record<Referral['status'], { text: string; color: string }> = {
  new: { text: 'In the inbox', color: colors.primary },
  imported: { text: 'Became a lead', color: colors.success },
  credited: { text: 'Credit given', color: colors.success },
  rejected: { text: 'Rejected', color: colors.textMuted },
};

function ask(title: string, text: string, ok: string, run: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${text}`)) run();
    return;
  }
  Alert.alert(title, text, [
    { text: 'Cancel', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: run },
  ]);
}

export default function AlumnusScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const access = useAlumniAccess();
  const version = useAlumniVersion();
  const [a, setA] = useState<Alumnus | null | undefined>(undefined);
  const [fields, setFields] = useState<AlumniField[]>([]);
  const [refs, setRefs] = useState<Referral[]>([]);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [events, setEvents] = useState<AlumniEvent[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referring, setReferring] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [al, f, r, ev] = await Promise.all([
        getAlumnus(id),
        listAlumniFields(),
        listReferrals({ alumniId: id }),
        listAlumniEvents(id),
      ]);
      setA(al);
      setFields(f);
      setRefs(r);
      setEvents(ev);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setA((old) => old ?? null);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load, version]);

  useEffect(() => {
    if (!id || !access.manage) return;
    listRewards(id)
      .then(setRewards)
      .catch(() => undefined);
  }, [id, access.manage, version]);

  const log = async (kind: 'call' | 'whatsapp' | 'note', body?: string) => {
    if (!a) return;
    try {
      await addAlumniEvent(a.id, kind, body);
      alumniChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  const saveNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    await log('note', note.trim());
    setNote('');
    setBusy(false);
  };

  const remove = () =>
    ask(
      `Delete ${a?.name}?`,
      'They leave the alumni list. Leads they referred keep their history.',
      'Delete',
      async () => {
        try {
          await deleteAlumnus(id);
          alumniChanged();
          router.back();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not delete.');
        }
      },
    );

  const payReward = (r: Reward) => {
    const run = async (method: string) => {
      try {
        await setReward(r.id, 'paid', method);
        alumniChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save.');
      }
    };
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      const m = window.prompt(`Paid ৳${r.amount}: how? (Cash, bKash, Nagad, Bank…)`, 'Cash');
      if (m !== null) run(m);
      return;
    }
    Alert.alert(`Mark ৳${r.amount} paid`, 'How was it paid?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Cash', onPress: () => run('Cash') },
      { text: 'bKash / Nagad', onPress: () => run('Mobile banking') },
      { text: 'Bank', onPress: () => run('Bank') },
    ]);
  };

  if (a === undefined) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumnus' }} />
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  if (a === null) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumnus' }} />
        <Text style={ui.muted}>{error ?? 'Not found (deleted, or you have no access).'}</Text>
      </View>
    );
  }

  const study = [a.course_name, a.batch_name, a.session, a.passing_year ? `Passed ${a.passing_year}` : null]
    .filter(Boolean)
    .join(' · ');
  const work = [a.designation, a.workplace].filter(Boolean).join(', ');
  const place = [a.upazila, a.district].filter(Boolean).join(', ');
  const due = rewards.filter((r) => r.status === 'due').reduce((t, r) => t + r.amount, 0);
  const shownFields = fields.filter((f) => customText(a.custom?.[f.key], f.type) !== '');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen
        options={{
          title: a.name,
          headerRight: access.manage
            ? () => (
                <Pressable
                  onPress={() => router.push(`/alumni/edit?id=${a.id}` as Href)}
                  hitSlop={8}
                  style={styles.headBtn}
                >
                  <Text style={styles.headBtnText}>Edit</Text>
                </Pressable>
              )
            : undefined,
        }}
      />

      {/* Who */}
      <View style={[ui.card, styles.hero]}>
        <Avatar name={a.name} size={64} />
        <Text style={styles.name}>{a.name}</Text>
        {!!study && <Text style={styles.sub}>🎓 {study}</Text>}
        {!!work && <Text style={styles.sub}>🏫 {work}</Text>}
        {!!place && <Text style={styles.sub}>📍 {place}</Text>}
        {a.do_not_contact && <Text style={styles.dnc}>⛔ Do not contact</Text>}
        <Text style={ui.muted}>Last contacted: {ago(a.last_contacted_at)}</Text>
        {!!a.phone && !a.do_not_contact && (
          <View style={styles.contactRow}>
            <Pressable
              style={[styles.contactBtn, styles.call]}
              onPress={() => {
                Linking.openURL(`tel:${a.phone}`);
                log('call');
              }}
              accessibilityRole="button"
            >
              <Text style={styles.contactText}>📞 Call</Text>
            </Pressable>
            <Pressable
              style={[styles.contactBtn, styles.wa]}
              onPress={() => {
                openWhatsApp({ phone: a.phone, whatsapp_number: a.whatsapp_number });
                log('whatsapp');
              }}
              accessibilityRole="button"
            >
              <Text style={styles.contactText}>💬 WhatsApp</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Numbers + refer */}
      <View style={ui.card}>
        <View style={styles.stats}>
          <Stat value={a.referrals} label="Referrals" />
          <Stat value={a.referred_leads} label="Leads" />
          <Stat value={a.referred_admitted} label="Admitted" tint={colors.success} />
          {access.manage && due > 0 && <Stat value={`৳${due}`} label="Reward due" tint={colors.warning} />}
        </View>
        <Button title="📨 Add a referral" onPress={() => setReferring(true)} fullWidth />
        <Text style={ui.muted}>
          Referral code: <Text style={styles.code}>{a.ref_code}</Text>
        </Text>
      </View>

      {/* Details */}
      <View style={ui.card}>
        <Text style={ui.label}>DETAILS</Text>
        <Detail label="Phone" value={a.phone} />
        <Detail label="WhatsApp" value={a.whatsapp_number} />
        <Detail label="E-mail" value={a.email} />
        <Detail label="Roll / Student ID" value={a.student_ref} />
        <Detail label="Address" value={a.address} />
        <Detail label="Looked after by" value={a.owner_name} />
        {shownFields.map((f) => (
          <Detail key={f.key} label={f.label} value={customText(a.custom?.[f.key], f.type)} />
        ))}
        {a.tags.length > 0 && (
          <View style={ui.chips}>
            {a.tags.map((t) => (
              <Text key={t} style={styles.tag}>
                #{t}
              </Text>
            ))}
          </View>
        )}
        {!!a.notes && <Text style={styles.notes}>{a.notes}</Text>}
        {!!a.lead_id && (
          <Pressable onPress={() => router.push(`/leads/${a.lead_id}` as Href)} accessibilityRole="link">
            <Text style={styles.link}>🎓 Open the student record ›</Text>
          </Pressable>
        )}
      </View>

      {/* Referrals */}
      <View style={ui.card}>
        <Text style={ui.label}>REFERRALS ({refs.length})</Text>
        {refs.length === 0 && <Text style={ui.muted}>None yet.</Text>}
        {refs.map((r) => {
          const lead = r.lead_id ?? r.existing_lead_id;
          return (
            <Pressable
              key={r.id}
              style={styles.refRow}
              onPress={() => lead && router.push(`/leads/${lead}` as Href)}
              disabled={!lead}
              accessibilityRole={lead ? 'link' : undefined}
            >
              <View style={styles.flex}>
                <Text style={styles.refName}>
                  {r.name} · {r.phone}
                </Text>
                <Text style={ui.muted}>
                  {when(r.created_at)}
                  {r.course ? ` · ${r.course.name}` : ''}
                  {r.status === 'new' && r.existing_lead_id ? ' · already a lead' : ''}
                  {r.reject_reason ? ` · ${r.reject_reason}` : ''}
                </Text>
              </View>
              <Text style={[styles.status, { color: STATUS[r.status].color }]}>{STATUS[r.status].text}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Rewards */}
      {access.manage && rewards.length > 0 && (
        <View style={ui.card}>
          <Text style={ui.label}>REWARDS</Text>
          {rewards.map((r) => (
            <View key={r.id} style={styles.refRow}>
              <View style={styles.flex}>
                <Text style={styles.refName}>
                  ৳{r.amount} · {r.lead?.name ?? 'Lead'}
                  {r.course ? ` (${r.course.name})` : ''}
                </Text>
                <Text style={ui.muted}>
                  {r.status === 'paid'
                    ? `Paid ${r.paid_at ? when(r.paid_at) : ''}${r.method ? ` · ${r.method}` : ''}`
                    : r.status === 'cancelled'
                      ? `Cancelled${r.note ? ` · ${r.note}` : ''}`
                      : `Due since ${when(r.created_at)}`}
                </Text>
              </View>
              {r.status === 'due' ? (
                <Pressable onPress={() => payReward(r)} style={styles.pay} accessibilityRole="button">
                  <Text style={styles.payText}>Mark paid</Text>
                </Pressable>
              ) : r.status === 'paid' ? (
                <Pressable
                  onPress={() =>
                    ask(
                      'Back to due?',
                      `৳${r.amount} for ${r.lead?.name ?? 'this lead'} is due again.`,
                      'Back to due',
                      () => setReward(r.id, 'due').then(alumniChanged),
                    )
                  }
                  accessibilityRole="button"
                >
                  <Text style={[styles.status, { color: colors.success }]}>✓ Paid</Text>
                </Pressable>
              ) : (
                <Text style={[styles.status, { color: colors.textMuted }]}>Cancelled</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {/* History */}
      <View style={ui.card}>
        <Text style={ui.label}>NOTES & HISTORY</Text>
        <View style={styles.noteRow}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Add a note…"
            placeholderTextColor={colors.textMuted}
            style={styles.noteInput}
            multiline
            accessibilityLabel="Note"
          />
          <Button title="Save" onPress={saveNote} loading={busy} disabled={!note.trim()} />
        </View>
        {events.map((e) => (
          <View key={e.id} style={styles.event}>
            <Text style={styles.eventIcon}>{EVENT_TEXT[e.kind]?.icon ?? '•'}</Text>
            <View style={styles.flex}>
              <Text style={styles.eventText}>
                {e.kind === 'note' ? e.body : (EVENT_TEXT[e.kind]?.text ?? e.kind)}
                {e.kind !== 'note' && e.body ? `: ${e.body}` : ''}
              </Text>
              <Text style={ui.muted}>
                {when(e.created_at)}
                {e.by?.full_name ? ` · ${e.by.full_name}` : ''}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {error && <Text style={ui.error}>{error}</Text>}
      {access.manage && <Button title="Delete" variant="ghost" onPress={remove} fullWidth />}

      {referring && <AddReferralSheet alumniId={a.id} alumniName={a.name} onClose={() => setReferring(false)} />}
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : {}),
  },
  headBtn: { paddingHorizontal: spacing.md },
  headBtnText: { color: colors.textOnPrimary, fontWeight: fontWeight.bold, fontSize: fontSize.body },
  hero: { alignItems: 'center' },
  name: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  sub: { fontSize: fontSize.small, color: colors.text, textAlign: 'center' },
  dnc: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.danger },
  contactRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, alignSelf: 'stretch' },
  contactBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.md },
  call: { backgroundColor: colors.primary },
  wa: { backgroundColor: '#25D366' },
  contactText: { color: '#fff', fontWeight: fontWeight.bold, fontSize: fontSize.body },
  stats: { flexDirection: 'row', paddingVertical: spacing.xs },
  code: { fontWeight: fontWeight.bold, color: colors.text, letterSpacing: 2 },
  detail: { flexDirection: 'row', gap: spacing.md },
  detailLabel: { width: 130, fontSize: fontSize.small, color: colors.textMuted },
  detailValue: { flex: 1, fontSize: fontSize.small, color: colors.text },
  tag: {
    fontSize: fontSize.caption,
    color: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  notes: { fontSize: fontSize.small, color: colors.text, fontStyle: 'italic' },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  refRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  refName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  status: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  pay: { paddingVertical: 6, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.success },
  payText: { color: '#fff', fontWeight: fontWeight.bold, fontSize: fontSize.small },
  noteRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' },
  noteInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  event: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 4 },
  eventIcon: { width: 22, fontSize: 15, textAlign: 'center' },
  eventText: { fontSize: fontSize.small, color: colors.text },
});
