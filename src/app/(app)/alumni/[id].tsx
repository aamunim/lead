import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { AddReferralSheet } from '@/features/alumni/AddReferralSheet';
import { AlumniContactSheet } from '@/features/alumni/AlumniContactSheet';
import { AlumniMessageSheet } from '@/features/alumni/AlumniMessageSheet';
import { AlumniVoiceButton, AlumniVoicePlay } from '@/features/alumni/AlumniVoice';
import { AlumnusSmsCard } from '@/features/sms/AlumnusSmsCard';
import {
  addAlumniEvent,
  alumniThanksDue,
  canDeleteAlumniEvent,
  CONTACT_KINDS,
  customText,
  DEFAULT_THANKS,
  deleteAlumniEvent,
  fillAlumniMessage,
  getAlumniSettings,
  markAlumniThanked,
  newAlumniUpdateLink,
  updateLink,
  deleteAlumnus,
  EVENT_TEXT,
  pinAlumniEvent,
  restoreAlumniEvent,
  setAlumniNextContact,
  getAlumnus,
  listAlumniEvents,
  listAlumniFields,
  listReferrals,
  listRewards,
  referLink,
  setReward,
  type AlumniEvent,
  type AlumniField,
  type Alumnus,
  type Referral,
  type Reward,
  type ThanksDue,
} from '@/features/alumni/api';
import {
  ago,
  alumniChanged,
  Avatar,
  Chip,
  s as ui,
  Stat,
  useAlumniAccess,
  useAlumniVersion,
  when,
} from '@/features/alumni/ui';
import { MenuSheet, NextContactSheet, whenText } from '@/features/alumni/sheets';
import { useAuth } from '@/features/auth/AuthProvider';
import { channelLabel, directionInfo, findWhatsAppCall, formatDuration, outcomeInfo } from '@/features/calls/api';
import { getDeviceId, markCallFromApp, type WhatsAppDeviceEvent } from '@/features/call-sync/api';
import { MIcon, md, Tap, type MIconName } from '@/features/home/md';
import { openWhatsApp } from '@/features/leads/contact';
import { isWeb } from '@/features/web/api';
import { COLLEGE } from '@/features/web/brand';
import { copyLink, shareLink } from '@/shared/lib/shareLink';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🎓 One alumnus: contact, next contact, details (with custom fields),
//   referrals, rewards and the history (notes, calls, messages)
//   📞 Call / 💬 WhatsApp from here: when you come back, a popup asks
//   what happened, a note and the next contact (like on a lead).
//   Opened with ?dial=1 / ?wa=1 (list buttons) → calls / opens WhatsApp;
//   ?callNote=<phone call id> / ?waCall=<id> (the phone's "add a note"
//   alert) → the popup for that call.
//   Notes: 📌 pin, long-press → delete (↩ undo for 10 minutes).
// =====================================================================

type Show = 'all' | 'contacts' | 'notes' | 'referrals' | 'changes';
const SHOWS: { key: Show; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'contacts', label: 'Calls & WhatsApp' },
  { key: 'notes', label: 'Notes' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'changes', label: 'Changes' },
];
const REFERRAL_KINDS = [
  'referral',
  'referral_imported',
  'referral_credited',
  'referral_rejected',
  'admitted',
  'reward',
];

function shownIn(e: AlumniEvent, show: Show): boolean {
  switch (show) {
    case 'contacts':
      return CONTACT_KINDS.includes(e.kind);
    case 'notes':
      return !!e.body && ['note', 'call', 'whatsapp', 'message'].includes(e.kind);
    case 'referrals':
      return REFERRAL_KINDS.includes(e.kind);
    case 'changes':
      return ['created', 'edited', 'deleted', 'restored', 'next_contact'].includes(e.kind);
    default:
      return true;
  }
}

/** "5 May" (+ age if the year is known) */
function birthdayText(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  const today = now.getMonth() === d.getMonth() && now.getDate() === d.getDate();
  return `${today ? '🎉 Birthday today · ' : ''}${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}${
    age > 0 && age < 120 ? ` · ${age} years` : ''
  }`;
}

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
  const { id, dial, wa, callNote, waCall, thank } = useLocalSearchParams<{
    id: string;
    dial?: string;
    wa?: string;
    callNote?: string;
    waCall?: string;
    /** 🙏 the "admitted by referral" alert: say thanks for this student */
    thank?: string;
  }>();
  const access = useAlumniAccess();
  const { profile } = useAuth();
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
  const [show, setShow] = useState<Show>('all');
  // 📞 the popup after a call / WhatsApp
  const [contact, setContact] = useState<null | {
    channel: 'phone' | 'whatsapp' | 'sms';
    estimatedSec?: number | null;
    deviceCallId?: string | null;
    waEvent?: WhatsAppDeviceEvent | null;
    manual?: boolean;
  }>(null);
  const [nextOpen, setNextOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<AlumniEvent | null>(null);
  // 🙏 admitted referrals not thanked yet; 💬 a message (✨ AI)
  const [thanks, setThanks] = useState<ThanksDue[]>([]);
  const [thanking, setThanking] = useState<{ lead: ThanksDue; text: string } | null>(null);
  const [messaging, setMessaging] = useState(false);
  const [undo, setUndo] = useState<{ id: string; at: number } | null>(null);
  const startedAt = useRef<number | null>(null);
  const leftApp = useRef(false);
  const pending = useRef<'phone' | 'whatsapp'>('phone');
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

  // only when someone they referred was admitted (most pages ask nothing more)
  const admitted = a?.referred_admitted ?? 0;
  useEffect(() => {
    if (!id || admitted === 0) return setThanks([]);
    alumniThanksDue(id)
      .then(setThanks)
      .catch(() => undefined);
  }, [id, admitted, version]);

  const openThanks = async (lead: ThanksDue) => {
    if (!a) return;
    const st = await getAlumniSettings().catch(() => null);
    setThanking({
      lead,
      text: fillAlumniMessage(st?.thanks_text || DEFAULT_THANKS, a, { student: lead.name, course: lead.course ?? '' }),
    });
  };

  // a message (typed or ✨ AI): WhatsApp opens with it; back here → the popup logs it
  const sendMessage = async (text: string) => {
    if (!a) return;
    startedAt.current = Date.now();
    leftApp.current = false;
    pending.current = 'whatsapp';
    const ok = await openWhatsApp({ phone: a.phone, whatsapp_number: a.whatsapp_number }, text);
    if (!ok) {
      startedAt.current = null;
      throw new Error('Could not open WhatsApp.');
    }
    setMessaging(false);
  };

  const shareUpdateLink = async (fresh = false) => {
    if (!a) return;
    try {
      const token = fresh || !a.update_token ? await newAlumniUpdateLink(a.id) : a.update_token;
      if (fresh) alumniChanged();
      await shareLink(
        `${a.name}, আপনার তথ্য (কর্মস্থল, নম্বর…) হালনাগাদ করতে এই লিংকটি খুলুন — ${COLLEGE}`,
        updateLink(token),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make the link.');
    }
  };

  useEffect(() => {
    if (!id || !access.manage) return;
    listRewards(id)
      .then(setRewards)
      .catch(() => undefined);
  }, [id, access.manage, version]);

  // --- after a call / WhatsApp: the popup when the user comes back ------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (startedAt.current == null) return;
      if (state === 'background' || state === 'inactive') {
        leftApp.current = true;
        return;
      }
      if (state === 'active' && leftApp.current) {
        const seconds = Math.round((Date.now() - startedAt.current) / 1000);
        startedAt.current = null;
        leftApp.current = false;
        setContact({ channel: pending.current, estimatedSec: seconds });
      }
    });
    return () => sub.remove();
  }, []);

  const call = async () => {
    if (!a?.phone) return;
    startedAt.current = Date.now();
    leftApp.current = false;
    pending.current = 'phone';
    // the app shows its own popup for this call: no "add a note" alert
    markCallFromApp(a.phone);
    try {
      await Linking.openURL(`tel:${a.phone}`);
    } catch {
      startedAt.current = null;
      setError('Could not open the phone app.');
    }
  };
  const whatsapp = async () => {
    if (!a) return;
    startedAt.current = Date.now();
    leftApp.current = false;
    pending.current = 'whatsapp';
    const ok = await openWhatsApp({ phone: a.phone, whatsapp_number: a.whatsapp_number });
    if (!ok) startedAt.current = null;
  };

  // opened from the list (📞 / 💬) or the phone's "add a note" alerts
  const handled = useRef(false);
  useEffect(() => {
    if (!a || handled.current) return;
    if (dial === '1' && a.phone && !a.do_not_contact) {
      handled.current = true;
      router.setParams({ dial: undefined });
      call();
    } else if (wa === '1' && !a.do_not_contact) {
      handled.current = true;
      router.setParams({ wa: undefined });
      whatsapp();
    } else if (callNote) {
      handled.current = true;
      router.setParams({ callNote: undefined });
      setContact({ channel: 'phone', deviceCallId: String(callNote) });
    } else if (thank) {
      handled.current = true;
      router.setParams({ thank: undefined });
      alumniThanksDue(a.id)
        .then((list) => {
          const lead = list.find((x) => x.lead_id === String(thank));
          if (lead) openThanks(lead);
        })
        .catch(() => undefined);
    } else if (waCall) {
      handled.current = true;
      router.setParams({ waCall: undefined });
      findWhatsAppCall(String(waCall), getDeviceId())
        .then((event) => {
          if (event) setContact({ channel: 'whatsapp', waEvent: event });
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, dial, wa, callNote, waCall, thank]);

  const contactSaved = () => {
    setContact(null);
    alumniChanged();
  };

  // --- notes: pin / delete / undo ----------------------------------------
  const pin = async (e: AlumniEvent) => {
    setMenuFor(null);
    try {
      await pinAlumniEvent(e.id, !e.pinned);
      alumniChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not pin.');
    }
  };
  const del = async (e: AlumniEvent) => {
    setMenuFor(null);
    try {
      await deleteAlumniEvent(e.id);
      setUndo({ id: e.id, at: Date.now() });
      alumniChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete.');
    }
  };
  const restore = async () => {
    if (!undo) return;
    try {
      await restoreAlumniEvent(undo.id);
      setUndo(null);
      alumniChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not bring it back.');
    }
  };
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(t);
  }, [undo]);

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
  const live = events.filter((e) => !e.deleted_at);
  const pinned = live.filter((e) => e.pinned);
  const shownEvents = live.filter((e) => !e.pinned && shownIn(e, show));
  const next = a.next_contact_at ? new Date(a.next_contact_at) : null;
  const late = !!next && next.getTime() < Date.now();

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen
        options={{
          title: a.name,
          headerRight: access.manage
            ? () => (
                <Tap
                  onPress={() => router.push(`/alumni/edit?id=${a.id}` as Href)}
                  borderless
                  label="Edit"
                  style={styles.headBtn}
                >
                  <MIcon name="edit" color={colors.textOnPrimary} />
                </Tap>
              )
            : undefined,
        }}
      />

      {/* Who (like the phone's own Contacts app) */}
      <View style={styles.hero}>
        <Avatar name={a.name} size={88} />
        <Text style={styles.name}>{a.name}</Text>
        {!!study && <InfoLine icon="school" text={study} />}
        {!!work && <InfoLine icon="work-outline" text={work} />}
        {!!place && <InfoLine icon="place" text={place} />}
        {a.do_not_contact && (
          <View style={styles.dncPill}>
            <MIcon name="do-not-disturb-on" size={16} color={md.onErrorC} />
            <Text style={styles.dnc}>Do not contact</Text>
          </View>
        )}
        {!!a.birth_date && <InfoLine icon="cake" text={birthdayText(a.birth_date)} />}
        {!!a.phone && (
          <InfoLine
            icon="phone"
            text={a.whatsapp_number && a.whatsapp_number !== a.phone ? `${a.phone} · WA ${a.whatsapp_number}` : a.phone}
          />
        )}
        <Text style={ui.muted}>Last contacted {ago(a.last_contacted_at)}</Text>
        <View style={styles.contactRow}>
          {!!a.phone && !a.do_not_contact && (
            <>
              <RoundAction icon="call" label="Call" bg={md.okC} fg={md.onOkC} onPress={call} />
              <RoundAction icon="chat" label="WhatsApp" bg={md.waC} fg={md.onWaC} onPress={whatsapp} />
              <RoundAction
                icon="auto-awesome"
                label="Message"
                bg={md.purpleC}
                fg={md.onPurpleC}
                onPress={() => setMessaging(true)}
              />
            </>
          )}
          <RoundAction
            icon="share"
            label="Share link"
            bg={md.primaryC}
            fg={md.onPrimaryC}
            onPress={() =>
              shareLink(
                `${a.name}, your own referral link for ${COLLEGE}: share it with friends who want admission.`,
                referLink(a.ref_code),
              )
            }
          />
        </View>
      </View>

      {/* ⏰ Next contact */}
      <View style={[ui.card, late && styles.lateCard]}>
        <Text style={ui.label}>⏰ NEXT CONTACT</Text>
        {next ? (
          <>
            <Text style={[styles.nextText, late && styles.lateText]}>
              {late ? '⚠ ' : ''}
              {whenText(next)}
            </Text>
            {!!a.next_contact_note && <Text style={ui.muted}>{a.next_contact_note}</Text>}
          </>
        ) : (
          <Text style={ui.muted}>None set. Set one so you get a reminder.</Text>
        )}
        <View style={styles.referRow}>
          <View style={styles.flex}>
            <Button
              title={next ? 'Change' : '⏰ Set next contact'}
              variant="secondary"
              onPress={() => setNextOpen(true)}
              fullWidth
            />
          </View>
          <View style={styles.flex}>
            <Button
              title="📝 Log a contact"
              variant="ghost"
              onPress={() => setContact({ channel: 'phone', manual: true })}
              fullWidth
            />
          </View>
        </View>
      </View>

      {/* 📝 A note (near the top: the most used) */}
      <View style={ui.card}>
        <Text style={ui.label}>📝 ADD A NOTE</Text>
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
        <AlumniVoiceButton alumniId={a.id} onSaved={alumniChanged} />
      </View>

      {/* 🙏 Say thanks: their referrals that were admitted */}
      {thanks.length > 0 && (
        <View style={[ui.card, styles.thanksCard]}>
          <Text style={ui.label}>🙏 SAY THANKS</Text>
          {thanks.map((t) => (
            <View key={t.lead_id} style={styles.refRow}>
              <View style={styles.flex}>
                <Text style={styles.refName}>{t.name}</Text>
                <Text style={ui.muted}>
                  Admitted {when(t.admitted_at)}
                  {t.course ? ` · ${t.course}` : ''}
                </Text>
              </View>
              {!a.do_not_contact && (
                <Pressable onPress={() => openThanks(t)} style={styles.pay} accessibilityRole="button">
                  <Text style={styles.payText}>💬 Thank</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {/* Numbers + refer */}
      <View style={ui.card}>
        <View style={styles.stats}>
          <Stat value={a.referrals} label="Referrals" />
          <Stat value={a.referred_leads} label="Leads" />
          <Stat value={a.referred_admitted} label="Admitted" tint={colors.success} />
          {access.manage && due > 0 && <Stat value={`৳${due}`} label="Reward due" tint={colors.warning} />}
        </View>
        <View style={styles.referRow}>
          <View style={styles.flex}>
            <Button title="📨 Add a referral" onPress={() => setReferring(true)} fullWidth />
          </View>
          <View style={styles.flex}>
            <Button
              title="🔗 Share link"
              variant="secondary"
              onPress={() =>
                shareLink(
                  `${a.name}, your own referral link for ${COLLEGE}: share it with friends who want admission.`,
                  referLink(a.ref_code),
                )
              }
              fullWidth
            />
          </View>
        </View>
        <Text style={ui.muted} onPress={() => copyLink(referLink(a.ref_code))}>
          Referral code: <Text style={styles.code}>{a.ref_code}</Text> · tap to copy the link. Friends who fill it come
          to the Referral inbox with {a.name.split(' ')[0]}’s name.
          {a.cnt_opens ? ` Link opened ${a.cnt_opens} times.` : ''}
        </Text>
        {access.manage && (
          <View style={styles.referRow}>
            <View style={styles.flex}>
              <Button title="✍️ Update link" variant="ghost" onPress={() => shareUpdateLink(false)} fullWidth />
            </View>
            <Pressable
              onPress={() =>
                ask('A new update link?', 'The old link stops working.', 'New link', () => shareUpdateLink(true))
              }
              hitSlop={8}
              accessibilityRole="button"
              style={styles.newLink}
            >
              <Text style={styles.link}>New link</Text>
            </Pressable>
          </View>
        )}
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

      <AlumnusSmsCard alumniId={a.id} />

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
        <Text style={ui.label}>HISTORY</Text>
        {undo && (
          <View style={styles.undo}>
            <Text style={styles.undoText}>🗑 Deleted</Text>
            <Pressable onPress={restore} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>↩ Undo</Text>
            </Pressable>
          </View>
        )}
        {pinned.length > 0 && (
          <View style={styles.pinned}>
            {pinned.map((e) => (
              <EventRow key={e.id} e={e} onLongPress={() => setMenuFor(e)} />
            ))}
          </View>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shows}>
          {SHOWS.map((o) => (
            <Chip key={o.key} text={o.label} on={show === o.key} onPress={() => setShow(o.key)} />
          ))}
        </ScrollView>
        {shownEvents.length === 0 && <Text style={ui.muted}>Nothing here yet.</Text>}
        {shownEvents.map((e) => (
          <EventRow key={e.id} e={e} onLongPress={() => setMenuFor(e)} />
        ))}
        {live.length > 0 && <Text style={styles.hint}>Hold a note to pin or delete it.</Text>}
      </View>

      {error && <Text style={ui.error}>{error}</Text>}
      {access.manage && <Button title="Delete" variant="ghost" onPress={remove} fullWidth />}

      {referring && <AddReferralSheet alumniId={a.id} alumniName={a.name} onClose={() => setReferring(false)} />}
      {messaging && (
        <AlumniMessageSheet
          title={`💬 Message · ${a.name}`}
          alumniId={a.id}
          defaultPurpose={a.birth_date && birthdayText(a.birth_date).startsWith('🎉') ? 'birthday' : 'refer'}
          onClose={() => setMessaging(false)}
          onSend={sendMessage}
        />
      )}
      {thanking && (
        <AlumniMessageSheet
          title={`🙏 Thanks for ${thanking.lead.name}`}
          alumniId={a.id}
          initial={thanking.text}
          purposes={['thanks']}
          defaultPurpose="thanks"
          onClose={() => setThanking(null)}
          onSend={async (text) => {
            const ok = await openWhatsApp({ phone: a.phone, whatsapp_number: a.whatsapp_number }, text);
            if (!ok) throw new Error('Could not open WhatsApp.');
            await markAlumniThanked(a.id, thanking.lead.lead_id);
            setThanking(null);
            alumniChanged();
          }}
        />
      )}
      {contact && (
        <AlumniContactSheet
          alumnus={{ id: a.id, name: a.name, phone: a.phone }}
          channel={contact.channel}
          estimatedSec={contact.estimatedSec}
          deviceCallId={contact.deviceCallId}
          waEvent={contact.waEvent}
          manual={contact.manual}
          onClose={() => setContact(null)}
          onSaved={contactSaved}
        />
      )}
      {nextOpen && (
        <NextContactSheet
          title={`Next contact · ${a.name}`}
          canClear={!!next}
          onClose={() => setNextOpen(false)}
          onSave={async (at, n) => {
            await setAlumniNextContact([a.id], at, n);
            setNextOpen(false);
            alumniChanged();
          }}
        />
      )}
      {menuFor && (
        <MenuSheet
          title={EVENT_TEXT[menuFor.kind]?.text ?? 'Entry'}
          onClose={() => setMenuFor(null)}
          items={[
            ...(menuFor.body && ['note', 'call', 'whatsapp', 'message'].includes(menuFor.kind)
              ? [
                  {
                    label: menuFor.pinned ? 'Unpin' : '📌 Pin to the top',
                    icon: 'push-pin' as MIconName,
                    onPress: () => pin(menuFor),
                  },
                ]
              : []),
            ...(canDeleteAlumniEvent(menuFor, profile?.id ?? null, access.manage)
              ? [{ label: 'Delete', icon: 'delete-outline' as MIconName, danger: true, onPress: () => del(menuFor) }]
              : []),
            ...(menuFor.body
              ? [
                  {
                    label: 'Copy the text',
                    icon: 'content-copy' as MIconName,
                    onPress: () => (setMenuFor(null), copyLink(menuFor.body ?? '')),
                  },
                ]
              : []),
          ]}
        />
      )}
    </KeyboardAwareScrollView>
  );
}

/** One line of the history (a call: its result, direction, length) */
function EventRow({ e, onLongPress }: { e: AlumniEvent; onLongPress: () => void }) {
  const isContact = CONTACT_KINDS.includes(e.kind) && !!e.outcome;
  const out = isContact ? outcomeInfo(e.outcome as string) : null;
  const dir = isContact && e.direction ? directionInfo(e.direction) : null;
  const head = isContact
    ? [
        channelLabel(e.channel, e.media) || (e.kind === 'message' ? 'SMS' : 'Call'),
        dir ? `${dir.arrow} ${dir.label}` : null,
        out ? `${out.icon} ${out.label}` : null,
        e.duration_sec ? formatDuration(e.duration_sec) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={styles.event} accessibilityHint="Hold for more">
      <Text style={styles.eventIcon}>{e.pinned ? '📌' : (EVENT_TEXT[e.kind]?.icon ?? '•')}</Text>
      <View style={styles.flex}>
        {head ? (
          <>
            <Text style={styles.eventHead}>{head}</Text>
            {!!e.body && <Text style={styles.eventText}>{e.body}</Text>}
          </>
        ) : (
          <Text style={styles.eventText}>
            {e.kind === 'note' ? e.body : (EVENT_TEXT[e.kind]?.text ?? e.kind)}
            {e.kind === 'next_contact'
              ? typeof e.data?.at === 'string'
                ? `: ${whenText(e.data.at as string)}${e.body ? ` · ${e.body}` : ''}`
                : ': removed'
              : e.kind !== 'note' && e.body
                ? `: ${e.body}`
                : ''}
          </Text>
        )}
        {typeof e.data?.file_id === 'string' && (
          <AlumniVoicePlay
            fileId={e.data.file_id}
            seconds={typeof e.data.duration_sec === 'number' ? e.data.duration_sec : null}
          />
        )}
        <Text style={ui.muted}>
          {when(e.happened_at ?? e.created_at)}
          {e.by?.full_name ? ` · ${e.by.full_name}` : ''}
          {e.source === 'phone' ? ' · from the phone' : e.source === 'whatsapp' ? ' · from WhatsApp' : ''}
        </Text>
      </View>
    </Pressable>
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
  headBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  hero: { alignItems: 'center', gap: 6, paddingVertical: spacing.md },
  name: {
    fontSize: fontSize.heading,
    fontWeight: fontWeight.bold,
    color: colors.text,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  infoLine: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  sub: { flexShrink: 1, fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  dncPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: md.errorC,
  },
  dnc: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: md.onErrorC },
  contactRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignSelf: 'stretch',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  round: { flex: 1, maxWidth: 88, alignItems: 'center', gap: 6 },
  roundBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  roundLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text, textAlign: 'center' },
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
  referRow: { flexDirection: 'row', gap: spacing.sm },
  thanksCard: { backgroundColor: md.okC },
  newLink: { justifyContent: 'center', paddingHorizontal: spacing.sm },
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
  eventHead: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  pinned: {
    gap: 2,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: md.goldC,
  },
  shows: { gap: spacing.xs, paddingVertical: spacing.xs },
  hint: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: spacing.xs },
  undo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: md.surface2,
  },
  undoText: { fontSize: fontSize.small, color: colors.text },
  nextText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  lateCard: { backgroundColor: md.warnC },
  lateText: { color: md.onWarnC },
  eventIcon: { width: 22, fontSize: 15, textAlign: 'center' },
  eventText: { fontSize: fontSize.small, color: colors.text },
});

function InfoLine({ icon, text }: { icon: MIconName; text: string }) {
  return (
    <View style={styles.infoLine}>
      <MIcon name={icon} size={16} color={colors.textMuted} />
      <Text style={styles.sub} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

function RoundAction({
  icon,
  label,
  bg,
  fg,
  onPress,
}: {
  icon: MIconName;
  label: string;
  bg: string;
  fg: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.round}>
      <Tap onPress={onPress} style={[styles.roundBtn, { backgroundColor: bg }]} label={label}>
        <MIcon name={icon} color={fg} />
      </Tap>
      <Text style={styles.roundLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {label}
      </Text>
    </View>
  );
}
