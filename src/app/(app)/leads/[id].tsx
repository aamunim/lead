import { router, Stack, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { markCallFromApp } from '@/features/call-sync/api';
import { CallResultSheet } from '@/features/calls/CallResultSheet';
import {
  directionInfo,
  formatDuration,
  listLeadCalls,
  outcomeInfo,
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
  getLead,
  listAssignableUsers,
  listLeadActivity,
  softDeleteLead,
  type ActivityItem,
  type LeadDetail,
} from '@/features/leads/api';
import { splitLeadNotes, type LeadNote } from '@/features/leads/notes';
import { PapersCard } from '@/features/papers/PapersCard';
import { PipelineCard } from '@/features/pipeline/PipelineCard';
import { formatVisitTime } from '@/features/visits/api';
import { VisitCard } from '@/features/visits/VisitCard';
import { listHolidays, listItems, type Holiday } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';

const RATING_COLOR: Record<string, string> = {
  hot: colors.hot,
  warm: colors.warm,
  cold: colors.cold,
};

// 01711234567 → 8801711234567 (for WhatsApp)
const toInternational = (phone: string) => (phone.startsWith('0') ? `88${phone}` : phone);

/** One line in "Calls & notes" */
type FeedItem =
  | { kind: 'call'; key: string; at: string; call: CallLog }
  | { kind: 'note'; key: string; at: string; note: LeadNote };

/** When a note was written: exact time, only the day, or none (typed on the edit screen) */
function noteWhen(n: LeadNote): string {
  if (n.when === 'exact') return formatDateTime(n.at);
  if (n.when === 'day') return new Date(n.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
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
  // callNote = a call-log id, when opened from the "add a note" notification
  const { id, callNote } = useLocalSearchParams<{ id: string; callNote?: string }>();
  const { hasPermission } = useAuth();

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [stageNames, setStageNames] = useState<Map<string, string>>(new Map());
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
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

  // Short message after a pipeline change (admitted, lost, moved…)
  const [toast, setToast] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const year = new Date().getFullYear();
      const [l, a, c, f, stages, users, h1, h2] = await Promise.all([
        getLead(id),
        listLeadActivity(id),
        listLeadCalls(id),
        getPendingFollowUp(id),
        listItems('pipeline_stages', { includeInactive: true }),
        // Include deactivated users so old timeline entries still show real names
        listAssignableUsers({ includeInactive: true }),
        listHolidays(year).catch(() => []),
        listHolidays(year + 1).catch(() => []),
      ]);
      setLead(l);
      setActivity(a);
      setCalls(c);
      setFollowUp(f);
      setHolidays([...h1, ...h2]);
      setStageNames(new Map(stages.map((s) => [s.id, s.name])));
      setUserNames(
        new Map(
          users.map((u) => [
            u.id,
            `${u.full_name ?? 'No name'}${u.is_active ? '' : ' (inactive)'}`,
          ]),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this lead.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

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
    setNoteCallId(String(callNote));
    setSheetVisible(true);
    // Clear it from the address, so the popup doesn't open again on reload
    router.setParams({ callNote: undefined });
  }, [callNote, lead, id]);

  const closeSheet = () => {
    setSheetVisible(false);
    setNoteCallId(null);
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
        setEstimatedSec(seconds);
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
    callStartedAt.current = Date.now();
    leftApp.current = false;
    // The app shows its own popup for this call: no "add a note" notification
    markCallFromApp(phone);
    const ok = await open(`tel:${phone}`);
    if (!ok) callStartedAt.current = null;
  };
  const sms = (phone: string) => open(`sms:${phone}`);
  const whatsapp = (phone: string) =>
    open(`whatsapp://send?phone=${toInternational(phone)}`, `https://wa.me/${toInternational(phone)}`);

  // For calls made from another phone: log without timing
  const logManually = () => {
    callStartedAt.current = null;
    setNoteCallId(null);
    setEstimatedSec(null);
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
            router.back();
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
    item.user_id ? userNames.get(item.user_id) ?? item.user_name : item.user_name;

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
        return d.to ? `Assigned to ${userNames.get(d.to) ?? 'a removed user'}` : 'Unassigned';
      case 'details_changed':
        return 'Name or phone updated';
      case 'call_logged': {
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
      case 'deleted':
        return 'Lead deleted';
      case 'restored':
        return 'Lead restored';
      default:
        return item.action.replace(/_/g, ' ');
    }
  };

  // --- calls and notes, newest first ----------------------------------
  const feed = useMemo<FeedItem[]>(() => {
    const notes = lead ? splitLeadNotes(lead.notes, lead.created_at, activity) : [];
    return [
      ...calls.map((c): FeedItem => ({ kind: 'call', key: c.id, at: c.called_at, call: c })),
      ...notes.map((n): FeedItem => ({ kind: 'note', key: n.key, at: n.at, note: n })),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [lead, calls, activity]);

  // Newest call and newest note, for the top card
  const lastCall = feed.find((f) => f.kind === 'call')?.call ?? null;
  const lastNote = feed.find((f) => f.kind === 'note')?.note ?? null;

  // Long lists show the newest few until "View more"
  const feedMore = useShowMore(feed, 3);
  const activityMore = useShowMore(activity, 5);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // --- states ----------------------------------------------------------
  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!lead) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead' }} />
        <Text style={styles.emptyTitle}>Lead not found</Text>
        <Text style={styles.muted}>{error ?? 'It may have been deleted or assigned to someone else.'}</Text>
      </View>
    );
  }

  const ratingColor = lead.rating ? RATING_COLOR[lead.rating] : colors.primary;
  const courses = lead.lead_courses.map((c) => c.course?.name).filter(Boolean) as string[];
  const tags = lead.lead_tags.map((t) => t.tag).filter(Boolean) as { id: string; name: string; color: string }[];
  const assigneeName = lead.assigned_to
    ? userNames.get(lead.assigned_to) ?? lead.assignee?.full_name ?? 'Unassigned'
    : 'Unassigned';
  const overdue = followUp ? isOverdue(followUp.due_at) : false;

  // Pipeline state
  const stageKind = lead.stage?.kind ?? 'open';
  // Admitted / cancelled leads have no more calls to plan; lost leads may have a "♻️ Revive"
  const showFollowUpCard = stageKind === 'open' || stageKind === 'lost';
  const reviveAt = followUp && followUp.purpose === 'revive' ? followUp.due_at : null;
  const nameOf = (userId: string | null | undefined) => (userId ? userNames.get(userId) ?? null : null);
  // The papers card reloads itself when the lead's courses change
  const courseKey = lead.lead_courses.map((c) => c.course?.id ?? '').join(',');

  // Call totals for the section header
  const talkSec = calls.reduce((sum, c) => sum + (c.outcome === 'connected' ? c.duration_sec ?? 0 : 0), 0);

  return (
    <>
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
        <Stack.Screen
          options={{
            title: lead.name,
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

        {/* Header card */}
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <View style={[styles.avatar, { backgroundColor: ratingColor }]}>
              <Text style={styles.avatarText}>{initials(lead.name) || '?'}</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.name}>{lead.name}</Text>
              <Text style={styles.phone}>{lead.phone}</Text>
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

          {/* Contact buttons */}
          <View style={styles.actions}>
            <ActionButton label="Call" icon="📞" color={colors.success} onPress={() => call(lead.phone)} />
            <ActionButton label="WhatsApp" icon="💬" color="#1F7A57" onPress={() => whatsapp(lead.phone)} />
            <ActionButton label="SMS" icon="✉️" color={colors.info} onPress={() => sms(lead.phone)} />
          </View>

          {/* Last call and last note at a glance */}
          {(lastCall || lastNote) && (
            <View style={styles.recent}>
              {lastCall && (
                <View style={styles.recentRow}>
                  <Text style={styles.recentIcon}>📞</Text>
                  <View style={styles.flex}>
                    <Text style={styles.recentTitle} numberOfLines={1}>
                      Last call:{' '}
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
        </View>

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

        {/* Papers: checklist and where they are kept */}
        <PapersCard
          key={`${lead.admitted_course_id ?? ''}|${courseKey}`}
          leadId={lead.id}
          stageKind={stageKind}
          stageKey={lead.stage?.key ?? null}
          onChanged={(message) => {
            if (message) showToast(message);
            load();
          }}
        />

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

                {holidays.length > 0 && (
                  <Text style={styles.hint}>Quick choices skip holidays automatically.</Text>
                )}
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

        {/* Calls and notes, in one list */}
        <Section
          title={`Calls & notes${feed.length > 0 ? ` (${feed.length})` : ''}`}
          right={talkSec > 0 ? `Talk time ${formatDuration(talkSec)}` : undefined}
        >
          {feed.length === 0 ? (
            <Text style={styles.muted}>No calls or notes yet. Tap Call above to start.</Text>
          ) : (
            feedMore.visible.map((item) => {
              if (item.kind === 'note') {
                const n = item.note;
                return (
                  <View key={item.key} style={styles.callRow}>
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
                  </View>
                );
              }

              const c = item.call;
              const info = outcomeInfo(c.outcome);
              const dir = directionInfo(c.direction);
              const duration = c.duration_sec && c.duration_sec > 0 ? formatDuration(c.duration_sec) : null;
              const fromPhone = c.source === 'phone' || c.phone_verified === true;
              return (
                <View key={item.key} style={styles.callRow}>
                  <View style={[styles.dirBadge, { backgroundColor: dir.color + '1A' }]}>
                    <Text style={[styles.dirArrow, { color: dir.color }]}>{dir.arrow}</Text>
                  </View>
                  <View style={styles.flex}>
                    <View style={styles.callTop}>
                      <Text style={[styles.callOutcome, { color: info.color }]}>
                        {c.direction === 'incoming' && c.outcome === 'connected' ? 'Incoming · ' : ''}
                        {info.label}
                      </Text>
                      {duration && <Text style={styles.callDuration}>{duration}</Text>}
                      {fromPhone && (
                        <Text style={styles.phoneTag} accessibilityLabel="From the phone's call log">
                          📱
                        </Text>
                      )}
                    </View>
                    {c.notes && <NoteText text={c.notes} />}
                    <Text style={styles.timelineMeta}>
                      {formatDateTime(c.called_at)}
                      {c.caller ? ` · ${personName(c.caller)}` : ''}
                      {c.sim_label ? ` · ${c.sim_label}` : ''}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
          <ShowMoreButton {...feedMore} />
          <Button title="+ Log a call made from another phone" variant="ghost" onPress={logManually} />
          {calls.some((c) => c.source === 'phone' || c.phone_verified) && (
            <Text style={styles.hint}>📱 = taken from the phone’s call log (real time and length)</Text>
          )}
        </Section>

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

        {/* Contact, guardian and source: the main lines, the rest under "More details" */}
        <Section title="Details">
          <PhoneRow label="Phone" phone={lead.phone} onCall={call} />
          <InfoRow label="Area" value={lead.area} />
          <InfoRow label="Source" value={lead.source?.name ?? null} />
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
                value={[lead.guardian_name, lead.guardian_relation && `(${lead.guardian_relation})`].filter(Boolean).join(' ')}
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

        {/* Activity */}
        <Section title="Activity">
          {activity.length === 0 ? (
            <Text style={styles.muted}>No activity yet.</Text>
          ) : (
            activityMore.visible.map((item, index) => {
              const who = actorName(item);
              return (
                <View key={item.id} style={styles.timelineRow}>
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
                </View>
              );
            })
          )}
          <ShowMoreButton {...activityMore} />
        </Section>

        {hasPermission('leads.delete') && (
          <Button title="Delete lead" variant="danger" onPress={confirmDelete} fullWidth />
        )}
      </ScrollView>

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      <CallResultSheet
        visible={sheetVisible}
        lead={{ id: lead.id, name: lead.name, phone: lead.phone, rating: lead.rating }}
        estimatedSec={estimatedSec}
        deviceCallId={noteCallId}
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
function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
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
      <Pressable onPress={() => onCall(phone)} hitSlop={6} accessibilityRole="link" accessibilityLabel={`Call ${phone}`}>
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
}: {
  label: string;
  icon: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
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
  infoValue: { flexShrink: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text, textAlign: 'right' },
  link: { color: colors.primary },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tag: { paddingVertical: 3, paddingHorizontal: spacing.md, borderRadius: radius.pill },
  tagText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  noteIcon: { fontSize: 14 },
  moreLink: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: 2 },
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
});