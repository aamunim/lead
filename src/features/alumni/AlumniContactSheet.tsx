import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { logAlumniContact } from '@/features/alumni/api';
import { NextContactPicker } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import {
  findDeviceCall,
  getCallById,
  getCallSyncSettings,
  getDeviceId,
  isCallLogAvailable,
  type DeviceCall,
  type WhatsAppDeviceEvent,
} from '@/features/call-sync/api';
import {
  CALL_OUTCOMES,
  directionInfo,
  formatDuration,
  outcomeFromPhone,
  outcomeInfo,
  WHATSAPP_CALL_OUTCOMES,
} from '@/features/calls/api';
import { md } from '@/features/home/md';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 📞 After a call / WhatsApp with an alumnus: what happened, a note, and
//   when to contact them next. The call itself is read from the phone
//   (length, direction) when it can be; the same call synced later from
//   the phone becomes one row (log_alumni_contact matches it).
//   Modes:
//     · after a call from the app (estimatedSec)
//     · from the "add a note" alert (deviceCallId: that call on this phone)
//     · after WhatsApp from the app, or from WhatsApp's alert (waEvent)
//     · "Log a contact" made some other way (no timing)
// =====================================================================

type Props = {
  alumnus: { id: string; name: string; phone: string | null };
  channel: 'phone' | 'whatsapp' | 'sms';
  /** about how long the user was away (after a call / WhatsApp from the app) */
  estimatedSec?: number | null;
  deviceCallId?: string | null;
  waEvent?: WhatsAppDeviceEvent | null;
  /** log a contact made some other way: the channel can be chosen */
  manual?: boolean;
  onClose: () => void;
  onSaved: () => void;
};

type Media = 'voice' | 'video' | 'message';

export function AlumniContactSheet(p: Props) {
  const [channel, setChannel] = useState(p.channel);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [direction, setDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [media, setMedia] = useState<Media | null>(p.waEvent?.media ?? null);
  const [note, setNote] = useState('');
  const [nextAt, setNextAt] = useState<Date | null>(null);
  const [nextNote, setNextNote] = useState('');
  const [deviceCall, setDeviceCall] = useState<DeviceCall | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // read the real call from the phone
  useEffect(() => {
    if (p.waEvent) {
      const e = p.waEvent;
      setMedia(e.media);
      setDirection(e.direction === 'outgoing' ? 'outgoing' : 'incoming');
      setOutcome(
        e.media === 'message'
          ? 'message'
          : e.direction === 'missed'
            ? 'missed'
            : e.connected
              ? 'connected'
              : e.direction === 'incoming'
                ? 'missed'
                : 'no_answer',
      );
      return;
    }
    if (p.channel !== 'phone' || !isCallLogAvailable) return;
    if (p.deviceCallId) {
      setLookingUp(true);
      Promise.all([getCallById(p.deviceCallId), getCallSyncSettings()])
        .then(([call, st]) => {
          if (!call) return;
          setDeviceCall(call);
          setOutcome(outcomeFromPhone(call, st.connected_min_sec));
        })
        .catch(() => undefined)
        .finally(() => setLookingUp(false));
    } else if (p.estimatedSec != null && p.alumnus.phone) {
      setLookingUp(true);
      const since = Date.now() - (p.estimatedSec + 15) * 1000;
      Promise.all([findDeviceCall(p.alumnus.phone, since), getCallSyncSettings()])
        .then(([call, st]) => {
          if (!call) return;
          setDeviceCall(call);
          setOutcome(call.durationSec >= st.connected_min_sec ? 'connected' : 'no_answer');
        })
        .catch(() => undefined)
        .finally(() => setLookingUp(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isWa = channel === 'whatsapp';
  const outcomes =
    channel === 'sms'
      ? []
      : isWa
        ? media === 'message'
          ? []
          : WHATSAPP_CALL_OUTCOMES.map((v) => outcomeInfo(v))
        : CALL_OUTCOMES;
  const needsOutcome = !(channel === 'sms' || (isWa && media === 'message'));
  const fromPhone = !!deviceCall || !!p.waEvent;
  const ready = !busy && (needsOutcome ? !!outcome : isWa ? !!media : true) && (!isWa || !!media);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = needsOutcome ? (outcome as string) : 'message';
      await logAlumniContact({
        alumniId: p.alumnus.id,
        channel,
        outcome: out,
        note: note.trim() || null,
        direction: deviceCall
          ? deviceCall.direction
          : p.waEvent
            ? p.waEvent.direction === 'outgoing'
              ? 'outgoing'
              : p.waEvent.direction === 'missed'
                ? 'missed'
                : 'incoming'
            : direction,
        media: isWa ? media : null,
        durationSec: deviceCall?.durationSec ?? (p.waEvent ? p.waEvent.durationSec : null),
        deviceId: deviceCall || p.waEvent ? getDeviceId() : null,
        deviceCallId: deviceCall ? deviceCall.id : p.waEvent ? `wa:${p.waEvent.id}` : null,
        calledAt: deviceCall?.calledAt ?? p.waEvent?.calledAt ?? null,
        nextAt: nextAt ? nextAt.toISOString() : null,
        nextNote: nextAt ? nextNote.trim() || null : null,
      });
      p.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };

  const title = p.deviceCallId
    ? `Note on the call with ${p.alumnus.name}`
    : isWa
      ? `WhatsApp with ${p.alumnus.name}`
      : channel === 'sms'
        ? `Message to ${p.alumnus.name}`
        : `Call with ${p.alumnus.name}`;

  return (
    <Modal visible transparent keyboard animationType="slide" onRequestClose={p.onClose}>
      <Pressable style={styles.backdrop} onPress={p.onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>{title}</Text>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {p.manual && (
            <View style={ui.chips}>
              <Chip text="📞 Phone call" on={channel === 'phone'} onPress={() => setChannel('phone')} />
              <Chip text="💬 WhatsApp" on={channel === 'whatsapp'} onPress={() => setChannel('whatsapp')} />
              <Chip text="✉️ SMS" on={channel === 'sms'} onPress={() => setChannel('sms')} />
            </View>
          )}

          {lookingUp && (
            <View style={styles.found}>
              <ActivityIndicator color={colors.primary} />
              <Text style={ui.muted}>Looking for the call on this phone…</Text>
            </View>
          )}
          {deviceCall && (
            <View style={styles.found}>
              <Text style={styles.foundText}>
                {directionInfo(deviceCall.direction).arrow} {directionInfo(deviceCall.direction).label}
                {deviceCall.durationSec > 0 ? ` · ${formatDuration(deviceCall.durationSec)}` : ' · not answered'}
                {deviceCall.simLabel ? ` · ${deviceCall.simLabel}` : ''}
              </Text>
            </View>
          )}

          {isWa && !p.waEvent && (
            <>
              <View style={ui.chips}>
                <Chip text="💬 Message" on={media === 'message'} onPress={() => setMedia('message')} />
                <Chip text="📞 Voice call" on={media === 'voice'} onPress={() => setMedia('voice')} />
                <Chip text="🎥 Video call" on={media === 'video'} onPress={() => setMedia('video')} />
              </View>
              <View style={ui.chips}>
                <Chip text="↗ I contacted" on={direction === 'outgoing'} onPress={() => setDirection('outgoing')} />
                <Chip text="↙ They contacted" on={direction === 'incoming'} onPress={() => setDirection('incoming')} />
              </View>
            </>
          )}
          {p.manual && channel === 'phone' && (
            <View style={ui.chips}>
              <Chip text="↗ I called" on={direction === 'outgoing'} onPress={() => setDirection('outgoing')} />
              <Chip text="↙ They called" on={direction === 'incoming'} onPress={() => setDirection('incoming')} />
            </View>
          )}

          {needsOutcome && outcomes.length > 0 && (
            <>
              <Text style={ui.label}>WHAT HAPPENED{fromPhone ? ' (FROM THE PHONE)' : ''}</Text>
              <View style={ui.chips}>
                {outcomes.map((o) => (
                  <Chip
                    key={o.value}
                    text={`${o.icon} ${o.label}`}
                    on={outcome === o.value}
                    onPress={() => setOutcome(o.value)}
                  />
                ))}
              </View>
            </>
          )}

          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Note: what was said, what they promised…"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={2000}
            style={[styles.input, styles.multi]}
          />

          <Text style={ui.label}>⏰ NEXT CONTACT</Text>
          <NextContactPicker value={nextAt} onChange={setNextAt} />
          {nextAt && (
            <TextInput
              value={nextNote}
              onChangeText={setNextNote}
              placeholder="What for? (shown in the reminder)"
              placeholderTextColor={colors.textMuted}
              maxLength={300}
              style={styles.input}
            />
          )}
          {error && <Text style={ui.error}>{error}</Text>}
        </ScrollView>
        <View style={styles.buttons}>
          <View style={styles.flex}>
            <Button title="Skip" variant="ghost" onPress={p.onClose} fullWidth />
          </View>
          <View style={styles.flex}>
            <Button title="Save" onPress={save} disabled={!ready} loading={busy} fullWidth />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '90%',
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    ...(isWeb ? { width: '100%', maxWidth: 520, alignSelf: 'center' } : {}),
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: md.outline,
    marginTop: spacing.md,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  body: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
  found: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: md.surface1,
  },
  foundText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 88, paddingTop: spacing.sm, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
});
