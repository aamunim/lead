import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { channelLabel, formatDuration, outcomeInfo } from '@/features/calls/api';
import { md } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import { addAlumniEvent, CONTACT_KINDS, EVENT_TEXT, listAlumniEvents, type AlumniEvent, type Alumnus } from './api';
import { Sheet, whenText } from './sheets';
import { alumniChanged, s as ui, when } from './ui';

// =====================================================================
// 👁 Peek: an alumnus from the list without opening the page — numbers,
//   course, next contact, the last notes and calls, a quick note, and
//   Call / WhatsApp / Next contact. One small request (the last 8 entries),
//   only when it opens.
// =====================================================================

const SHOW = 8;

export function AlumniPeekSheet({
  a,
  onClose,
  onNextContact,
  onCall,
  onWa,
}: {
  a: Alumnus;
  onClose: () => void;
  /** 📞 / 💬 without opening the page */
  onCall: () => void;
  onWa: () => void;
  /** close the peek and open "Next contact" for this alumnus */
  onNextContact: () => void;
}) {
  const [events, setEvents] = useState<AlumniEvent[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    listAlumniEvents(a.id, SHOW + 4)
      .then((list) => setEvents(list.filter((e) => !e.deleted_at).slice(0, SHOW)))
      .catch((e) => {
        setEvents([]);
        setError(e instanceof Error ? e.message : 'Could not load.');
      });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id]);

  const save = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addAlumniEvent(a.id, 'note', note.trim());
      setNote('');
      alumniChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const go = (path: string) => {
    onClose();
    router.push(path as Href);
  };

  const study = [a.course_name, a.batch_name].filter(Boolean).join(' · ');
  const work = [a.designation, a.workplace].filter(Boolean).join(', ');
  const next = a.next_contact_at ? new Date(a.next_contact_at) : null;
  const late = !!next && next.getTime() < Date.now();
  const canContact = !!a.phone && !a.do_not_contact;

  return (
    <Sheet title={a.name} onClose={onClose}>
      {/* who */}
      <View style={styles.info}>
        {a.phone ? (
          <Text style={styles.phone} selectable>
            📞 {a.phone}
            {a.whatsapp_number && a.whatsapp_number !== a.phone ? `   💬 ${a.whatsapp_number}` : ''}
          </Text>
        ) : (
          <Text style={styles.warn}>📵 No number</Text>
        )}
        {study ? <Text style={styles.text}>🎓 {study}</Text> : <Text style={styles.warn}>⚠ No course</Text>}
        {!!work && <Text style={styles.text}>💼 {work}</Text>}
        {a.do_not_contact && <Text style={styles.warn}>⛔ Do not contact</Text>}
        <Text style={[styles.text, late && styles.late]}>
          ⏰{' '}
          {next
            ? `${late ? 'Late · ' : ''}${whenText(next)}${a.next_contact_note ? ` · ${a.next_contact_note}` : ''}`
            : 'No next contact'}
        </Text>
        {(a.referrals > 0 || a.referred_admitted > 0) && (
          <Text style={styles.text}>
            📨 {a.referrals} referred · 👤 {a.referred_leads} leads · ✅ {a.referred_admitted} admitted
          </Text>
        )}
      </View>

      {/* actions */}
      <View style={styles.actions}>
        {canContact && (
          <View style={styles.flex}>
            <Button title="📞 Call" variant="secondary" onPress={onCall} fullWidth />
          </View>
        )}
        {canContact && (
          <View style={styles.flex}>
            <Button title="💬 WhatsApp" variant="secondary" onPress={onWa} fullWidth />
          </View>
        )}
        <View style={styles.flex}>
          <Button title="⏰ Next" variant="secondary" onPress={onNextContact} fullWidth />
        </View>
      </View>

      {/* a quick note */}
      <View style={styles.noteRow}>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Add a note…"
          placeholderTextColor={colors.textMuted}
          style={styles.noteInput}
          multiline
          maxLength={2000}
          accessibilityLabel="Note"
        />
        <Button title="Save" onPress={save} loading={busy} disabled={!note.trim()} />
      </View>
      {error && <Text style={ui.error}>{error}</Text>}

      {/* the last notes and contacts */}
      <Text style={ui.label}>LATEST</Text>
      {events === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : events.length === 0 ? (
        <Text style={ui.muted}>Nothing yet.</Text>
      ) : (
        events.map((e) => <Line key={e.id} e={e} />)
      )}

      <Button title="Open the full page ›" variant="ghost" onPress={() => go(`/alumni/${a.id}`)} fullWidth />
    </Sheet>
  );
}

function Line({ e }: { e: AlumniEvent }) {
  const contact = CONTACT_KINDS.includes(e.kind) && !!e.outcome;
  const out = contact ? outcomeInfo(e.outcome as string) : null;
  const head = contact
    ? [
        channelLabel(e.channel, e.media) || (e.kind === 'message' ? 'SMS' : 'Call'),
        out ? `${out.icon} ${out.label}` : null,
        e.duration_sec ? formatDuration(e.duration_sec) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : e.kind === 'note'
      ? null
      : (EVENT_TEXT[e.kind]?.text ?? e.kind);
  return (
    <View style={styles.line}>
      <Text style={styles.icon}>{e.pinned ? '📌' : (EVENT_TEXT[e.kind]?.icon ?? '•')}</Text>
      <View style={styles.flex}>
        {!!head && <Text style={styles.head}>{head}</Text>}
        {!!e.body && <Text style={styles.text}>{e.body}</Text>}
        <Text style={ui.muted}>
          {when(e.happened_at ?? e.created_at)}
          {e.by?.full_name ? ` · ${e.by.full_name}` : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  info: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: md.surface1 },
  phone: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  text: { fontSize: fontSize.small, color: colors.text },
  warn: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },
  late: { color: colors.danger, fontWeight: fontWeight.semibold },
  actions: { flexDirection: 'row', gap: spacing.sm },
  noteRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  noteInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
  line: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 4 },
  icon: { width: 22, fontSize: fontSize.body },
  head: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
});
