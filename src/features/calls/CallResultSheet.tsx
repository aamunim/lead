import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

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
  addNoteToPhoneCall,
  addNoteToWhatsAppCall,
  CALL_OUTCOMES,
  directionInfo,
  formatDuration,
  logCall,
  outcomeFromPhone,
  outcomeInfo,
  outcomeOfWhatsApp,
  WHATSAPP_CALL_OUTCOMES,
  type AnyOutcome,
  type CallChannel,
  type CallOutcome,
  type WhatsAppMedia,
} from '@/features/calls/api';
import { cancelFollowUp, followUpPresets, formatDue, scheduleFollowUp } from '@/features/follow-ups/api';
import { updateLead, type Rating } from '@/features/leads/api';
import { reopenLead } from '@/features/pipeline/api';
import { listHolidays, type Holiday } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { TextField } from '@/shared/ui/TextField';
import { VoiceNoteButton } from '@/features/voice/VoiceNote';

const RATINGS: { value: Rating; label: string; color: string }[] = [
  { value: 'hot', label: 'Hot', color: colors.hot },
  { value: 'warm', label: 'Warm', color: colors.warm },
  { value: 'cold', label: 'Cold', color: colors.cold },
];

const NO_FOLLOW_UP = 'none';
const CUSTOM = 'custom';

/** Which follow-up to pick by default after each kind of call */
function defaultFollowUp(outcome: CallOutcome, keys: string[]): string {
  switch (outcome) {
    case 'wrong_number':
      return NO_FOLLOW_UP;
    case 'call_back':
    case 'busy':
    case 'no_answer':
      return keys.includes('2h') ? '2h' : 'tomorrow';
    case 'switched_off':
      return 'tomorrow';
    case 'connected':
    default:
      return '3d';
  }
}

// --- holidays ----------------------------------------------------------
/** 2026-10-25 style key in the phone's own time */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Returns a function that says whether a day falls inside any holiday */
function makeHolidayChecker(holidays: Holiday[]) {
  return (d: Date) => {
    const key = dayKey(d);
    return holidays.some((h) => h.start_date <= key && key <= h.end_date);
  };
}

function holidayName(holidays: Holiday[], d: Date): string | null {
  const key = dayKey(d);
  return holidays.find((h) => h.start_date <= key && key <= h.end_date)?.name ?? null;
}

type Props = {
  visible: boolean;
  lead: { id: string; name: string; phone: string | null; rating: string | null };
  /** About how long the user was away in the phone app (seconds), if known */
  estimatedSec?: number | null;
  /**
   * Opened from the "add a note" notification: the call-log id of that call.
   * The sheet then only asks for a note and rating (the call itself is already known).
   */
  deviceCallId?: string | null;
  /** 💬 After WhatsApp: message or call, sent or received (default: phone call) */
  channel?: CallChannel;
  /**
   * 💬 Opened from the WhatsApp "add a note" notification: the call WhatsApp
   * already showed (time, length). Only note, rating and next call are asked.
   */
  waEvent?: WhatsAppDeviceEvent | null;
  onClose: () => void;
  onSaved: () => void;
};

const WA_MEDIA: { value: WhatsAppMedia; label: string; icon: string }[] = [
  { value: 'message', label: 'Message', icon: '💬' },
  { value: 'voice', label: 'Voice call', icon: '📞' },
  { value: 'video', label: 'Video call', icon: '🎥' },
];

export function CallResultSheet({
  visible,
  lead,
  estimatedSec,
  deviceCallId,
  channel = 'phone',
  waEvent = null,
  onClose,
  onSaved,
}: Props) {
  const isWa = channel === 'whatsapp' || !!waEvent;
  const [waMedia, setWaMedia] = useState<WhatsAppMedia | null>(null);
  const [waDirection, setWaDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [rating, setRating] = useState<Rating | null>((lead.rating as Rating | null) ?? null);
  const [followUpKey, setFollowUpKey] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState<Date | null>(null);
  const [showFollowUp, setShowFollowUp] = useState(false); // auto mode: hidden until asked
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The real call from the phone's call log (dev build / APK only)
  const [deviceCall, setDeviceCall] = useState<DeviceCall | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  /** Note mode (from the notification): the result shown for that call */
  const [noteOutcome, setNoteOutcome] = useState<AnyOutcome | null>(null);
  const [connectedMinSec, setConnectedMinSec] = useState(5);
  const [notFound, setNotFound] = useState(false);

  /** Opened from the notification: only Note + Rating (+ optional next call) */
  const noteMode = !!deviceCallId;

  /** open / won / lost / cancelled: a lost lead that talks to us may be interested again */
  const [stageKind, setStageKind] = useState<string>('open');

  /** Found on the phone → result, length and SIM come from there */
  const auto = !!deviceCall;

  // Quick follow-up choices; dates move past holidays
  const presets = useMemo(
    () => (visible ? followUpPresets(new Date(), makeHolidayChecker(holidays)) : []),
    [visible, holidays],
  );
  const presetKeys = presets.map((p) => p.key);

  const chooseMedia = (value: WhatsAppMedia) => {
    setWaMedia(value);
    setError(null);
    if (value === 'message') {
      setOutcome(null);
      setFollowUpKey((current) => (current === CUSTOM ? current : defaultFollowUp('connected', presetKeys)));
    }
  };

  const chooseOutcome = (value: CallOutcome) => {
    setOutcome(value);
    setError(null);
    // Suggest a follow-up; the user can change it (keep a date they picked themselves)
    setFollowUpKey((current) => (current === CUSTOM ? current : defaultFollowUp(value, presetKeys)));
  };

  // Start fresh every time the sheet opens; load holidays; look up the real call
  useEffect(() => {
    if (!visible) return;
    setOutcome(null);
    setWaMedia(null);
    setWaDirection('outgoing');
    setNotes('');
    setRating((lead.rating as Rating | null) ?? null);
    setFollowUpKey(null);
    setCustomDate(null);
    setShowFollowUp(false);
    setError(null);
    setDeviceCall(null);
    setNoteOutcome(null);
    setNotFound(false);
    setStageKind('open');

    // Is the lead closed? (Admitted / Lost / Cancelled)
    supabase
      .from('leads')
      .select('stage:pipeline_stages(kind)')
      .eq('id', lead.id)
      .maybeSingle()
      .then(({ data }) => {
        const kind = (data as unknown as { stage: { kind: string } | null } | null)?.stage?.kind;
        setStageKind(kind ?? 'open');
      });

    const year = new Date().getFullYear();
    Promise.all([listHolidays(year), listHolidays(year + 1)])
      .then(([a, b]) => setHolidays([...a, ...b]))
      .catch(() => setHolidays([])); // without holidays the dates still work

    // From the notification: read that exact call from the phone
    if (isWa) {
      // WhatsApp: nothing on the phone's call log to look up
    } else if (deviceCallId) {
      setLookingUp(true);
      Promise.all([getCallById(deviceCallId), getCallSyncSettings()])
        .then(([call, settings]) => {
          setConnectedMinSec(settings.connected_min_sec);
          if (!call) {
            setNotFound(true);
            return;
          }
          setDeviceCall(call);
          setNoteOutcome(outcomeFromPhone(call, settings.connected_min_sec));
        })
        .catch(() => setNotFound(true))
        .finally(() => setLookingUp(false));
    }
    // Only right after a call from the app (not "log a call made from another phone")
    else if (isCallLogAvailable && estimatedSec != null) {
      const sinceMs = Date.now() - (estimatedSec + 15) * 1000;
      setLookingUp(true);
      Promise.all([
        lead.phone ? findDeviceCall(lead.phone, sinceMs) : Promise.resolve(null),
        getCallSyncSettings(),
      ])
        .then(([call, settings]) => {
          if (!call) return;
          setDeviceCall(call);
          // The result comes from the real call
          const result: CallOutcome =
            call.durationSec >= settings.connected_min_sec ? 'connected' : 'no_answer';
          setOutcome(result);
          setFollowUpKey(null); // in auto mode no follow-up unless the user asks
        })
        .catch(() => undefined)
        .finally(() => setLookingUp(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, lead.rating, deviceCallId, isWa]);

  // Duration: the phone's real one, else our estimate (only for Connected)
  const realDuration = deviceCall?.durationSec ?? null;
  const estimated = outcome === 'connected' ? estimatedSec ?? null : null;

  // The follow-up date that will be saved (null = none)
  const chosenDate: Date | null =
    followUpKey === CUSTOM ? customDate : presets.find((p) => p.key === followUpKey)?.date ?? null;

  const chosenHoliday = chosenDate ? holidayName(holidays, chosenDate) : null;

  // --- after saving: a lost lead we talked to → offer to reopen it --------
  const finish = (talked: boolean) => {
    if (stageKind !== 'lost' || !talked) {
      onSaved();
      return;
    }
    Alert.alert(
      'Reopen this lead?',
      `${lead.name} was marked lost. You talked just now: move them back to Interested?`,
      [
        { text: 'Not now', style: 'cancel', onPress: onSaved },
        {
          text: 'Reopen',
          onPress: async () => {
            try {
              await reopenLead(lead.id, null, 'Talked on a call');
            } catch (e) {
              Alert.alert('Could not reopen', e instanceof Error ? e.message : '');
            }
            onSaved();
          },
        },
      ],
      { cancelable: false },
    );
  };

  // --- save in note mode (from the notification) ------------------------
  const handleSaveNote = async () => {
    if (!deviceCall) return;
    const deviceId = getDeviceId();
    if (!deviceId) {
      setError('Could not read this phone. Please try again.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 1. The note goes on the call itself (synced first if possible)
      await addNoteToPhoneCall({
        leadId: lead.id,
        deviceId,
        call: deviceCall,
        notes,
        connectedMinSec,
      });

      // 2. Next follow-up, only if the user opened that part and chose one
      if (chosenDate) {
        await scheduleFollowUp(lead.id, chosenDate, notes);
      } else if (followUpKey === NO_FOLLOW_UP) {
        await cancelFollowUp(lead.id);
      }

      // 3. Rating, only if it changed
      if (rating !== ((lead.rating as Rating | null) ?? null)) {
        await updateLead(lead.id, { name: lead.name, rating });
      }

      finish(noteOutcome === 'connected');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  };

  // --- save after WhatsApp ------------------------------------------------
  const handleSaveWhatsAppEvent = async (event: WhatsAppDeviceEvent) => {
    const deviceId = getDeviceId();
    if (!deviceId) {
      setError('Could not read this phone. Please try again.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addNoteToWhatsAppCall({ leadId: lead.id, deviceId, event, notes });

      if (chosenDate) {
        await scheduleFollowUp(lead.id, chosenDate, notes);
      } else if (followUpKey === NO_FOLLOW_UP) {
        await cancelFollowUp(lead.id);
      }

      if (rating !== ((lead.rating as Rating | null) ?? null)) {
        await updateLead(lead.id, { name: lead.name, rating });
      }

      finish(outcomeOfWhatsApp(event) === 'connected');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWhatsApp = async () => {
    if (waEvent) return handleSaveWhatsAppEvent(waEvent);
    if (!waMedia) {
      setError('Please choose: message, voice call or video call.');
      return;
    }
    const result: AnyOutcome | null = waMedia === 'message' ? 'message' : outcome;
    if (!result) {
      setError('Please choose what happened on the call.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await logCall({
        leadId: lead.id,
        outcome: result,
        notes,
        durationSec: result === 'connected' ? estimatedSec ?? null : null,
        direction: waDirection,
        channel: 'whatsapp',
        media: waMedia,
      });

      if (chosenDate) {
        await scheduleFollowUp(lead.id, chosenDate, notes);
      } else if (followUpKey === NO_FOLLOW_UP) {
        await cancelFollowUp(lead.id);
      }

      if (rating !== ((lead.rating as Rating | null) ?? null)) {
        await updateLead(lead.id, { name: lead.name, rating });
      }

      finish(result === 'connected' || (result === 'message' && waDirection === 'incoming'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (noteMode) return handleSaveNote();
    if (isWa) return handleSaveWhatsApp();
    if (!outcome) {
      setError('Please choose what happened on the call.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 1. Save the call (the database also closes today's follow-up)
      await logCall({
        leadId: lead.id,
        outcome,
        notes,
        durationSec: realDuration ?? estimated,
        ...(deviceCall
          ? {
              calledAt: deviceCall.calledAt,
              direction: deviceCall.direction,
              deviceId: getDeviceId(),
              deviceCallId: deviceCall.id,
              simLabel: deviceCall.simLabel,
            }
          : {}),
      });

      // 2. Next follow-up (only if one was chosen)
      if (chosenDate) {
        await scheduleFollowUp(lead.id, chosenDate, notes);
      } else if (followUpKey === NO_FOLLOW_UP) {
        await cancelFollowUp(lead.id);
      }

      // 3. Rating, only if it changed
      if (rating !== ((lead.rating as Rating | null) ?? null)) {
        await updateLead(lead.id, { name: lead.name, rating });
      }

      finish(outcome === 'connected');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the call.');
    } finally {
      setSaving(false);
    }
  };

  // --- pieces ---------------------------------------------------------------
  const ratingField = (
    <View style={styles.field}>
      <Text style={styles.label}>Rating</Text>
      <View style={styles.chips}>
        {RATINGS.map((r) => {
          const on = rating === r.value;
          return (
            <Pressable
              key={r.value}
              onPress={() => setRating(on ? null : r.value)}
              style={[styles.chip, on && { backgroundColor: r.color, borderColor: r.color }]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[styles.chipText, on && styles.textOn]}>{r.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const noteField = (
    <View style={styles.field}>
      <TextField label="Note" value={notes} onChangeText={setNotes} multiline placeholder="What did they say?" />
      <VoiceNoteButton leadId={lead?.id} context="call" />
    </View>
  );

  const followUpField = (
    <View style={styles.field}>
      <Text style={styles.label}>Next call</Text>
      <View style={styles.chips}>
        {presets.map((p) => {
          const on = followUpKey === p.key;
          return (
            <Pressable
              key={p.key}
              onPress={() => setFollowUpKey(on && auto ? null : p.key)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[styles.chipText, on && styles.textOn]}>{p.label}</Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => setFollowUpKey(followUpKey === NO_FOLLOW_UP && auto ? null : NO_FOLLOW_UP)}
          style={[styles.chip, followUpKey === NO_FOLLOW_UP && styles.chipOff]}
          accessibilityRole="radio"
          accessibilityState={{ checked: followUpKey === NO_FOLLOW_UP }}
        >
          <Text style={[styles.chipText, followUpKey === NO_FOLLOW_UP && styles.textOn]}>No more calls</Text>
        </Pressable>
      </View>

      <DateTimePickerButton
        title={followUpKey === CUSTOM && customDate ? '📅 Change date & time' : '📅 Pick date & time'}
        initial={customDate ?? undefined}
        onPick={(d) => {
          setCustomDate(d);
          setFollowUpKey(CUSTOM);
        }}
      />

      <Text style={[styles.hint, followUpKey === CUSTOM && styles.hintStrong]}>
        {chosenDate
          ? `Reminder: ${formatDue(chosenDate)}`
          : followUpKey === NO_FOLLOW_UP
            ? 'No follow-up will be set for this lead.'
            : auto
              ? 'No change to the next call.'
              : 'Choose when to call next.'}
      </Text>

      {chosenHoliday && <Text style={styles.warn}>⚠️ That day is a holiday ({chosenHoliday}).</Text>}
      {holidays.length > 0 && followUpKey !== CUSTOM && (
        <Text style={styles.hint}>Quick choices skip holidays automatically.</Text>
      )}
    </View>
  );

  // --- render -------------------------------------------------------------
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior="padding"
      >
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View>
              <Text style={styles.title}>
                {waEvent
                  ? 'Add a note'
                  : isWa
                  ? 'What happened on WhatsApp?'
                  : noteMode
                    ? 'Add a note'
                    : auto
                      ? 'Call saved from your phone'
                      : 'How did the call go?'}
              </Text>
              <Text style={styles.subtitle}>
                {lead.name}
                {lead.phone ? ` · ${lead.phone}` : ''}
              </Text>
              {stageKind === 'won' && <Text style={styles.closedWon}>🎓 Admitted student</Text>}
              {stageKind === 'lost' && (
                <Text style={styles.closedLost}>
                  ✕ Lost lead · if they’re interested again, you can reopen it after saving
                </Text>
              )}
              {stageKind === 'cancelled' && <Text style={styles.closedMuted}>↩ Admission was cancelled</Text>}
            </View>

            {waEvent ? (
              <>
                {/* 💬 The call as WhatsApp showed it */}
                <WhatsAppResult event={waEvent} />
                {noteField}
                {ratingField}
                {showFollowUp ? (
                  followUpField
                ) : (
                  <Pressable onPress={() => setShowFollowUp(true)} hitSlop={8} accessibilityRole="button">
                    <Text style={styles.link}>＋ Set next call</Text>
                  </Pressable>
                )}
              </>
            ) : isWa ? (
              <>
                {/* 💬 WhatsApp: what it was, and which way */}
                <View style={styles.grid}>
                  {WA_MEDIA.map((m) => {
                    const on = waMedia === m.value;
                    return (
                      <Pressable
                        key={m.value}
                        onPress={() => chooseMedia(m.value)}
                        style={[styles.outcome, on && styles.waOn]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                      >
                        <Text style={styles.outcomeIcon}>{m.icon}</Text>
                        <Text style={[styles.outcomeText, on && styles.textOn]}>{m.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={styles.chips}>
                  {(['outgoing', 'incoming'] as const).map((d) => {
                    const on = waDirection === d;
                    const label =
                      waMedia === 'message'
                        ? d === 'outgoing'
                          ? '↗ I sent'
                          : '↙ They sent'
                        : d === 'outgoing'
                          ? '↗ I called'
                          : '↙ They called';
                    return (
                      <Pressable
                        key={d}
                        onPress={() => setWaDirection(d)}
                        style={[styles.chip, on && styles.chipOn]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                      >
                        <Text style={[styles.chipText, on && styles.textOn]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                {waMedia && waMedia !== 'message' && (
                  <>
                    {estimatedSec != null && estimatedSec > 0 && (
                      <Text style={styles.hint}>Time on WhatsApp (about): {formatDuration(estimatedSec)}</Text>
                    )}
                    <View style={styles.grid}>
                      {CALL_OUTCOMES.filter((o) => WHATSAPP_CALL_OUTCOMES.includes(o.value)).map((o) => {
                        const on = outcome === o.value;
                        return (
                          <Pressable
                            key={o.value}
                            onPress={() => chooseOutcome(o.value)}
                            style={[styles.outcome, on && { backgroundColor: o.color, borderColor: o.color }]}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                          >
                            <Text style={styles.outcomeIcon}>{o.icon}</Text>
                            <Text style={[styles.outcomeText, on && styles.textOn]}>{o.label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}

                {(waMedia === 'message' || outcome) && followUpField}
                {ratingField}
                {noteField}
              </>
            ) : lookingUp ? (
              <View style={styles.lookingUp}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.hint}>Checking the call on your phone…</Text>
              </View>
            ) : noteMode ? (
              notFound || !deviceCall || !noteOutcome ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>
                    This call was not found on your phone. It may have been deleted from the call log.
                  </Text>
                </View>
              ) : (
                <>
                  {/* The call from the notification */}
                  <AutoResult call={deviceCall} outcome={noteOutcome} />

                  {noteField}
                  {ratingField}

                  {showFollowUp ? (
                    followUpField
                  ) : (
                    <Pressable onPress={() => setShowFollowUp(true)} hitSlop={8} accessibilityRole="button">
                      <Text style={styles.link}>＋ Set next call</Text>
                    </Pressable>
                  )}
                </>
              )
            ) : auto && deviceCall && outcome ? (
              <>
                {/* Result taken from the phone */}
                <AutoResult call={deviceCall} outcome={outcome} />

                {noteField}
                {ratingField}

                {showFollowUp ? (
                  followUpField
                ) : (
                  <Pressable onPress={() => setShowFollowUp(true)} hitSlop={8} accessibilityRole="button">
                    <Text style={styles.link}>＋ Set next call</Text>
                  </Pressable>
                )}
              </>
            ) : (
              <>
                {/* Not found on the phone: choose the result by hand */}
                {estimated != null && estimated > 0 && (
                  <Text style={styles.hint}>Call time (about): {formatDuration(estimated)}</Text>
                )}

                <View style={styles.grid}>
                  {CALL_OUTCOMES.map((o) => {
                    const on = outcome === o.value;
                    return (
                      <Pressable
                        key={o.value}
                        onPress={() => chooseOutcome(o.value)}
                        style={[styles.outcome, on && { backgroundColor: o.color, borderColor: o.color }]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                      >
                        <Text style={styles.outcomeIcon}>{o.icon}</Text>
                        <Text style={[styles.outcomeText, on && styles.textOn]}>{o.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                {outcome && followUpField}
                {ratingField}
                {noteField}
              </>
            )}

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {!(noteMode && (notFound || !deviceCall)) || lookingUp ? (
              <>
                <Button
                  title="Save"
                  onPress={handleSave}
                  loading={saving}
                  disabled={lookingUp}
                  fullWidth
                />
                <Button title="Skip" variant="ghost" onPress={onClose} fullWidth />
              </>
            ) : (
              <Button title="Close" variant="ghost" onPress={onClose} fullWidth />
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// =====================================================================
// A WhatsApp call read from WhatsApp's notifications
// =====================================================================
function WhatsAppResult({ event }: { event: WhatsAppDeviceEvent }) {
  const info = outcomeInfo(outcomeOfWhatsApp(event));
  const dir = directionInfo(event.direction);
  const time = new Date(event.calledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const kind = event.media === 'video' ? 'WhatsApp video call' : 'WhatsApp call';
  const length = event.connected && event.durationSec > 0 ? ` · ${formatDuration(event.durationSec)}` : '';
  return (
    <View style={styles.autoCard}>
      <Text style={[styles.autoTitle, { color: info.color }]}>
        💬 {kind} · {dir.label} · {info.label}
        {length}
      </Text>
      <Text style={styles.hint}>{time} · saved from WhatsApp</Text>
    </View>
  );
}

// =====================================================================
// The result card in automatic mode
// =====================================================================
function AutoResult({ call, outcome }: { call: DeviceCall; outcome: AnyOutcome }) {
  const info = outcomeInfo(outcome);
  const dir = directionInfo(call.direction);
  const time = new Date(call.calledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <View style={[styles.autoCard, { borderColor: info.color }]}>
      <View style={[styles.autoIcon, { backgroundColor: info.color + '1F' }]}>
        <Text style={[styles.autoArrow, { color: dir.color }]}>{dir.arrow}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={[styles.autoTitle, { color: info.color }]}>{info.label}</Text>
        <Text style={styles.autoText}>
          {call.durationSec > 0 ? formatDuration(call.durationSec) : '0 sec'} · {time}
          {call.simLabel ? ` · ${call.simLabel}` : ''}
        </Text>
      </View>
      <Text style={styles.fromPhone}>📱 auto</Text>
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
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  closedWon: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.success, marginTop: 4 },
  closedLost: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.danger, marginTop: 4 },
  closedMuted: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted, marginTop: 4 },
  lookingUp: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },

  autoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    backgroundColor: colors.surface,
  },
  autoIcon: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  autoArrow: { fontSize: 20, fontWeight: fontWeight.bold },
  autoTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold },
  autoText: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  fromPhone: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.success },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  outcome: {
    width: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  outcomeIcon: { fontSize: 18 },
  outcomeText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },
  waOn: { backgroundColor: '#1F7A57', borderColor: '#1F7A57' },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  hintStrong: { color: colors.primary, fontWeight: fontWeight.bold },
  warn: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.warning },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipOff: { backgroundColor: colors.textMuted, borderColor: colors.textMuted },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});