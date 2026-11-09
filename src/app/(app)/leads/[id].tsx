import { LeadReferrer } from '@/features/alumni/LeadReferrer';
import { LeadSchoolAlumni } from '@/features/alumni/LeadSchoolAlumni';
import { LeadScoreRow, showScore, useScoreOn, type ScoreReason } from '@/features/leads/score';
import { router, Stack, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { myStars, toggleStar } from '@/features/leads/find';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { getCallSyncSettings, getDeviceId, markCallFromApp, type WhatsAppDeviceEvent } from '@/features/call-sync/api';
import { CallResultSheet } from '@/features/calls/CallResultSheet';
import { confirmCall } from '@/features/calls/doubleCall';
import { contactLabel, openWhatsApp, whatsAppOnly } from '@/features/leads/contact';
import type { TemplateChannel } from '@/features/templates/api';
import { TemplateSheet } from '@/features/templates/TemplateSheet';
import { useTemplateAccess } from '@/features/templates/useTemplateAccess';
import {
  canDeleteEntry,
  channelLabel,
  deleteCall,
  deleteCallNote,
  directionInfo,
  findWhatsAppCall,
  formatDuration,
  isHandWritten,
  listLeadCalls,
  outcomeInfo,
  restoreDeleted,
  type CallChannel,
  type CallLog,
} from '@/features/calls/api';
import {
  cancelFollowUp,
  followUpPresets,
  formatDue,
  getPendingFollowUp,
  isOverdue,
  scheduleFollowUp,
  type FollowUp,
} from '@/features/follow-ups/api';
import {
  deleteLeadNote,
  getLead,
  listAssignableUsers,
  listLeadActivity,
  softDeleteLead,
  type ActivityItem,
  type LeadDetail,
} from '@/features/leads/api';
import { splitLeadNotes, type LeadNote } from '@/features/leads/notes';
import { EVENT_LABELS, feeBadge, money } from '@/features/fees/api';
import { Fold, MIcon, md, type MIconName } from '@/features/home/md';
import { LeadQuickSheet } from '@/features/leads/LeadQuickSheet';
import type { LeadListItem } from '@/features/leads/api';
import { stageBadge } from '@/features/approval/api';
import { FeeCard } from '@/features/fees/FeeCard';
import { FilesCard } from '@/features/files/FilesCard';
import { PapersCard } from '@/features/papers/PapersCard';
import { PipelineCard } from '@/features/pipeline/PipelineCard';
import { formatVisitTime } from '@/features/visits/api';
import { VisitCard } from '@/features/visits/VisitCard';
import { listHolidays, listItems, type Holiday } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';
import { VoicePlayer } from '@/features/voice/VoiceNote';
import { VOICE_CONTEXT, clock } from '@/features/voice/format';
import type { PlayableFile } from '@/features/voice/VoicePlayerSheet';
import { deleteLeadFile, isRecordedVoice, listLeadFiles, type LeadFile } from '@/features/files/api';
import { onVoiceSaved } from '@/features/voice/useVoiceNotes';
import { isWeb } from '@/features/web/api';
import { WebStudentLayout } from '@/features/web/student/WebStudentLayout';
import { ChanceCard } from '@/features/aiChance/ChanceCard';
import { getAlumnus } from '@/features/alumni/api';
import { ReturnToBankSheet } from '@/features/bank/ReturnToBankSheet';
import { supabase } from '@/shared/lib/supabase';
import { AdmissionCreditCard } from '@/features/aiCredit/AdmissionCreditCard';
import { ApprovalCard } from '@/features/approval/ApprovalCard';
import { peekMemo, remember } from '@/shared/lib/memo';

const RATING_COLOR: Record<string, string> = {
  hot: colors.hot,
  warm: colors.warm,
  cold: colors.cold,
};

/** One line in "Calls & notes" */
type FeedItem =
  | { kind: 'call'; key: string; at: string; call: CallLog }
  | { kind: 'note'; key: string; at: string; note: LeadNote }
  /** 🎙 A voice note not tied to a call (note, hand over, fee, visit, …) */
  | { kind: 'voice'; key: string; at: string; voice: LeadFile };

/** When a note was written: exact time, only the day, or none (typed on the edit screen) */
function noteWhen(n: LeadNote): string {
  if (n.when === 'exact') return formatDateTime(n.at);
  if (n.when === 'day')
    return new Date(n.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return 'Lead notes';
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

/** 2026-10-25 style key in the phone's own time */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function LeadDetailScreen() {
  useScoreOn(); // 🔥 admission chance on/off
  // callNote = a call-log id, when opened from the "add a note" notification
  // waCall = a WhatsApp call id, from the WhatsApp "add a note" notification
  // dial = call the lead as soon as the page is open (Home → Next calls → 📞)
  const { id, callNote, waCall, dial } = useLocalSearchParams<{
    id: string;
    callNote?: string;
    waCall?: string;
    dial?: string;
  }>();
  return <LeadDetailView id={id} callNote={callNote} waCall={waCall} dial={dial === '1'} />;
}

/**
 * The lead page. 🌐 On the website it is also shown in a panel next to the
 * Students table (embedded: no screen header; onClosed after a delete).
 */
export function LeadDetailView({
  id,
  callNote,
  waCall,
  dial = false,
  embedded = false,
  onClosed,
}: {
  id: string;
  callNote?: string;
  waCall?: string;
  dial?: boolean;
  embedded?: boolean;
  onClosed?: () => void;
}) {
  const { hasPermission, profile } = useAuth();
  const isAdmin = hasPermission('leads.edit_all');
  // 🌐 Website on a computer screen: its own layout (panel next to the table, or the full page)
  const { width: winWidth } = useWindowDimensions();
  const webLayout: 'panel' | 'full' | null = isWeb && winWidth >= 900 ? (embedded ? 'panel' : 'full') : null;
  // 💬 Message templates (Settings → Message templates)
  const templates = useTemplateAccess();
  const tapOpensTemplates = templates.allowed && templates.settings.tap === 'sheet';
  const [templateChannel, setTemplateChannel] = useState<TemplateChannel | null>(null);
  const me = profile?.id ?? null;

  // ⚡ a lead seen a moment ago shows at once (then refreshes)
  const [lead, setLead] = useState<LeadDetail | null>(() => (id ? (peekMemo<LeadDetail>(`lead:${id}`) ?? null) : null));
  const [filesTick, setFilesTick] = useState(0);
  // ▶ The voice note being played (from the timeline)
  const [playing, setPlaying] = useState<PlayableFile | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>(() =>
    id ? (peekMemo<ActivityItem[]>(`lead-activity:${id}`) ?? []) : [],
  );
  const [calls, setCalls] = useState<CallLog[]>(() => (id ? (peekMemo<CallLog[]>(`lead-calls:${id}`) ?? []) : []));
  // 🎙 Voice notes (recorded with the 🎙 buttons): shown in Calls & notes
  const [voices, setVoices] = useState<LeadFile[]>([]);
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [stageNames, setStageNames] = useState<Map<string, string>>(new Map());
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(() => !(id && peekMemo(`lead:${id}`)));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow-up card
  const [choosingFollowUp, setChoosingFollowUp] = useState(false);
  const [savingFollowUp, setSavingFollowUp] = useState(false);

  // Call popup
  const [sheetVisible, setSheetVisible] = useState(false);
  const [estimatedSec, setEstimatedSec] = useState<number | null>(null);
  const callStartedAt = useRef<number | null>(null); // when the user tapped Call
  const leftApp = useRef(false); // did the phone app actually open?
  const [noteCallId, setNoteCallId] = useState<string | null>(null); // from a notification
  // 📞 phone call or 💬 WhatsApp: which one the popup asks about
  const [sheetChannel, setSheetChannel] = useState<CallChannel>('phone');
  const pendingChannel = useRef<CallChannel>('phone');
  const [askAfterWhatsApp, setAskAfterWhatsApp] = useState(true);
  const [waEvent, setWaEvent] = useState<WhatsAppDeviceEvent | null>(null);

  useEffect(() => {
    getCallSyncSettings()
      .then((s) => setAskAfterWhatsApp(s.whatsapp_ask_after))
      .catch(() => undefined);
  }, []);

  // Short message after a pipeline change (admitted, lost, moved…)
  // 🗑 After a delete: "Undo" for a few seconds
  const [undo, setUndo] = useState<{ activityId: string; label: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 🏦 back to the Lead Bank (admins)
  const [banking, setBanking] = useState(false);
  // 📱 Phone page: the top bar shows the name once the header has scrolled away; the note sheet
  const [compactBar, setCompactBar] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const loadVoices = useCallback(() => {
    if (!id) return;
    listLeadFiles(id)
      .then((files) => setVoices(files.filter(isRecordedVoice)))
      .catch(() => setVoices([]));
  }, [id]);

  // A voice note saved from any sheet on this page: show it at once
  useEffect(() => onVoiceSaved((leadId) => leadId === id && loadVoices()), [id, loadVoices]);

  // ⭐ my star
  const [starred, setStarred] = useState(false);
  useEffect(() => {
    if (!id) return;
    myStars()
      .then((m) => setStarred(m.has(id)))
      .catch(() => undefined);
  }, [id]);
  const flipStar = () => {
    if (!id) return;
    setStarred((v) => !v);
    toggleStar(id)
      .then((on) => {
        setStarred(on);
        showToast(on ? '⭐ Starred: Leads → ⭐ Starred' : 'Star removed');
      })
      .catch((e) => {
        setStarred((v) => !v);
        showToast(e instanceof Error ? e.message : 'Could not change the star.');
      });
  };

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const year = new Date().getFullYear();
      // ⚡ The lead shows as soon as it arrives; the timeline fills in after.
      //   Stages, people and holidays are remembered (they rarely change).
      const leadP = getLead(id);
      const restP = Promise.all([
        listLeadActivity(id),
        listLeadCalls(id),
        getPendingFollowUp(id),
        listItems('pipeline_stages', { includeInactive: true }),
        // Include deactivated users so old timeline entries still show real names
        listAssignableUsers({ includeInactive: true }),
        listHolidays(year).catch(() => []),
        listHolidays(year + 1).catch(() => []),
      ]);
      restP.catch(() => undefined); // its error is shown below, not as "unhandled"
      loadVoices();
      const l = await leadP;
      setLead(l);
      if (l) remember(`lead:${id}`, l);
      setLoading(false);
      const [a, c, f, stages, users, h1, h2] = await restP;
      setActivity(a);
      setCalls(c);
      remember(`lead-activity:${id}`, a);
      remember(`lead-calls:${id}`, c);
      setFollowUp(f);
      setHolidays([...h1, ...h2]);
      setStageNames(new Map(stages.map((s) => [s.id, s.name])));
      setUserNames(new Map(users.map((u) => [u.id, `${u.full_name ?? 'No name'}${u.is_active ? '' : ' (inactive)'}`])));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this lead.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, loadVoices]);

  // Reload when coming back from the edit screen
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // --- opened from the "add a note" notification -------------------------
  useEffect(() => {
    if (!callNote || !lead || lead.id !== id) return;
    callStartedAt.current = null;
    setEstimatedSec(null);
    setSheetChannel('phone');
    setWaEvent(null);
    setNoteCallId(String(callNote));
    setSheetVisible(true);
    // Clear it from the address, so the popup doesn't open again on reload
    router.setParams({ callNote: undefined });
  }, [callNote, lead, id]);

  // --- opened from the WhatsApp "add a note" notification ---------------
  useEffect(() => {
    if (!waCall || !lead || lead.id !== id) return;
    router.setParams({ waCall: undefined });
    findWhatsAppCall(String(waCall), getDeviceId())
      .then((event) => {
        if (!event || event.leadId !== lead.id) return;
        callStartedAt.current = null;
        setEstimatedSec(null);
        setNoteCallId(null);
        setSheetChannel('whatsapp');
        setWaEvent(event);
        setSheetVisible(true);
      })
      .catch(() => undefined);
  }, [waCall, lead, id]);

  // 🎓 Not a lead but an alumnus (the phone's caller card / "add a note"
  //   alerts open /leads/<id> for alumni too): go on to the alumnus
  useEffect(() => {
    if (loading || lead || !id || embedded) return;
    let live = true;
    getAlumnus(id)
      .then(async (al) => {
        if (!live) return;
        if (!al) {
          // 🏦 a Lead Bank number (the caller card): admins go to it in the bank
          if (!hasPermission('settings.manage')) return;
          const { data: b } = await supabase
            .from('lead_bank' as never)
            .select('phone, status')
            .eq('id', id)
            .maybeSingle();
          const row = b as { phone: string; status: string } | null;
          if (live && row) {
            router.replace(
              `/bank?q=${encodeURIComponent(row.phone)}&tab=${row.status === 'returned' ? 'returned' : 'new'}` as Href,
            );
          }
          return;
        }
        const q = callNote
          ? `?callNote=${encodeURIComponent(String(callNote))}`
          : waCall
            ? `?waCall=${encodeURIComponent(String(waCall))}`
            : '';
        router.replace(`/alumni/${al.id}${q}` as Href);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [loading, lead, id, embedded, callNote, waCall]);

  const closeSheet = () => {
    setSheetVisible(false);
    setNoteCallId(null);
    setWaEvent(null);
  };

  // --- after a call: open the popup when the user comes back -----------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (callStartedAt.current == null) return;

      if (state === 'background' || state === 'inactive') {
        leftApp.current = true;
        return;
      }

      if (state === 'active' && leftApp.current) {
        const seconds = Math.round((Date.now() - callStartedAt.current) / 1000);
        callStartedAt.current = null;
        leftApp.current = false;
        setNoteCallId(null);
        setWaEvent(null);
        setEstimatedSec(seconds);
        setSheetChannel(pendingChannel.current);
        setSheetVisible(true);
      }
    });
    return () => sub.remove();
  }, []);

  // --- follow-up ---------------------------------------------------------
  const holidayName = useCallback(
    (d: Date) => {
      const key = dayKey(d);
      return holidays.find((h) => h.start_date <= key && key <= h.end_date)?.name ?? null;
    },
    [holidays],
  );

  const presets = useMemo(
    () => (choosingFollowUp ? followUpPresets(new Date(), (d) => holidayName(d) !== null) : []),
    [choosingFollowUp, holidayName],
  );

  const setNextFollowUp = async (date: Date) => {
    if (!lead) return;
    setSavingFollowUp(true);
    try {
      await scheduleFollowUp(lead.id, date);
      setChoosingFollowUp(false);
      await load();
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : '');
    } finally {
      setSavingFollowUp(false);
    }
  };

  // A date picked by hand: warn if it is a holiday, but allow it
  const pickCustomDate = (date: Date) => {
    const holiday = holidayName(date);
    if (!holiday) {
      setNextFollowUp(date);
      return;
    }
    Alert.alert('That day is a holiday', `${formatDue(date)} is ${holiday}. Set the call anyway?`, [
      { text: 'Pick again', style: 'cancel' },
      { text: 'Set anyway', onPress: () => setNextFollowUp(date) },
    ]);
  };

  const confirmRemoveFollowUp = () => {
    if (!lead) return;
    Alert.alert('Remove follow-up?', 'This lead will have no next call.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelFollowUp(lead.id);
            await load();
          } catch (e) {
            Alert.alert('Could not remove', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  // --- contact actions -----------------------------------------------
  const open = async (url: string, fallback?: string) => {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      if (fallback) {
        try {
          await Linking.openURL(fallback);
          return true;
        } catch {
          // fall through
        }
      }
      Alert.alert('Could not open', 'This action is not available on this phone.');
      return false;
    }
  };

  const call = async (phone: string) => {
    // ⚠️ Someone else talked to this lead a moment ago: ask first ("Read notes" = stay on this page)
    if (id && !(await confirmCall(id, () => showToast('📝 The latest calls and notes are in the Timeline below'))))
      return;
    callStartedAt.current = Date.now();
    leftApp.current = false;
    pendingChannel.current = 'phone';
    // The app shows its own popup for this call: no "add a note" notification
    markCallFromApp(phone);
    const ok = await open(`tel:${phone}`);
    if (!ok) callStartedAt.current = null;
  };
  const sms = (phone: string) => open(`sms:${phone}`);

  // 📞 Opened with dial: call once the lead is here (the usual popup follows)
  const dialed = useRef(false);
  useEffect(() => {
    if (!dial || dialed.current || !lead || lead.id !== id || !lead.phone) return;
    dialed.current = true;
    router.setParams({ dial: undefined });
    call(lead.phone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dial, lead, id]);

  // 💬 WhatsApp: when the user comes back, ask what happened (Settings → Calls)
  const whatsapp = async () => {
    if (!lead) return;
    if (askAfterWhatsApp) {
      callStartedAt.current = Date.now();
      leftApp.current = false;
      pendingChannel.current = 'whatsapp';
    }
    const ok = await openWhatsApp(lead);
    if (!ok) callStartedAt.current = null;
  };

  // For calls made from another phone: log without timing
  const logManually = (channel: CallChannel = 'phone') => {
    callStartedAt.current = null;
    setNoteCallId(null);
    setWaEvent(null);
    setEstimatedSec(null);
    setSheetChannel(channel);
    setSheetVisible(true);
  };

  const confirmDelete = () => {
    if (!lead) return;
    Alert.alert('Delete this lead?', `${lead.name} will be hidden from all lists. An admin can restore it later.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await softDeleteLead(lead.id);
            if (onClosed) onClosed();
            else router.back();
          } catch (e) {
            Alert.alert('Could not delete', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  // --- activity text ---------------------------------------------------
  // Name of the person who did the action (adds "(inactive)" if deactivated)
  const actorName = (item: ActivityItem): string | null =>
    item.user_id ? (userNames.get(item.user_id) ?? item.user_name) : item.user_name;

  const personName = (person: { id: string; full_name: string | null; is_active: boolean } | null) =>
    person ? `${person.full_name ?? 'No name'}${person.is_active ? '' : ' (inactive)'}` : null;

  const describe = (item: ActivityItem): string => {
    const d = (item.details ?? {}) as Record<string, string | null>;
    switch (item.action) {
      case 'created':
        return 'Lead created';
      case 'stage_changed':
        return `Stage: ${stageNames.get(d.from ?? '') ?? '—'} → ${stageNames.get(d.to ?? '') ?? '—'}`;
      case 'rating_changed':
        return `Rating: ${d.from ?? 'none'} → ${d.to ?? 'none'}`;
      case 'assigned':
        return `${d.to ? `Assigned to ${userNames.get(d.to) ?? 'a removed user'}` : 'Unassigned'}${d.note ? ` · “${d.note}”` : ''}`;
      case 'details_changed':
        return 'Name or phone updated';
      case 'web_form':
        return d.again
          ? `🙋 Filled the website form again${d.name ? ` as “${d.name}”` : ''}${d.note ? ` · “${d.note}”` : ''}`
          : '🙋 Came from the website form';
      case 'alumni_referral':
        return d.credit
          ? `🎓 Credited to alumnus ${d.alumni_name ?? ''}`
          : `🎓 Referred by alumnus ${d.alumni_name ?? ''}`;
      case 'call_logged': {
        if (d.channel === 'whatsapp') {
          const wa = channelLabel(d.channel, d.media);
          if (d.outcome === 'message') return `💬 ${wa} ${d.direction === 'incoming' ? 'received' : 'sent'}`;
          if (d.direction === 'missed' || d.direction === 'rejected') return `💬 Missed ${wa}`;
          return `💬 ${d.direction === 'incoming' ? 'Incoming ' : ''}${wa}: ${outcomeInfo(d.outcome ?? '').label}`;
        }
        const fromPhone = d.source === 'phone' ? ' 📱' : '';
        if (d.direction === 'missed' || d.direction === 'rejected') return `Missed call from lead${fromPhone}`;
        if (d.direction === 'incoming') return `Incoming call: ${outcomeInfo(d.outcome ?? '').label}${fromPhone}`;
        return `Call: ${outcomeInfo(d.outcome ?? '').label}${fromPhone}`;
      }
      case 'follow_up_set':
        return d.due_at ? `Next call set: ${formatDue(d.due_at)}` : 'Next call set';
      case 'follow_up_cancelled':
        return 'Next call removed';
      case 'note_added':
        return `📝 Note: ${d.note ?? ''}`;
      case 'call_deleted':
        return `🗑 ${d.channel === 'whatsapp' ? 'WhatsApp entry' : 'Call'} deleted${d.reason ? ` · ${d.reason}` : ''}`;
      case 'call_note_deleted':
      case 'note_deleted':
        return `🗑 Note deleted: ${d.note ?? ''}`;
      case 'entry_restored':
        return `↩ Restored${d.note ? `: ${d.note}` : ''}`;
      case 'paper_received':
        return `📄 ${d.paper ?? 'Paper'} received${d.copy_type ? ` (${d.copy_type})` : ''}`;
      case 'paper_not_needed':
        return `📄 ${d.paper ?? 'Paper'}: not needed`;
      case 'paper_unticked':
        return `📄 ${d.paper ?? 'Paper'} unticked`;
      case 'paper_returned':
        return `📄 ${d.paper ?? 'Paper'} (original) returned to the student`;
      case 'papers_moved':
        return d.kept_at ? `📁 Papers kept at: ${d.kept_at}` : '📁 Papers place removed';
      case 'visit_planned':
        return `🏫 Visit planned${d.at ? `: ${formatVisitTime(d.at)}` : ''}${d.note ? ` · ${d.note}` : ''}`;
      case 'visit_moved':
        return `🏫 Visit moved${d.at ? ` to ${formatVisitTime(d.at)}` : ''}`;
      case 'visit_done':
        return `🏫 Visited the campus${d.note ? ` · ${d.note}` : ''}`;
      case 'visit_missed':
        return `🏫 Didn’t come to the visit${d.note ? ` · ${d.note}` : ''}`;
      case 'visit_cancelled':
        return '🏫 Visit cancelled';
      case 'negotiation_started':
        return `💰 Fee negotiation started${d.course ? `: ${d.course}` : ''}`;
      case 'negotiation_event':
        return d.kind === 'note'
          ? `💰 Fee note: ${d.note ?? ''}`
          : `💰 ${EVENT_LABELS[(d.kind ?? 'note') as keyof typeof EVENT_LABELS] ?? 'Fee'} ${money(Number(d.amount ?? 0))}${d.note ? ` · “${d.note}”` : ''}`;
      case 'discount_requested':
        return `💰 Discount asked: ${money(Number(d.amount ?? 0))} off ${d.fee ?? 'the fee'}${d.reason ? ` · ${d.reason}` : ''}`;
      case 'discount_approved':
        return `💰 Discount approved: ${money(Number(d.amount ?? 0))} off ${d.fee ?? 'the fee'}${d.note ? ` · “${d.note}”` : ''}`;
      case 'discount_rejected':
        return `💰 Discount not approved: ${money(Number(d.amount ?? 0))}${d.note ? ` · “${d.note}”` : ''}`;
      case 'discount_cancelled':
        return `💰 Discount taken back: ${money(Number(d.amount ?? 0))} off ${d.fee ?? 'the fee'}`;
      case 'payment_received':
        return `💵 ${money(Number(d.amount ?? 0))} received (${d.method ?? ''}) · 🧾 ${d.receipt_no ?? ''}`;
      case 'file_added':
        if (d.kind === 'voice') {
          const where = VOICE_CONTEXT[String(d.context ?? '')];
          return `🎙 Voice note${d.duration_sec ? ` (${clock(Number(d.duration_sec))})` : ''}${where ? ` · ${where}` : ''}  ▶`;
        }
        return `📎 File added: ${d.name ?? ''}`;
      case 'file_deleted':
        return `📎 File removed: ${d.name ?? ''}`;
      case 'files_downloaded':
        return `📦 Downloaded all files (${d.count ?? 0})`;
      case 'admission_approved':
        return `✅ Admission approved${d.section ? ` · Section ${d.section}` : ''}${d.nu_admission_id ? ` · NU ${d.nu_admission_id}` : ''}${d.note ? ` · “${d.note}”` : ''}`;
      case 'admission_returned':
        return `↩ Admission sent back: ${d.reason ?? ''}`;
      case 'admission_resubmitted':
        return `🎓 Sent for approval again${d.note ? `: ${d.note}` : ''}`;
      case 'nu_id_set':
        return d.to
          ? `🆔 NU Admission ID: ${d.to}${d.from ? ` (was ${d.from})` : ''}`
          : `🆔 NU Admission ID removed (was ${d.from ?? ''})`;
      case 'submitted_online':
        return `📤 Submitted Online${d.nu_admission_id ? ` · NU ${d.nu_admission_id}` : ''}${d.note ? ` · “${d.note}”` : ''}`;
      case 'received_by_ittc':
        return `🏛 Received by ITTC${d.fee != null ? ` · admission fee ৳${Math.round(Number(d.fee)).toLocaleString('en-IN')} paid` : ''}${d.note ? ` · “${d.note}”` : ''}`;
      case 'ittc_undone':
        return `↩ ${d.step === 'received' ? 'Received by ITTC' : 'Submitted Online'} undone${d.reason ? `: ${d.reason}` : ''}`;
      case 'admission_listed':
        return `📋 Listed without pay${d.section ? ` · Section ${d.section}` : ''}${d.nu_admission_id ? ` · NU ${d.nu_admission_id}` : ''}${d.note ? ` · “${d.note}”` : ''}`;
      case 'placement_changed':
        return `🏫 ${d.from ? `${d.from} → ` : ''}${d.to ?? ''}`;
      case 'registration_approved':
        return `📝 Registration approved${d.note ? ` · “${d.note}”` : ''}`;
      case 'registration_returned':
        return `↩ Registration sent back${d.reason ? `: ${d.reason}` : ''}`;
      case 'registration_resubmitted':
        return `📝 Registration sent again${d.note ? ` · ${d.note}` : ''}`;
      case 'final_fee_changed':
        return `💰 Final fee changed: ${money(Number(d.from ?? 0))} → ${money(Number(d.to ?? 0))} (discount ${money(Number(d.discount_from ?? 0))} → ${money(Number(d.discount_to ?? 0))})${d.reason ? ` · ${d.reason}` : ''}`;
      case 'student_ref_changed':
        return `🎓 Student ID changed: ${d.from ?? '—'} → ${d.to ?? '—'}`;
      case 'admission_approval_cleared':
        return `🎓 Admission approval cleared (cancelled)${d.nu_admission_id ? ` · NU ${d.nu_admission_id}` : ''}${d.student_ref ? ` · ${d.student_ref}` : ''}`;
      case 'payment_refunded':
        return `↩ Refund ${money(Number(d.amount ?? 0))} (${d.method ?? ''}) · ${d.receipt_no ?? ''}${d.reason ? ` · ${d.reason}` : ''}`;
      case 'payment_voided':
        return `✕ Payment void: ${d.receipt_no ?? ''} · ${money(Number(d.amount ?? 0))}${d.reason ? ` · ${d.reason}` : ''}`;
      case 'installments_set':
        return Number(d.count ?? 0) > 0
          ? `📅 Installment plan: ${d.count} installments`
          : '📅 Installment plan removed';
      case 'tag_added':
        return `🏷 Tag added: ${d.tag ?? ''}`;
      case 'tag_removed':
        return `🏷 Tag removed: ${d.tag ?? ''}`;
      case 'course_added':
        return `🎓 Course added: ${d.course ?? ''}`;
      case 'course_removed':
        return `🎓 Course removed: ${d.course ?? ''}`;
      case 'pipeline_course_set':
        return `🧭 Pipeline follows ${d.course ?? ''}`;
      case 'pipeline_course_changed':
        return `🧭 ${d.course ? `${d.course}: ` : ''}stage ${d.from_stage ?? ''} → ${d.to_stage ?? ''} (not used for this course)`;
      case 'note_edited':
        return '📝 Notes edited';
      case 'fields_changed': {
        const changes =
          (item.details as { changes?: { field: string; from: string | null; to: string | null }[] } | null)?.changes ??
          [];
        return `✏️ ${changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(' · ')}`;
      }
      case 'deleted':
        return 'Lead deleted';
      case 'restored':
        return 'Lead restored';
      case 'bank_returned':
        return `🏦 Sent to the Lead Bank${d.reason ? ` · ${String(d.reason)}` : ''}${
          Number(d.rest_days ?? 0) > 0 ? ` · rests ${Number(d.rest_days)} days` : ''
        }`;
      case 'bank_pulled':
        return d.back
          ? `🏦 Back from the Lead Bank${d.list ? ` (${String(d.list)})` : ''}`
          : `🏦 Came from the Lead Bank${d.list ? ` (${String(d.list)})` : ''}`;
      case 'bulk_placement':
        return `🔀 Moved: ${String(d.from ?? '—')} → ${String(d.to ?? '')} (with ${Number(d.count ?? 1)})`;
      case 'student_ref_renumbered':
        return `🎓 Student ID changed: ${String(d.old ?? '—')} → ${String(d.new ?? '')}`;
      case 'call_lock_override':
        return `📵 Called anyway · ${String(d.other_name ?? 'someone').split(' ')[0]} was on a call with the lead`;
      case 'double_call':
        return `⚠️ Called anyway · ${String(d.other_name ?? 'someone').split(' ')[0]} ${d.kind === 'note' ? 'wrote a note' : d.kind === 'voice' ? 'left a voice note' : 'called'} ${Number(d.minutes ?? 0)} min before`;
      default:
        return item.action.replace(/_/g, ' ');
    }
  };

  // --- 🗑 delete a call / WhatsApp entry / note -------------------------
  const offerUndo = (activityId: string, label: string) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ activityId, label });
    undoTimer.current = setTimeout(() => setUndo(null), 10000);
  };

  const runDelete = async (work: () => Promise<string>, label: string) => {
    try {
      const activityId = await work();
      offerUndo(activityId, label);
      load();
    } catch (e) {
      Alert.alert('Could not delete', e instanceof Error ? e.message : '');
    }
  };

  const undoDelete = async () => {
    if (!undo) return;
    const { activityId } = undo;
    setUndo(null);
    try {
      await restoreDeleted(activityId);
      load();
      showToast('Restored.');
    } catch (e) {
      Alert.alert('Could not undo', e instanceof Error ? e.message : '');
    }
  };

  const confirm = (title: string, onYes: () => void) =>
    Alert.alert(title, 'It will be hidden everywhere (lead, reports). An admin can restore it from the change log.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onYes },
    ]);

  const onLongPressNote = (n: LeadNote) => {
    if (!lead) return;
    const mine = n.when === 'exact' && canDeleteEntry(n.userId, n.at, me, false);
    if (!isAdmin && !mine) {
      Alert.alert('Can’t delete', 'You can delete your own notes within 24 hours. Admins can delete any note.');
      return;
    }
    confirm('Delete this note?', () => runDelete(() => deleteLeadNote(lead.id, n.raw), 'Note deleted'));
  };

  const onLongPressCall = (c: CallLog) => {
    const allowed = canDeleteEntry(c.user_id, c.created_at, me, isAdmin);
    const what = c.channel === 'whatsapp' ? 'WhatsApp entry' : 'call';
    const options: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] = [];
    if (allowed && isHandWritten(c)) {
      options.push({
        text: `Delete this ${what}`,
        style: 'destructive',
        onPress: () => confirm(`Delete this ${what}?`, () => runDelete(() => deleteCall(c.id), `${what} deleted`)),
      });
    }
    if (allowed && c.notes) {
      options.push({
        text: 'Delete only the note',
        onPress: () => confirm('Delete this note?', () => runDelete(() => deleteCallNote(c.id), 'Note deleted')),
      });
    }
    if (options.length === 0) {
      Alert.alert(
        'Can’t delete',
        isHandWritten(c)
          ? 'You can delete your own entries within 24 hours. Admins can delete any.'
          : 'Calls read from the phone’s call log or from WhatsApp can’t be deleted.',
      );
      return;
    }
    Alert.alert(c.channel === 'whatsapp' ? 'WhatsApp entry' : 'Call', undefined, [
      ...options,
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // --- calls and notes, newest first ----------------------------------
  // 🎙 Voice notes from the call popup sit inside their call; the rest are their own lines
  const voicesByCall = useMemo(() => {
    const ids = new Set(calls.map((c) => c.id));
    const map = new Map<string, LeadFile[]>();
    for (const v of voices) {
      if (!v.call_id || !ids.has(v.call_id)) continue;
      map.set(
        v.call_id,
        [...(map.get(v.call_id) ?? []), v].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
      );
    }
    return map;
  }, [calls, voices]);

  const feed = useMemo<FeedItem[]>(() => {
    const notes = lead ? splitLeadNotes(lead.notes, lead.created_at, activity) : [];
    const ids = new Set(calls.map((c) => c.id));
    return [
      ...calls.map((c): FeedItem => ({ kind: 'call', key: c.id, at: c.called_at, call: c })),
      ...notes.map((n): FeedItem => ({ kind: 'note', key: n.key, at: n.at, note: n })),
      ...voices
        .filter((v) => !v.call_id || !ids.has(v.call_id))
        .map((v): FeedItem => ({ kind: 'voice', key: v.id, at: v.created_at, voice: v })),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [lead, calls, activity, voices]);

  // 🗑 Remove a voice note (the person who recorded it, or an admin; it goes to Drive's Trash)
  const onLongPressVoice = (v: LeadFile) => {
    if (v.uploaded_by !== profile?.id && !hasPermission('settings.manage')) {
      Alert.alert('Can’t delete', 'Only the person who recorded it, or an admin, can delete a voice note.');
      return;
    }
    Alert.alert(
      'Delete this voice note?',
      'It is removed here and moved to Google Drive’s Trash (30 days to bring it back).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteLeadFile(v.id);
              showToast('Voice note deleted.');
              load();
            } catch (e) {
              Alert.alert('Could not delete', e instanceof Error ? e.message : '');
            }
          },
        },
      ],
    );
  };

  // The note from whoever gave this lead to its person (hand over)
  const handover = useMemo(() => {
    if (!lead?.assigned_to) return null;
    const a = activity.find((x) => x.action === 'assigned');
    const d = (a?.details ?? {}) as { to?: string; note?: string };
    return a && d.note && d.to === lead.assigned_to ? { item: a, note: d.note } : null;
  }, [activity, lead?.assigned_to]);

  // Newest call and newest note (written or 🎙), for the top card
  const lastCall = feed.find((f) => f.kind === 'call')?.call ?? null;
  const lastNoteItem = feed.find((f) => f.kind === 'note' || f.kind === 'voice') ?? null;
  const lastNote = lastNoteItem?.kind === 'note' ? lastNoteItem.note : null;
  const lastVoice = lastNoteItem?.kind === 'voice' ? lastNoteItem.voice : null;

  // Calls & notes: everything, only phone, or only WhatsApp
  const [feedFilter, setFeedFilter] = useState<'all' | CallChannel>('all');
  const hasWhatsApp = calls.some((c) => c.channel === 'whatsapp');
  const shownFeed = useMemo(
    () =>
      feedFilter === 'all'
        ? feed
        : feed.filter(
            (f) =>
              (f.kind === 'call' && (f.call.channel ?? 'phone') === feedFilter) ||
              (f.kind === 'voice' && f.voice.context === (feedFilter === 'phone' ? 'call' : 'whatsapp')),
          ),
    [feed, feedFilter],
  );

  // Long lists show the newest few until "View more"
  const feedMore = useShowMore(shownFeed, 3);
  const activityMore = useShowMore(activity, 5);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // --- states ----------------------------------------------------------
  if (loading) {
    return (
      <View style={styles.center}>
        {!embedded && <Stack.Screen options={{ title: 'Lead' }} />}
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!lead) {
    return (
      <View style={styles.center}>
        {!embedded && <Stack.Screen options={{ title: 'Lead' }} />}
        <Text style={styles.emptyTitle}>Lead not found</Text>
        <Text style={styles.muted}>{error ?? 'It may have been deleted or assigned to someone else.'}</Text>
      </View>
    );
  }

  const ratingColor = lead.rating ? RATING_COLOR[lead.rating] : colors.primary;
  const courses = lead.lead_courses.map((c) => c.course?.name).filter(Boolean) as string[];
  const tags = lead.lead_tags.map((t) => t.tag).filter(Boolean) as { id: string; name: string; color: string }[];
  const assigneeName = lead.assigned_to
    ? (userNames.get(lead.assigned_to) ?? lead.assignee?.full_name ?? 'Unassigned')
    : 'Unassigned';
  const overdue = followUp ? isOverdue(followUp.due_at) : false;

  // Pipeline state
  const stageKind = lead.stage?.kind ?? 'open';
  // Admitted / cancelled leads have no more calls to plan; lost leads may have a "♻️ Revive"
  const showFollowUpCard = stageKind === 'open' || stageKind === 'lost';
  const reviveAt = followUp && followUp.purpose === 'revive' ? followUp.due_at : null;
  const nameOf = (userId: string | null | undefined) => (userId ? (userNames.get(userId) ?? null) : null);
  // The papers card reloads itself when the lead's courses change
  const courseKey = lead.lead_courses.map((c) => c.course?.id ?? '').join(',');

  // Call totals for the section header
  const talkSec = calls.reduce((sum, c) => sum + (c.outcome === 'connected' ? (c.duration_sec ?? 0) : 0), 0);

  // ---- The page's parts (the phone stacks them; the website arranges them) ----
  const recentEl = (
    <>
      {/* Last call and last note at a glance */}
      {(lastCall || lastNote || lastVoice) && (
        <View style={styles.recent}>
          {lastCall && (
            <View style={styles.recentRow}>
              <Text style={styles.recentIcon}>{lastCall.channel === 'whatsapp' ? '💬' : '📞'}</Text>
              <View style={styles.flex}>
                <Text style={styles.recentTitle} numberOfLines={1}>
                  {lastCall.channel === 'whatsapp'
                    ? `Last ${channelLabel(lastCall.channel, lastCall.media)}`
                    : 'Last call'}
                  :{' '}
                  <Text style={{ color: outcomeInfo(lastCall.outcome).color }}>
                    {lastCall.direction === 'incoming' && lastCall.outcome === 'connected' ? 'Incoming · ' : ''}
                    {outcomeInfo(lastCall.outcome).label}
                  </Text>
                  {lastCall.duration_sec && lastCall.duration_sec > 0
                    ? ` · ${formatDuration(lastCall.duration_sec)}`
                    : ''}
                </Text>
                <Text style={styles.timelineMeta}>
                  {formatDateTime(lastCall.called_at)}
                  {lastCall.caller ? ` · ${personName(lastCall.caller)}` : ''}
                </Text>
                {lastCall.notes && (
                  <Text style={styles.callNotes} numberOfLines={2}>
                    “{lastCall.notes}”
                  </Text>
                )}
                <VoiceChips list={voicesByCall.get(lastCall.id)} onPlay={setPlaying} onLongPress={onLongPressVoice} />
              </View>
            </View>
          )}
          {lastVoice && (
            <View style={styles.recentRow}>
              <Text style={styles.recentIcon}>📝</Text>
              <View style={styles.flex}>
                <Text style={styles.recentTitle} numberOfLines={1}>
                  Last note: <Text style={styles.recentNote}>🎙 Voice note</Text>
                </Text>
                <VoiceChips list={[lastVoice]} onPlay={setPlaying} onLongPress={onLongPressVoice} />
                <Text style={styles.timelineMeta}>
                  {formatDateTime(lastVoice.created_at)}
                  {nameOf(lastVoice.uploaded_by) ? ` · ${nameOf(lastVoice.uploaded_by)}` : ''}
                </Text>
              </View>
            </View>
          )}
          {lastNote && (
            <View style={styles.recentRow}>
              <Text style={styles.recentIcon}>📝</Text>
              <View style={styles.flex}>
                <Text style={styles.recentTitle} numberOfLines={2}>
                  Last note: <Text style={styles.recentNote}>{lastNote.text}</Text>
                </Text>
                <Text style={styles.timelineMeta}>
                  {noteWhen(lastNote)}
                  {lastNote.author ? ` · ${lastNote.author}` : ''}
                </Text>
              </View>
            </View>
          )}
        </View>
      )}
    </>
  );
  const headerEl = (
    <>
      {/* Header card */}
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View style={[styles.avatar, { backgroundColor: ratingColor }]}>
            <Text style={styles.avatarText}>{initials(lead.name) || '?'}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.name}>{lead.name}</Text>
            <Text style={styles.phone}>
              {whatsAppOnly(lead) ? '💬 ' : ''}
              {contactLabel(lead)}
            </Text>
          </View>
        </View>

        <View style={styles.badges}>
          {lead.stage && (
            <View style={[styles.pill, { backgroundColor: lead.stage.color + '22' }]}>
              <Text style={[styles.pillText, { color: lead.stage.color }]}>{lead.stage.name}</Text>
            </View>
          )}
          {lead.rating && (
            <View style={[styles.pill, { backgroundColor: ratingColor + '22' }]}>
              <Text style={[styles.pillText, { color: ratingColor }]}>{lead.rating.toUpperCase()}</Text>
            </View>
          )}
          <View style={[styles.pill, { backgroundColor: colors.background }]}>
            <Text style={[styles.pillText, { color: colors.textMuted }]}>{assigneeName}</Text>
          </View>
        </View>

        {/* Hand over note */}
        {handover && (
          <View style={styles.handover}>
            <Text style={styles.handoverTitle}>
              👥 From {actorName(handover.item) ?? 'someone'} · {formatDateTime(handover.item.created_at)}
            </Text>
            <Text style={styles.handoverNote}>“{handover.note}”</Text>
          </View>
        )}

        {/* Contact buttons */}
        <View style={styles.actions}>
          {/* 🌐 No phone calls (or SMS) from a computer */}
          {!!lead.phone && !isWeb && (
            <ActionButton label="Call" icon="📞" color={colors.success} onPress={() => call(lead.phone!)} />
          )}
          <ActionButton
            label="WhatsApp"
            icon="💬"
            color="#1F7A57"
            onPress={() => (tapOpensTemplates ? setTemplateChannel('whatsapp') : whatsapp())}
            onLongPress={templates.allowed ? () => setTemplateChannel('whatsapp') : undefined}
          />
          {!!lead.phone && !isWeb && (
            <ActionButton
              label="SMS"
              icon="✉️"
              color={colors.info}
              onPress={() => (tapOpensTemplates ? setTemplateChannel('sms') : sms(lead.phone!))}
              onLongPress={templates.allowed ? () => setTemplateChannel('sms') : undefined}
            />
          )}
        </View>

        {recentEl}
      </View>
    </>
  );
  const pipelineEl = (
    <>
      {/* Pipeline: step bar, Admitted / Lost, or the closed status */}
      <PipelineCard
        lead={lead}
        reviveAt={reviveAt}
        nameOf={nameOf}
        onChanged={(message) => {
          if (message) showToast(message);
          load();
        }}
      />
      {/* 🔮 AI: chance of admission, what to do and say (open leads) */}
      {stageKind === 'open' && (
        <ChanceCard
          leadId={lead.id}
          stateKey={`${lead.last_contacted_at ?? ''}|${lead.next_follow_up_at ?? ''}`}
          onChanged={(message) => {
            if (message) showToast(message);
            if (message !== 'Copied') load();
          }}
        />
      )}
    </>
  );
  const approvalEl = (
    <>
      {/* 🎓 Admission approval: admitted students only (hidden once cancelled) */}
      {stageKind === 'won' && !!lead.admitted_at && (
        <ApprovalCard
          lead={lead}
          nameOf={nameOf}
          onChanged={(message) => {
            showToast(message);
            load();
          }}
        />
      )}
      {/* 🤝 Who did how much (AI); only for people Settings → AI allows */}
      {stageKind === 'won' && !!lead.admitted_at && (
        <AdmissionCreditCard leadId={lead.id} stateKey={lead.admitted_at} nameOf={nameOf} />
      )}
    </>
  );
  const visitEl = (
    <>
      {/* Campus visit: separate from the pipeline */}
      <VisitCard
        leadId={lead.id}
        stageKind={stageKind}
        stateKey={`${lead.visit_status ?? ''}|${lead.visit_at ?? ''}`}
        onChanged={(message) => {
          if (message) showToast(message);
          load();
        }}
      />
    </>
  );
  const feeEl = (
    <>
      {/* Fee & discount: negotiation before admission, the final fee after */}
      <FeeCard
        leadId={lead.id}
        stageKind={stageKind}
        leadCourseIds={lead.lead_courses.map((c) => c.course?.id ?? '').filter(Boolean)}
        stateKey={`${lead.stage_id}|${lead.admitted_at ?? ''}|${courseKey}`}
        nameOf={nameOf}
        onChanged={(message) => {
          if (message) showToast(message);
          load();
        }}
      />
    </>
  );
  const papersEl = (
    <>
      {/* Papers: checklist and where they are kept */}
      <PapersCard
        key={`${lead.admitted_course_id ?? ''}|${courseKey}`}
        leadId={lead.id}
        stageKind={stageKind}
        stageKey={lead.stage?.key ?? null}
        refreshKey={filesTick}
        onChanged={(message) => {
          if (message) showToast(message);
          load();
        }}
      />
    </>
  );
  const filesEl = (
    <>
      {/* 📎 Files in Google Drive (papers, voice notes) */}
      <FilesCard
        leadId={lead.id}
        stateKey={lead.updated_at ?? ''}
        nameOf={nameOf}
        onChanged={(message) => {
          if (message) showToast(message);
          setFilesTick((n) => n + 1);
          load();
        }}
      />
    </>
  );
  const followEl = (
    <>
      {/* Next call (follow-up) */}
      {showFollowUpCard && (
        <View style={[styles.card, overdue && styles.cardOverdue]}>
          <View style={styles.followHeader}>
            <Text style={styles.followIcon}>⏰</Text>
            <View style={styles.flex}>
              <Text style={styles.sectionTitle}>Next call</Text>
              {followUp ? (
                <>
                  <Text style={[styles.followDue, overdue && styles.followDueOverdue]}>
                    {formatDue(followUp.due_at)}
                    {overdue ? ' · Overdue' : ''}
                  </Text>
                  {followUp.note && <Text style={styles.callNotes}>{followUp.note}</Text>}
                </>
              ) : (
                <Text style={styles.followNone}>Not set</Text>
              )}
            </View>
          </View>

          {choosingFollowUp ? (
            <>
              <View style={styles.chips}>
                {presets.map((p) => (
                  <Pressable
                    key={p.key}
                    onPress={() => setNextFollowUp(p.date)}
                    disabled={savingFollowUp}
                    style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`${p.label}, ${formatDue(p.date)}`}
                  >
                    <Text style={styles.chipText}>{p.label}</Text>
                    <Text style={styles.chipSub}>{formatDue(p.date)}</Text>
                  </Pressable>
                ))}
              </View>

              <DateTimePickerButton
                initial={followUp ? new Date(followUp.due_at) : undefined}
                disabled={savingFollowUp}
                onPick={pickCustomDate}
              />

              {holidays.length > 0 && <Text style={styles.hint}>Quick choices skip holidays automatically.</Text>}
              <Button
                title="Cancel"
                variant="ghost"
                onPress={() => setChoosingFollowUp(false)}
                disabled={savingFollowUp}
              />
            </>
          ) : (
            <View style={styles.followActions}>
              <View style={styles.flex}>
                <Button
                  title={followUp ? 'Change' : 'Set next call'}
                  variant="secondary"
                  onPress={() => setChoosingFollowUp(true)}
                  fullWidth
                />
              </View>
              {followUp && (
                <View style={styles.flex}>
                  <Button title="Remove" variant="ghost" onPress={confirmRemoveFollowUp} fullWidth />
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </>
  );
  const callsEl = (
    <>
      {/* Calls and notes, in one list */}
      <Section
        title={`Calls & notes${feed.length > 0 ? ` (${feed.length})` : ''}`}
        right={talkSec > 0 ? `Talk time ${formatDuration(talkSec)}` : undefined}
      >
        {hasWhatsApp && (
          <View style={styles.feedFilters}>
            {(
              [
                ['all', 'All'],
                ['phone', '📞 Phone'],
                ['whatsapp', '💬 WhatsApp'],
              ] as const
            ).map(([value, label]) => {
              const on = feedFilter === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setFeedFilter(value)}
                  style={[styles.feedChip, on && styles.feedChipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.feedChipText, on && styles.feedChipTextOn]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {shownFeed.length === 0 ? (
          <Text style={styles.muted}>
            {feed.length === 0 ? 'No calls or notes yet. Tap Call above to start.' : 'Nothing here yet.'}
          </Text>
        ) : (
          feedMore.visible.map((item) => {
            if (item.kind === 'voice') {
              const v = item.voice;
              const where = VOICE_CONTEXT[v.context ?? ''];
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.callRow, pressed && styles.pressed]}
                  onPress={() => setPlaying(v)}
                  onLongPress={() => onLongPressVoice(v)}
                  delayLongPress={400}
                  accessibilityRole="button"
                  accessibilityHint="Plays the voice note. Long press to delete"
                >
                  <View style={[styles.dirBadge, { backgroundColor: colors.primarySoft }]}>
                    <Text style={styles.noteIcon}>🎙</Text>
                  </View>
                  <View style={styles.flex}>
                    <Text style={[styles.callOutcome, { color: colors.primary }]}>
                      Voice note{where && where !== 'Note' ? ` · ${where}` : ''}
                    </Text>
                    <Text style={styles.voicePlay}>▶ {v.duration_sec ? clock(v.duration_sec) : 'Play'}</Text>
                    <Text style={styles.timelineMeta}>
                      {formatDateTime(v.created_at)}
                      {nameOf(v.uploaded_by) ? ` · ${nameOf(v.uploaded_by)}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            }
            if (item.kind === 'note') {
              const n = item.note;
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.callRow, pressed && styles.pressed]}
                  onLongPress={() => onLongPressNote(n)}
                  delayLongPress={400}
                  accessibilityHint="Long press to delete"
                >
                  <View style={[styles.dirBadge, { backgroundColor: colors.primarySoft }]}>
                    <Text style={styles.noteIcon}>📝</Text>
                  </View>
                  <View style={styles.flex}>
                    <Text style={[styles.callOutcome, { color: colors.primary }]}>Note</Text>
                    <NoteText text={n.text} />
                    <Text style={styles.timelineMeta}>
                      {noteWhen(n)}
                      {n.author ? ` · ${n.author}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            }

            const c = item.call;
            const info = outcomeInfo(c.outcome);
            const dir = directionInfo(c.direction);
            const duration = c.duration_sec && c.duration_sec > 0 ? formatDuration(c.duration_sec) : null;
            const fromPhone = c.source === 'phone' || c.phone_verified === true;
            const wa = channelLabel(c.channel, c.media);
            const title =
              c.outcome === 'message'
                ? `💬 ${wa} · ${c.direction === 'incoming' ? 'received' : 'sent'}`
                : `${wa ? `💬 ${wa} · ` : ''}${c.direction === 'incoming' && c.outcome === 'connected' ? 'Incoming · ' : ''}${info.label}`;
            return (
              <Pressable
                key={item.key}
                style={({ pressed }) => [styles.callRow, pressed && styles.pressed]}
                onLongPress={() => onLongPressCall(c)}
                delayLongPress={400}
                accessibilityHint="Long press to delete"
              >
                <View style={[styles.dirBadge, { backgroundColor: dir.color + '1A' }]}>
                  <Text style={[styles.dirArrow, { color: dir.color }]}>{dir.arrow}</Text>
                </View>
                <View style={styles.flex}>
                  <View style={styles.callTop}>
                    <Text style={[styles.callOutcome, { color: info.color }]}>{title}</Text>
                    {duration && <Text style={styles.callDuration}>{duration}</Text>}
                    {fromPhone && (
                      <Text style={styles.phoneTag} accessibilityLabel="From the phone's call log">
                        📱
                      </Text>
                    )}
                  </View>
                  {c.notes && <NoteText text={c.notes} />}
                  <VoiceChips list={voicesByCall.get(c.id)} onPlay={setPlaying} onLongPress={onLongPressVoice} />
                  <Text style={styles.timelineMeta}>
                    {formatDateTime(c.called_at)}
                    {c.caller ? ` · ${personName(c.caller)}` : ''}
                    {c.sim_label ? ` · ${c.sim_label}` : ''}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
        <ShowMoreButton {...feedMore} />
        {!!lead.phone && (
          <Button title="+ Log a call made from another phone" variant="ghost" onPress={() => logManually('phone')} />
        )}
        <Button title="+ WhatsApp log (call or message)" variant="ghost" onPress={() => logManually('whatsapp')} />
        {calls.some((c) => c.source === 'phone' || c.phone_verified) && (
          <Text style={styles.hint}>📱 = taken from the phone’s call log (real time and length)</Text>
        )}
        {feed.length > 0 && <Text style={styles.hint}>Long-press a call, note or voice note to delete it.</Text>}
      </Section>
    </>
  );
  const interestEl = (
    <>
      {/* Interest */}
      <Section title="Interest">
        <InfoRow label="Courses" value={courses.length > 0 ? courses.join(', ') : null} />
        {tags.length > 0 && (
          <View style={styles.tags}>
            {tags.map((t) => (
              <View key={t.id} style={[styles.tag, { backgroundColor: t.color + '22' }]}>
                <Text style={[styles.tagText, { color: t.color }]}>{t.name}</Text>
              </View>
            ))}
          </View>
        )}
      </Section>
    </>
  );
  const detailsEl = (
    <>
      {/* Contact, guardian and source: the main lines, the rest under "More details" */}
      <Section title="Details">
        {lead.phone && <PhoneRow label="Phone" phone={lead.phone} onCall={call} />}
        <InfoRow label="WhatsApp" value={lead.whatsapp_number} />
        <InfoRow label="WhatsApp username" value={lead.whatsapp_username ? '@' + lead.whatsapp_username : null} />
        <InfoRow label="Area" value={lead.area} />
        {/* 🔥 Admission chance (Settings → Lead score) */}
        {showScore(lead) && (
          <LeadScoreRow
            score={lead.score}
            reasons={(lead as unknown as { score_reasons?: ScoreReason[] }).score_reasons}
          />
        )}
        <InfoRow label="Source" value={lead.source?.name ?? null} />
        {/* 🎓 The alumnus who referred this lead (Alumni) */}
        <LeadReferrer leadId={lead.id} />
        {/* 🏫 Our alumni at the lead's workplace */}
        <LeadSchoolAlumni workplace={(lead as { workplace?: string | null }).workplace} />
        {detailsOpen && (
          <>
            {lead.alt_phone && <PhoneRow label="Alternative" phone={lead.alt_phone} onCall={call} />}
            <InfoRow label="Email" value={lead.email} />
            <InfoRow
              label="Last contacted"
              value={lead.last_contacted_at ? formatDateTime(lead.last_contacted_at) : 'Never'}
            />
            <InfoRow
              label="Guardian"
              value={[lead.guardian_name, lead.guardian_relation && `(${lead.guardian_relation})`]
                .filter(Boolean)
                .join(' ')}
            />
            {lead.guardian_phone && <PhoneRow label="Guardian phone" phone={lead.guardian_phone} onCall={call} />}
            <InfoRow label="Campaign" value={lead.campaign?.name ?? null} />
            <InfoRow label="Referred by" value={lead.referred_by} />
            <InfoRow label="Lead type" value={lead.lead_type?.name ?? null} />
            <InfoRow label="Added" value={formatDateTime(lead.created_at)} />
          </>
        )}
        <ShowMoreButton
          expanded={detailsOpen}
          hidden={1}
          toggle={() => setDetailsOpen((o) => !o)}
          label="More details"
        />
      </Section>
    </>
  );
  const activityEl = (
    <>
      {/* Activity */}
      <Section title="Activity">
        {activity.length === 0 ? (
          <Text style={styles.muted}>No activity yet.</Text>
        ) : (
          activityMore.visible.map((item, index) => {
            const who = actorName(item);
            const det = (item.details ?? {}) as Record<string, unknown>;
            const voice = item.action === 'file_added' && det.kind === 'voice' && typeof det.file_id === 'string';
            return (
              <Pressable
                key={item.id}
                style={styles.timelineRow}
                disabled={!voice}
                onPress={() =>
                  setPlaying({
                    id: String(det.file_id),
                    name: String(det.name ?? 'Voice note'),
                    duration_sec: Number(det.duration_sec ?? 0) || null,
                  })
                }
                accessibilityRole={voice ? 'button' : undefined}
                accessibilityHint={voice ? 'Plays the voice note' : undefined}
              >
                <View style={styles.timelineMarker}>
                  <View style={styles.timelineDot} />
                  {index < activityMore.visible.length - 1 && <View style={styles.timelineLine} />}
                </View>
                <View style={styles.timelineBody}>
                  <Text style={styles.timelineText}>{describe(item)}</Text>
                  <Text style={styles.timelineMeta}>
                    {formatDateTime(item.created_at)}
                    {who ? ` · ${who}` : ''}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
        <ShowMoreButton {...activityMore} />
        <VoicePlayer file={playing} onClose={() => setPlaying(null)} />
      </Section>
    </>
  );
  const deleteEl = (
    <>
      {/* 🏦 out of the lead list, kept in the Lead Bank with its history (admins; not admitted students) */}
      {hasPermission('settings.manage') && !(lead.admitted_at && !lead.cancelled_at) && (
        <Button title="🏦 Back to the Lead Bank" variant="secondary" onPress={() => setBanking(true)} fullWidth />
      )}
      {banking && (
        <ReturnToBankSheet
          leadIds={[lead.id]}
          onClose={() => setBanking(false)}
          onDone={(msg) => {
            setBanking(false);
            Alert.alert('Done', msg);
            router.back();
          }}
        />
      )}
      {hasPermission('leads.delete') && (
        <Button title="Delete lead" variant="danger" onPress={confirmDelete} fullWidth />
      )}
    </>
  );
  const screenEl = (
    <>
      {!embedded && (
        <Stack.Screen
          options={{
            title: lead.name,
            // 🌐 The website's full page has its own header; 📱 the phone page has its own top bar
            headerShown: webLayout ? webLayout !== 'full' : false,
            headerRight: () => (
              <Pressable
                onPress={() => router.push(`/leads/edit/${lead.id}` as Href)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Edit lead"
              >
                <Text style={styles.headerAction}>Edit</Text>
              </Pressable>
            ),
          }}
        />
      )}
    </>
  );

  // =====================================================================
  // 📱 The phone page: a header with the person and five buttons, the
  //   next call, the pipeline, then folds (Timeline open; Admission, Info,
  //   Activity), and "+ Note" / "+ Log call" at the bottom.
  // =====================================================================
  const tags_ = lead.lead_tags.map((t) => t.tag?.id).filter(Boolean) as string[];
  const asListItem = {
    ...lead,
    lead_tags: tags_.map((tag_id) => ({ tag_id })),
  } as unknown as LeadListItem;
  const papersReq = lead.papers_required ?? 0;
  const papersDone = papersReq - (lead.papers_missing ?? 0);
  const fee = stageKind === 'open' || stageKind === 'won' ? feeBadge(lead) : null;
  const approval =
    stageKind === 'won' && lead.admitted_at
      ? stageBadge(lead.submitted_at, lead.received_at, lead.admission_fee_ok)
      : null;
  const admissionSummary =
    [
      approval?.text ?? null,
      lead.visit_status === 'planned' && lead.visit_at
        ? `🏫 ${formatVisitTime(lead.visit_at)}`
        : lead.visit_status === 'visited'
          ? '🏫 Visited'
          : null,
      fee?.text ?? null,
      papersReq > 0 ? `📄 ${papersDone}/${papersReq}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Visit, fee, papers, files';
  const infoSummary =
    [courses[0] ?? null, lead.area, lead.source?.name ?? null].filter(Boolean).join(' · ') ||
    'Contact, guardian, source';
  const late = !!followUp && overdue;
  const today = !!followUp && !late && new Date(followUp.due_at).toDateString() === new Date().toDateString();
  const copyPhone = () => {
    const p = lead.phone ?? lead.whatsapp_number;
    if (!p) return;
    Clipboard.setStringAsync(p)
      .then(() => showToast('📋 Number copied'))
      .catch(() => undefined);
  };

  const phoneEl = (
    <View style={styles.screen}>
      {/* Top bar: back · (name and 📞 once scrolled) · ✏️ · ⋮ */}
      <SafeAreaView edges={['top']} style={[p.bar, compactBar && p.barCompact]}>
        <View style={p.barRow}>
          <BarBtn icon="arrow-back" label="Back" onPress={() => router.back()} />
          <Text style={p.barTitle} numberOfLines={1}>
            {compactBar ? lead.name : ''}
          </Text>
          {compactBar && !!lead.phone && (
            <BarBtn icon="call" label={`Call ${lead.name}`} onPress={() => call(lead.phone!)} />
          )}
          {/* ⭐ my own short list (Leads → ⭐ Starred) */}
          <BarBtn
            icon={starred ? 'star' : 'star-border'}
            label={starred ? 'Remove the star' : 'Star this lead'}
            onPress={flipStar}
          />
          <BarBtn icon="edit" label="Edit lead" onPress={() => router.push(`/leads/edit/${lead.id}` as Href)} />
        </View>
      </SafeAreaView>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={p.content}
        scrollEventThrottle={32}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const c = e.nativeEvent.contentOffset.y > 150;
          if (c !== compactBar) setCompactBar(c);
        }}
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
        {screenEl}

        {/* 👤 The person */}
        <View style={p.hero}>
          <View style={p.who}>
            <View style={p.avatarBox}>
              <View style={[p.avatar, { backgroundColor: ratingColor + '26' }]}>
                <Text style={[p.avatarText, { color: ratingColor }]}>{initials(lead.name) || '?'}</Text>
              </View>
              {!!lead.rating && <View style={[p.ring, { borderColor: ratingColor }]} />}
            </View>
            <View style={styles.flex}>
              <Text style={p.name} numberOfLines={2}>
                {lead.name}
              </Text>
              <Pressable
                onPress={copyPhone}
                hitSlop={6}
                style={p.phoneRow}
                accessibilityRole="button"
                accessibilityHint="Copies the number"
              >
                <Text style={p.phone} numberOfLines={1}>
                  {whatsAppOnly(lead) ? '💬 ' : ''}
                  {contactLabel(lead)}
                </Text>
                {!!(lead.phone ?? lead.whatsapp_number) && (
                  <MIcon name="content-copy" size={15} color={colors.textMuted} />
                )}
              </Pressable>
            </View>
          </View>

          <View style={p.chips}>
            {lead.stage && (
              <Text style={[p.chip, { backgroundColor: lead.stage.color + '22', color: lead.stage.color }]}>
                {lead.stage.name}
              </Text>
            )}
            {lead.rating && (
              <Text style={[p.chip, { backgroundColor: ratingColor + '22', color: ratingColor }]}>
                {lead.rating === 'hot' ? '🔥 ' : ''}
                {lead.rating.toUpperCase()}
              </Text>
            )}
            <Text style={[p.chip, p.chipPlain]}>👤 {assigneeName}</Text>
            {(courses.length > 0 || lead.source) && (
              <Text style={[p.chip, p.chipPlain]} numberOfLines={1}>
                {[courses.join(', ') || null, lead.source?.name ?? null].filter(Boolean).join(' · ')}
              </Text>
            )}
          </View>

          {/* Call · WhatsApp · SMS · Note · Next call */}
          <View style={p.actions}>
            {!!lead.phone && !isWeb && (
              <RoundAction icon="call" label="Call" bg={md.okC} fg={md.onOkC} onPress={() => call(lead.phone!)} />
            )}
            <RoundAction
              icon="chat"
              label="WhatsApp"
              bg={md.waC}
              fg={md.onWaC}
              onPress={() => (tapOpensTemplates ? setTemplateChannel('whatsapp') : whatsapp())}
              onLongPress={templates.allowed ? () => setTemplateChannel('whatsapp') : undefined}
            />
            {!!lead.phone && !isWeb && (
              <RoundAction
                icon="sms"
                label="SMS"
                bg={colors.surface}
                fg={md.onSkyC}
                onPress={() => (tapOpensTemplates ? setTemplateChannel('sms') : sms(lead.phone!))}
                onLongPress={templates.allowed ? () => setTemplateChannel('sms') : undefined}
              />
            )}
            <RoundAction
              icon="edit-note"
              label="Note"
              bg={colors.surface}
              fg={md.onPurpleC}
              onPress={() => setNoteOpen(true)}
            />
            {showFollowUpCard && (
              <RoundAction
                icon="alarm"
                label="Next call"
                bg={colors.surface}
                fg={md.onWarnC}
                onPress={() => setChoosingFollowUp(true)}
              />
            )}
          </View>
        </View>

        <View style={p.body}>
          {/* 👥 Hand over note */}
          {handover && (
            <View style={styles.handover}>
              <Text style={styles.handoverTitle}>
                👥 From {actorName(handover.item) ?? 'someone'} · {formatDateTime(handover.item.created_at)}
              </Text>
              <Text style={styles.handoverNote}>“{handover.note}”</Text>
            </View>
          )}

          {/* ⏰ Next call: a strip (the full card while choosing) */}
          {showFollowUpCard &&
            (choosingFollowUp ? (
              followEl
            ) : (
              <View style={[p.next, late ? p.nextLate : today ? p.nextToday : !followUp && p.nextNone]}>
                <MIcon
                  name="alarm"
                  size={24}
                  color={late ? md.onErrorC : today ? md.onWarnC : followUp ? md.onPrimaryC : colors.textMuted}
                />
                <View style={styles.flex}>
                  <Text
                    style={[p.nextTitle, { color: late ? md.onErrorC : today ? md.onWarnC : colors.text }]}
                    numberOfLines={1}
                  >
                    {followUp ? `Next call · ${formatDue(followUp.due_at)}` : 'No next call set'}
                  </Text>
                  {(late || !!followUp?.note) && (
                    <Text style={p.nextSub} numberOfLines={1}>
                      {[late ? 'Overdue' : null, followUp?.note ? `“${followUp.note}”` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  )}
                </View>
                {followUp && (
                  <Pressable
                    onPress={confirmRemoveFollowUp}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Remove the next call"
                  >
                    <MIcon name="close" size={20} color={colors.textMuted} />
                  </Pressable>
                )}
                <Pressable onPress={() => setChoosingFollowUp(true)} style={p.nextBtn} accessibilityRole="button">
                  <Text style={[p.nextBtnText, late && { color: md.onErrorC }]}>{followUp ? 'Change' : 'Set'}</Text>
                </Pressable>
              </View>
            ))}

          {/* 🪜 Pipeline */}
          {pipelineEl}

          {/* 📂 The rest, folded */}
          <BareSection.Provider value>
            <Fold
              id="lead_timeline"
              defaultOpen
              icon="history"
              tint={{ bg: md.primaryC, fg: md.onPrimaryC }}
              title="Timeline"
              summary={`${feed.length} calls & notes${talkSec > 0 ? ` · ${formatDuration(talkSec)}` : ''}`}
            >
              {callsEl}
            </Fold>
            <Fold
              id="lead_admission"
              icon="school"
              tint={{ bg: md.okC, fg: md.onOkC }}
              title="Admission"
              summary={admissionSummary}
            >
              <View style={p.tray}>
                {approvalEl}
                {visitEl}
                {feeEl}
                {papersEl}
                {filesEl}
              </View>
            </Fold>
            <Fold
              id="lead_info"
              icon="info-outline"
              tint={{ bg: md.surface2, fg: colors.text }}
              title="Info"
              summary={infoSummary}
            >
              {interestEl}
              {detailsEl}
            </Fold>
            <Fold
              id="lead_activity"
              icon="manage-history"
              tint={{ bg: md.purpleC, fg: md.onPurpleC }}
              title="Changes"
              summary={`${activity.length}`}
            >
              {activityEl}
            </Fold>
          </BareSection.Provider>

          {deleteEl}
        </View>
      </ScrollView>

      {/* + Note · + Log call */}
      <View style={p.fabs} pointerEvents="box-none">
        <Pressable
          onPress={() => setNoteOpen(true)}
          android_ripple={{ color: md.ripple, foreground: true }}
          style={[p.fab, p.fabTonal]}
          accessibilityRole="button"
        >
          <MIcon name="add" size={20} color={md.onPrimaryC} />
          <Text style={[p.fabText, { color: md.onPrimaryC }]}>Note</Text>
        </Pressable>
        <Pressable
          onPress={() => logManually('phone')}
          android_ripple={{ color: 'rgba(255,255,255,0.2)', foreground: true }}
          style={[p.fab, p.fabPrimary]}
          accessibilityRole="button"
        >
          <MIcon name="add" size={20} color="#FFFFFF" />
          <Text style={[p.fabText, { color: '#FFFFFF' }]}>Log call</Text>
        </Pressable>
      </View>

      {/* 📝 A note for this lead */}
      {noteOpen && (
        <LeadQuickSheet
          visible
          field="note"
          leads={[asListItem]}
          onClose={() => setNoteOpen(false)}
          onSaved={(message) => {
            setNoteOpen(false);
            showToast(message);
            load();
          }}
        />
      )}
    </View>
  );

  return (
    <>
      {webLayout ? (
        <WebStudentLayout
          mode={webLayout}
          wide={winWidth >= 1280}
          lead={lead}
          parts={{
            screen: screenEl,
            recent: lastCall || lastNote || lastVoice ? recentEl : null,
            pipeline: pipelineEl,
            approval: approvalEl,
            visit: visitEl,
            fee: feeEl,
            papers: papersEl,
            files: filesEl,
            follow: followEl,
            calls: callsEl,
            interest: interestEl,
            details: detailsEl,
            activity: activityEl,
            remove: deleteEl,
          }}
          onWhatsApp={() => (tapOpensTemplates ? setTemplateChannel('whatsapp') : whatsapp())}
          onLogWhatsApp={() => logManually('whatsapp')}
          nameOf={nameOf}
          onChanged={(message) => {
            showToast(message);
            load();
          }}
        />
      ) : (
        phoneEl
      )}

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {/* 🗑 Undo a delete */}
      {undo && (
        <View style={[styles.toast, styles.undoBar]}>
          <Text style={[styles.toastText, styles.flex]}>🗑 {undo.label}</Text>
          <Pressable onPress={undoDelete} hitSlop={10} accessibilityRole="button">
            <Text style={styles.undoText}>UNDO</Text>
          </Pressable>
        </View>
      )}

      {/* 💬 Templates for WhatsApp / SMS */}
      <TemplateSheet
        visible={!!templateChannel}
        lead={lead}
        channel={templateChannel ?? 'whatsapp'}
        settings={templates.settings}
        onClose={() => setTemplateChannel(null)}
        onPlain={() => (templateChannel === 'sms' ? lead.phone && sms(lead.phone) : whatsapp())}
        onSent={(name) => {
          showToast(`Sent with “${name}”`);
          setTimeout(load, 1500);
        }}
      />

      <CallResultSheet
        visible={sheetVisible}
        lead={{ id: lead.id, name: lead.name, phone: lead.phone, rating: lead.rating }}
        estimatedSec={estimatedSec}
        deviceCallId={noteCallId}
        channel={sheetChannel}
        waEvent={waEvent}
        onClose={closeSheet}
        onSaved={() => {
          closeSheet();
          load();
        }}
      />
    </>
  );
}

// =====================================================================
// Small building blocks
// =====================================================================
/** Inside a fold the sections lose their own card and title (the fold has them) */
const BareSection = createContext(false);

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  const bare = useContext(BareSection);
  if (bare) return <View style={styles.bare}>{children}</View>;
  return (
    <View style={styles.card}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {right && <Text style={styles.sectionRight}>{right}</Text>}
      </View>
      {children}
    </View>
  );
}

/** A note: the first 4 lines, then "View more" */
function NoteText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > 4 || text.length > 200;
  return (
    <>
      <Text style={styles.callNotes} numberOfLines={open ? undefined : 4}>
        {text}
      </Text>
      {long && (
        <Pressable onPress={() => setOpen((o) => !o)} hitSlop={8} accessibilityRole="button">
          <Text style={styles.moreLink}>{open ? 'Show less' : 'View more'}</Text>
        </Pressable>
      )}
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function PhoneRow({ label, phone, onCall }: { label: string; phone: string; onCall: (p: string) => void }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Pressable
        onPress={() => onCall(phone)}
        hitSlop={6}
        accessibilityRole="link"
        accessibilityLabel={`Call ${phone}`}
      >
        <Text style={[styles.infoValue, styles.link]}>{phone} 📞</Text>
      </Pressable>
    </View>
  );
}

function ActionButton({
  label,
  icon,
  color,
  onPress,
  onLongPress,
}: {
  label: string;
  icon: string;
  color: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.actionBtn, { backgroundColor: color }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.actionIcon}>{icon}</Text>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bare: { gap: spacing.md, padding: spacing.lg },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  flex: { flex: 1 },
  headerAction: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.textOnPrimary },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardOverdue: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 56, height: 56, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  name: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  phone: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { paddingVertical: 3, paddingHorizontal: spacing.md, borderRadius: radius.pill },
  pillText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  actions: { flexDirection: 'row', gap: spacing.sm },
  handover: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  handoverTitle: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.text },
  handoverNote: { fontSize: fontSize.small, color: colors.text },
  recent: { gap: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  recentRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  recentIcon: { fontSize: 16, marginTop: 1 },
  recentTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  recentNote: { fontWeight: fontWeight.regular },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  actionIcon: { fontSize: 20 },
  actionText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  pressed: { opacity: 0.8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  sectionRight: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.success },
  followHeader: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  followIcon: { fontSize: 22 },
  followDue: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary, marginTop: 2 },
  followDueOverdue: { color: colors.danger },
  followNone: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  followActions: { flexDirection: 'row', gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  chipSub: { fontSize: fontSize.caption, color: colors.textMuted },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  infoLabel: { fontSize: fontSize.small, color: colors.textMuted },
  infoValue: {
    flexShrink: 1,
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    textAlign: 'right',
  },
  link: { color: colors.primary },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tag: { paddingVertical: 3, paddingHorizontal: spacing.md, borderRadius: radius.pill },
  tagText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  noteIcon: { fontSize: 14 },
  moreLink: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: 2 },
  feedFilters: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  feedChip: {
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  feedChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  feedChipText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  feedChipTextOn: { color: colors.textOnPrimary },
  callRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dirBadge: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dirArrow: { fontSize: 16, fontWeight: fontWeight.bold },
  callTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  callOutcome: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  callDuration: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  phoneTag: { fontSize: 12 },
  callNotes: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  timelineRow: { flexDirection: 'row', gap: spacing.md },
  voicePlay: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  voiceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
  voiceChip: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  voiceChipText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  timelineMarker: { alignItems: 'center', width: 12 },
  timelineDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary, marginTop: 4 },
  timelineLine: { flex: 1, width: 2, backgroundColor: colors.border, marginTop: 2 },
  timelineBody: { flex: 1, paddingBottom: spacing.md, gap: 2 },
  timelineText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  timelineMeta: { fontSize: fontSize.caption, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
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
  undoBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  undoText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: '#93C5FD' },
});

/** 🎙 The voice notes of a call: tap to play, long press to delete */
function VoiceChips({
  list,
  onPlay,
  onLongPress,
}: {
  list: LeadFile[] | undefined;
  onPlay: (f: LeadFile) => void;
  onLongPress: (f: LeadFile) => void;
}) {
  if (!list || list.length === 0) return null;
  return (
    <View style={styles.voiceChips}>
      {list.map((v) => (
        <Pressable
          key={v.id}
          onPress={() => onPlay(v)}
          onLongPress={() => onLongPress(v)}
          delayLongPress={400}
          hitSlop={4}
          style={({ pressed }) => [styles.voiceChip, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Play voice note${v.duration_sec ? `, ${clock(v.duration_sec)}` : ''}`}
        >
          <Text style={styles.voiceChipText}>🎙 {v.duration_sec ? clock(v.duration_sec) : ''} ▶</Text>
        </Pressable>
      ))}
    </View>
  );
}

// =====================================================================
// 📱 The phone page's own parts
// =====================================================================
function BarBtn({ icon, label, onPress }: { icon: MIconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: md.ripple, borderless: true, radius: 21 }}
      style={p.barBtn}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MIcon name={icon} size={24} color={colors.text} />
    </Pressable>
  );
}

function RoundAction({
  icon,
  label,
  bg,
  fg,
  onPress,
  onLongPress,
}: {
  icon: MIconName;
  label: string;
  bg: string;
  fg: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={p.action}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[p.actionCircle, { backgroundColor: bg }]}>
        <MIcon name={icon} size={23} color={fg} />
      </View>
      <Text style={p.actionText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const HERO = md.heroC;

const p = StyleSheet.create({
  bar: { backgroundColor: HERO },
  barCompact: {
    backgroundColor: colors.surface,
    shadowColor: '#101840',
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  barRow: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2 },
  barTitle: { flex: 1, fontSize: 17, fontWeight: fontWeight.semibold, color: colors.text, marginLeft: 4 },
  barBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },

  content: { paddingBottom: 96 },
  hero: {
    backgroundColor: HERO,
    paddingHorizontal: 18,
    paddingBottom: 16,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  who: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 2 },
  avatarBox: { width: 66, height: 66, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 23, fontWeight: fontWeight.bold },
  ring: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 33, borderWidth: 3 },
  name: { fontSize: 21, fontWeight: fontWeight.bold, color: colors.text },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, alignSelf: 'flex-start' },
  phone: { fontSize: 14.5, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  chip: {
    fontSize: 12,
    fontWeight: fontWeight.semibold,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  chipPlain: { backgroundColor: colors.surface, color: colors.textMuted },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  action: { flex: 1, alignItems: 'center', gap: 5 },
  actionCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#101840',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  actionText: { fontSize: 11.5, fontWeight: fontWeight.medium, color: colors.text },

  body: { paddingHorizontal: 14, paddingTop: 12, gap: 10 },
  next: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: 16,
    backgroundColor: md.primaryC,
  },
  nextLate: { backgroundColor: md.errorC },
  nextToday: { backgroundColor: md.warnC },
  nextNone: { backgroundColor: md.surface1 },
  nextTitle: { fontSize: 14.5, fontWeight: fontWeight.semibold },
  nextSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  nextBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.surface },
  nextBtnText: { fontSize: 12.5, fontWeight: fontWeight.semibold, color: colors.primary },

  // Admission fold: the cards on a light tray
  tray: { gap: 10, padding: 10, backgroundColor: md.surface1 },

  fabs: { position: 'absolute', right: 16, bottom: 16, flexDirection: 'row', gap: 10 },
  fab: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 14,
    paddingRight: 18,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  fabTonal: { backgroundColor: md.primaryC },
  fabPrimary: { backgroundColor: colors.primary },
  fabText: { fontSize: 14.5, fontWeight: fontWeight.semibold },
});
