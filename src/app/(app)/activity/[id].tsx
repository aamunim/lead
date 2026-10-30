import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutAnimation, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActivityFeedList } from '@/features/activity/ActivityFeedList';
import {
  ACTIVITY_PERIODS,
  CHANGE_KINDS,
  FEED_PAGE,
  activityRange,
  formatDuration,
  getUserDetail,
  kindOf,
  listActivityFeed,
  listTeamActivity,
  listUserDays,
  listUserSessions,
  previousRange,
  type ActivityDay,
  type ActivityPeriod,
  type AppSession,
  type ChangeKind,
  type FeedItem,
  type TeamMember,
  type UserDetail,
} from '@/features/activity/api';
import { useActivityLookups } from '@/features/activity/useLookups';
import { getTemplateReport, type TemplateReport } from '@/features/reports/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Collapsible } from '@/shared/ui/Collapsible';

// =====================================================================
// 🧑 One person's activity
//   Profile card and period on top, then sections that open and close.
//   Each closed section still shows a one-line summary. Which sections
//   are open is remembered on this phone.
// =====================================================================

type Section =
  | 'overview'
  | 'timeline'
  | 'calls'
  | 'whatsapp'
  | 'templates'
  | 'followups'
  | 'speed'
  | 'leads'
  | 'days'
  | 'sessions'
  | 'changes';

const ALL: Section[] = [
  'overview',
  'timeline',
  'calls',
  'whatsapp',
  'templates',
  'followups',
  'speed',
  'leads',
  'days',
  'sessions',
  'changes',
];
const OPEN_KEY = 'activity.detail.open';

const ROLE: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  team_lead: 'Team Lead',
  caller: 'Caller',
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const shortDay = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

function lastSeen(iso: string | null): { online: boolean; text: string } {
  if (!iso) return { online: false, text: 'Never opened the app' };
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min <= 5) return { online: true, text: 'Online now' };
  if (min < 60) return { online: false, text: `Last seen ${min} min ago` };
  const h = Math.round(min / 60);
  if (h < 24) return { online: false, text: `Last seen ${h} h ago` };
  return { online: false, text: `Last seen ${shortDay(iso)}` };
}

export default function UserActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { stages, userNames } = useActivityLookups();

  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const [member, setMember] = useState<TeamMember | null>(null);
  const [before, setBefore] = useState<TeamMember | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [tpl, setTpl] = useState<TemplateReport | null>(null);
  const [days, setDays] = useState<ActivityDay[]>([]);
  const [sessions, setSessions] = useState<AppSession[]>([]);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [kind, setKind] = useState<ChangeKind | null>(null);
  const [open, setOpen] = useState<Set<Section>>(new Set(['overview']));
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which sections were open last time
  useEffect(() => {
    AsyncStorage.getItem(OPEN_KEY)
      .then((v) => {
        if (!v) return;
        const saved = (JSON.parse(v) as string[]).filter((s): s is Section => ALL.includes(s as Section));
        if (saved.length > 0) setOpen(new Set(saved));
      })
      .catch(() => undefined);
  }, []);

  const saveOpen = (next: Set<Section>) => {
    setOpen(next);
    AsyncStorage.setItem(OPEN_KEY, JSON.stringify([...next])).catch(() => undefined);
  };
  const toggle = (s: Section) => {
    const next = new Set(open);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    saveOpen(next);
  };
  const allOpen = open.size === ALL.length;
  const toggleAll = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    saveOpen(allOpen ? new Set() : new Set(ALL));
  };

  const load = useCallback(async () => {
    if (!id) return;
    const range = activityRange(period);
    const prev = previousRange(range);
    try {
      setError(null);
      const [team, teamBefore, det, d, s, feed, t] = await Promise.all([
        listTeamActivity(range.from, range.to),
        listTeamActivity(prev.from, prev.to),
        getUserDetail(id, range.from, range.to),
        listUserDays(id, 14),
        listUserSessions(id, range.from, range.to),
        listActivityFeed({ ...range, userId: id }),
        getTemplateReport({ ...range, userId: id }).catch(() => null),
      ]);
      setTpl(t);
      setMember(team.find((m) => m.user_id === id) ?? null);
      setBefore(teamBefore.find((m) => m.user_id === id) ?? null);
      setDetail(det);
      setDays(d);
      setSessions(s);
      setItems(feed);
      setHasMore(feed.length === FEED_PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the activity.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, period]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last || !id) return;
    setLoadingMore(true);
    try {
      const rows = await listActivityFeed({ ...activityRange(period), userId: id, before: last.created_at });
      setItems((now) => [...now, ...rows.filter((r) => !now.some((x) => x.id === r.id))]);
      setHasMore(rows.length === FEED_PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const name = member?.name ?? userNames.get(String(id)) ?? 'Activity';
  const seen = lastSeen(member?.last_seen_at ?? null);
  const oneDay = period === 'today' || period === 'yesterday';
  const vsText = period === 'today' ? 'vs yesterday' : period === 'yesterday' ? 'vs the day before' : 'vs before';

  // Changes, by kind (only kinds this person has)
  const kindsHere = useMemo(() => {
    const counts = new Map<ChangeKind, number>();
    for (const i of items) {
      const k = kindOf(i.action)?.kind;
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return CHANGE_KINDS.filter((k) => counts.has(k.kind)).map((k) => ({ ...k, n: counts.get(k.kind) ?? 0 }));
  }, [items]);
  const shownItems = kind ? items.filter((i) => kindOf(i.action)?.kind === kind) : items;

  const c = detail?.calls;
  const wa = detail?.wa;
  const fu = detail?.follow_ups;
  const sp = detail?.speed;
  const ld = detail?.leads;
  const workHours = (detail?.hours ?? []).filter((h) => h.hour >= 7 && h.hour <= 22);
  const maxHour = Math.max(1, ...workHours.map((h) => h.calls + h.actions));
  const maxApp = Math.max(1, ...days.map((d) => d.app_sec));
  const stageTotal = (ld?.stages ?? []).reduce((t, s) => t + s.n, 0);

  const header = (
    <View style={styles.header}>
      {/* Profile */}
      <View style={styles.profile}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(name) || '?'}</Text>
          <View style={[styles.dot, { backgroundColor: seen.online ? colors.success : colors.border }]} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.role}>
            {member ? ROLE[member.role_key] ?? member.role_key : ''}
            {member ? ' · ' : ''}
            <Text style={seen.online ? styles.online : undefined}>{seen.text}</Text>
          </Text>
        </View>
      </View>

      {/* Period */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.noShrink} contentContainerStyle={styles.chips}>
        {ACTIVITY_PERIODS.map((p) => {
          const on = period === p.value;
          return (
            <Pressable
              key={p.value}
              onPress={() => setPeriod(p.value)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.toolbar}>
        {error ? <Text style={styles.error}>{error}</Text> : <View />}
        <Pressable onPress={toggleAll} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>{allOpen ? 'Collapse all' : 'Expand all'}</Text>
        </Pressable>
      </View>

      {/* 1. Overview */}
      <Collapsible
        icon="📊"
        title="Overview"
        accent={colors.primary}
        open={open.has('overview')}
        onToggle={() => toggle('overview')}
        summary={
          member
            ? `⏱ ${formatDuration(member.app_sec)} · 📞 ${member.calls} · 💬 ${member.wa_calls + member.wa_messages} · 🎓 ${member.admitted}`
            : '—'
        }
      >
        {member && (
          <>
            <View style={styles.tiles}>
              <Tile label="In the app" value={formatDuration(member.app_sec)} now={member.app_sec} was={before?.app_sec} />
              <Tile label="Calls" value={String(member.calls)} now={member.calls} was={before?.calls} />
              <Tile
                label="Answered"
                value={pct(member.connected, member.calls)}
                now={member.calls ? member.connected / member.calls : 0}
                was={before?.calls ? before.connected / before.calls : undefined}
              />
              <Tile label="Talk time" value={formatDuration(member.talk_sec)} now={member.talk_sec} was={before?.talk_sec} />
              <Tile
                label="WhatsApp"
                value={String(member.wa_calls + member.wa_messages)}
                now={member.wa_calls + member.wa_messages}
                was={before ? before.wa_calls + before.wa_messages : undefined}
              />
              <Tile label="Changes" value={String(member.actions)} now={member.actions} was={before?.actions} />
              <Tile label="Admitted" value={String(member.admitted)} now={member.admitted} was={before?.admitted} />
              <Tile label="Sessions" value={String(member.sessions)} now={member.sessions} was={before?.sessions} />
            </View>
            <Text style={styles.hint}>
              ↑ / ↓ {vsText}. App time counts only while the app is open and being used.
            </Text>
          </>
        )}
      </Collapsible>

      {/* 2. Day timeline */}
      <Collapsible
        icon="📅"
        title="Hour by hour"
        open={open.has('timeline')}
        onToggle={() => toggle('timeline')}
        summary={
          oneDay
            ? (detail?.gaps.length ?? 0) > 0
              ? `⚠ ${detail?.gaps.length} quiet gap${detail?.gaps.length === 1 ? '' : 's'} of 1h+ in work hours`
              : 'No long quiet gaps in work hours'
            : 'Calls and changes by hour of the day'
        }
      >
        <View style={styles.hours}>
          {workHours.map((h) => {
            const v = h.calls + h.actions;
            return (
              <View key={h.hour} style={styles.hourCol}>
                <View style={styles.hourTrack}>
                  <View style={[styles.hourBarActions, { height: `${(h.actions / maxHour) * 100}%` }]} />
                  <View style={[styles.hourBarCalls, { height: `${(h.calls / maxHour) * 100}%` }]} />
                </View>
                <Text style={styles.hourLabel}>{h.hour % 3 === 1 ? hourLabel(h.hour) : ''}</Text>
                {v > 0 && <Text style={styles.hourValue}>{v}</Text>}
              </View>
            );
          })}
        </View>
        <View style={styles.legend}>
          <Legend color={colors.primary} text="Calls" />
          <Legend color="#A5B4FC" text="Changes" />
        </View>
        {oneDay &&
          (detail?.gaps ?? []).map((g) => (
            <Text key={g.from} style={styles.gap}>
              😴 {clock(g.from)} – {clock(g.to)} · nothing for {formatDuration(Math.round((Date.parse(g.to) - Date.parse(g.from)) / 1000))}
            </Text>
          ))}
        {!oneDay && <Text style={styles.hint}>Choose Today or Yesterday to see quiet gaps.</Text>}
      </Collapsible>

      {/* 3. Phone calls */}
      <Collapsible
        icon="📞"
        title="Phone calls"
        accent={colors.success}
        open={open.has('calls')}
        onToggle={() => toggle('calls')}
        summary={c ? `${c.total} calls · ${pct(c.connected, c.total)} answered · ${formatDuration(c.talk_sec)}` : '—'}
      >
        {c && (
          <>
            <View style={styles.tiles}>
              <Tile label="Outgoing" value={String(c.outgoing)} />
              <Tile label="Incoming" value={String(c.incoming)} />
              <Tile label="Missed" value={String(c.missed)} tone={c.missed > 0 ? 'bad' : undefined} />
              <Tile label="Answered" value={pct(c.connected, c.total)} />
              <Tile label="Avg talk" value={formatDuration(c.avg_sec)} />
              <Tile label="Longest" value={formatDuration(c.longest_sec)} />
            </View>
            <Meter label="Calls with a note" part={c.with_note} whole={c.total} good />
            <Meter label="No answer / busy" part={c.no_answer} whole={c.total} />
            <Meter label="Answered but under 10 sec" part={c.short} whole={c.connected} />
          </>
        )}
      </Collapsible>

      {/* 4. WhatsApp */}
      <Collapsible
        icon="💬"
        title="WhatsApp"
        accent="#1F7A57"
        open={open.has('whatsapp')}
        onToggle={() => toggle('whatsapp')}
        summary={wa ? `${wa.calls} calls · ${wa.sent + wa.received} messages` : '—'}
      >
        {wa && (
          <View style={styles.tiles}>
            <Tile label="Calls" value={String(wa.calls)} />
            <Tile label="Answered" value={pct(wa.connected, wa.calls)} />
            <Tile label="Talk time" value={formatDuration(wa.talk_sec)} />
            <Tile label="Missed" value={String(wa.missed)} tone={wa.missed > 0 ? 'bad' : undefined} />
            <Tile label="Msgs sent" value={String(wa.sent)} />
            <Tile label="Msgs received" value={String(wa.received)} />
          </View>
        )}
      </Collapsible>

      {/* 📝 Message templates */}
      <Collapsible
        icon="📝"
        title="Message templates"
        open={open.has('templates')}
        onToggle={() => toggle('templates')}
        summary={
          tpl
            ? tpl.totals.sent > 0
              ? `${tpl.totals.sent} sent · ${tpl.totals.leads} leads · ${tpl.totals.admitted} admitted`
              : 'None sent'
            : '—'
        }
      >
        {tpl && (
          <>
            <View style={styles.tiles}>
              <Tile label="Sent" value={String(tpl.totals.sent)} />
              <Tile label="WhatsApp" value={String(tpl.totals.whatsapp)} />
              <Tile label="SMS" value={String(tpl.totals.sms)} />
              <Tile label="Replied" value={pct(tpl.totals.replied, tpl.totals.leads)} />
              <Tile label="Moved on" value={pct(tpl.totals.moved, tpl.totals.leads)} />
              <Tile label="Admitted" value={String(tpl.totals.admitted)} tone={tpl.totals.admitted > 0 ? 'good' : undefined} />
            </View>
            {tpl.templates.length > 0 && <Text style={styles.subTitle}>Templates used</Text>}
            {tpl.templates.map((t) => (
              <View key={t.id} style={styles.dayRow}>
                <Text style={[styles.dayLabel, styles.flex]} numberOfLines={1}>
                  {t.name}
                </Text>
                <Text style={styles.dayValue}>{t.sent}×</Text>
                <Text style={styles.dayMeta}>{t.leads} leads</Text>
              </View>
            ))}
            <Text style={styles.hint}>Replied / moved on / admitted: what the leads did in the 7 days after a template.</Text>
          </>
        )}
      </Collapsible>

      {/* 5. Follow-ups */}
      <Collapsible
        icon="⏰"
        title="Next calls (follow-ups)"
        accent={(fu?.overdue_now ?? 0) > 0 ? colors.danger : undefined}
        open={open.has('followups')}
        onToggle={() => toggle('followups')}
        summary={
          fu
            ? `${fu.on_time}/${fu.due} on time${fu.overdue_now > 0 ? ` · ⚠ ${fu.overdue_now} overdue now` : ''}`
            : '—'
        }
      >
        {fu && (
          <>
            <View style={styles.tiles}>
              <Tile label="Due" value={String(fu.due)} />
              <Tile label="On time" value={String(fu.on_time)} tone="good" />
              <Tile label="Late" value={String(fu.late)} tone={fu.late > 0 ? 'warn' : undefined} />
              <Tile label="Not done" value={String(fu.missed)} tone={fu.missed > 0 ? 'bad' : undefined} />
              <Tile label="Avg late by" value={fu.avg_late_min ? formatDuration(fu.avg_late_min * 60) : '—'} />
              <Tile label="Overdue now" value={String(fu.overdue_now)} tone={fu.overdue_now > 0 ? 'bad' : undefined} />
            </View>
            <Meter label="Done on time" part={fu.on_time} whole={fu.due} good />
            <Text style={styles.hint}>Up to 30 minutes after the time counts as on time.</Text>
          </>
        )}
      </Collapsible>

      {/* 6. Speed to lead */}
      <Collapsible
        icon="⚡"
        title="Speed to lead"
        open={open.has('speed')}
        onToggle={() => toggle('speed')}
        summary={
          sp && sp.given > 0
            ? `${sp.given} new leads · ${pct(sp.within_15, sp.given)} called within 15 min`
            : 'No new leads given in this period'
        }
      >
        {sp && (
          <>
            <View style={styles.tiles}>
              <Tile label="Leads given" value={String(sp.given)} />
              <Tile label="Called" value={String(sp.called)} />
              <Tile label="Typical wait" value={sp.called ? formatDuration(sp.median_min * 60) : '—'} />
              <Tile label="Not called yet" value={String(sp.not_called)} tone={sp.not_called > 0 ? 'bad' : undefined} />
            </View>
            <Meter label="Called within 15 minutes" part={sp.within_15} whole={sp.given} good />
            <Meter label="Called within 1 hour" part={sp.within_60} whole={sp.given} good />
          </>
        )}
      </Collapsible>

      {/* 7. Leads & results */}
      <Collapsible
        icon="🎯"
        title="Leads & results"
        accent="#7C3AED"
        open={open.has('leads')}
        onToggle={() => toggle('leads')}
        summary={ld ? `${ld.open_now} open · 🎓 ${ld.admitted} admitted · ✕ ${ld.lost} lost` : '—'}
      >
        {ld && (
          <>
            <View style={styles.tiles}>
              <Tile label="Open now" value={String(ld.open_now)} />
              <Tile label="New given" value={String(ld.given)} />
              <Tile label="Admitted" value={String(ld.admitted)} tone="good" />
              <Tile label="Lost" value={String(ld.lost)} tone={ld.lost > 0 ? 'warn' : undefined} />
            </View>
            {stageTotal > 0 && (
              <>
                <Text style={styles.subTitle}>Open leads by stage</Text>
                <View style={styles.stack}>
                  {ld.stages.map((s) => (
                    <View key={s.name} style={{ flex: s.n, backgroundColor: s.color }} />
                  ))}
                </View>
                <View style={styles.legendWrap}>
                  {ld.stages.map((s) => (
                    <Legend key={s.name} color={s.color} text={`${s.name} ${s.n}`} />
                  ))}
                </View>
              </>
            )}
            {ld.lost_reasons.length > 0 && (
              <>
                <Text style={styles.subTitle}>Why their leads were lost</Text>
                {ld.lost_reasons.map((r) => (
                  <Meter key={r.name} label={r.name} part={r.n} whole={ld.lost} />
                ))}
              </>
            )}
          </>
        )}
      </Collapsible>

      {/* 8. Last 14 days */}
      <Collapsible
        icon="📈"
        title="Last 14 days"
        open={open.has('days')}
        onToggle={() => toggle('days')}
        summary={<Spark values={days.map((d) => d.app_sec)} />}
      >
        {days
          .slice()
          .reverse()
          .map((d) => (
            <View
              key={d.day}
              style={styles.dayRow}
              accessible
              accessibilityLabel={`${shortDay(d.day)}: ${formatDuration(d.app_sec)} in the app, ${d.calls} calls, ${d.actions} changes`}
            >
              <Text style={styles.dayLabel}>{shortDay(d.day)}</Text>
              <View style={styles.track}>
                <View style={[styles.bar, { width: `${Math.max((d.app_sec / maxApp) * 100, d.app_sec > 0 ? 2 : 0)}%` }]} />
              </View>
              <Text style={styles.dayValue}>{formatDuration(d.app_sec)}</Text>
              <Text style={styles.dayMeta}>
                📞{d.calls}
                {d.wa ? ` 💬${d.wa}` : ''} ✎{d.actions}
              </Text>
            </View>
          ))}
      </Collapsible>

      {/* 9. App sessions */}
      <Collapsible
        icon="⏱"
        title="App sessions"
        open={open.has('sessions')}
        onToggle={() => toggle('sessions')}
        summary={
          sessions.length > 0
            ? `${sessions.length} sessions · ${clock(sessions[sessions.length - 1].started_at)} → ${
                sessions[0].ended ? clock(sessions[0].last_seen_at) : 'now'
              }`
            : 'No app time in this period'
        }
      >
        {sessions.length === 0 ? (
          <Text style={styles.hint}>No app time in this period.</Text>
        ) : (
          sessions.map((s) => (
            <View key={s.id} style={styles.sessionRow}>
              <View style={[styles.sessionDot, !s.ended && styles.sessionDotLive]} />
              <Text style={styles.sessionTime}>
                {oneDay ? '' : `${shortDay(s.started_at)} · `}
                {clock(s.started_at)} – {s.ended ? clock(s.last_seen_at) : 'now'}
              </Text>
              <Text style={styles.sessionDur}>{formatDuration(s.active_sec)}</Text>
              <Text style={styles.sessionDevice} numberOfLines={1}>
                {[s.device_label, s.app_version ? `v${s.app_version}` : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))
        )}
      </Collapsible>

      {/* 10. What they did (the list below this card) */}
      <Collapsible
        icon="📝"
        title="What they did"
        open={open.has('changes')}
        onToggle={() => toggle('changes')}
        summary={`${items.length}${hasMore ? '+' : ''} changes${kindsHere[0] ? ` · most: ${kindsHere.slice().sort((a, b) => b.n - a.n)[0].label}` : ''}`}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Pressable onPress={() => setKind(null)} style={[styles.chip, !kind && styles.chipOn]}>
            <Text style={[styles.chipText, !kind && styles.chipTextOn]}>All {items.length}</Text>
          </Pressable>
          {kindsHere.map((k) => {
            const on = kind === k.kind;
            return (
              <Pressable key={k.kind} onPress={() => setKind(on ? null : k.kind)} style={[styles.chip, on && styles.chipOn]}>
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {k.icon} {k.label} {k.n}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Pressable
          onPress={() => router.push({ pathname: '/changes', params: { userId: String(id) } } as unknown as Href)}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text style={styles.link}>Open in Change log ›</Text>
        </Pressable>
      </Collapsible>
    </View>
  );

  const showFeed = open.has('changes');

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: name }} />
      <ActivityFeedList
        items={showFeed ? shownItems : []}
        stages={stages}
        userNames={userNames}
        showUser={false}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={showFeed && hasMore && !kind}
        onLoadMore={loadMore}
        header={header}
        empty={showFeed ? 'No changes in this period.' : ''}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
      />
    </View>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function Tile({
  label,
  value,
  now,
  was,
  tone,
}: {
  label: string;
  value: string;
  now?: number;
  was?: number;
  tone?: 'good' | 'warn' | 'bad';
}) {
  let delta: { text: string; up: boolean } | null = null;
  if (now != null && was != null) {
    if (was === 0 && now > 0) delta = { text: 'new', up: true };
    else if (was > 0 && now !== was) {
      const p = Math.round(((now - was) / was) * 100);
      delta = { text: `${p > 0 ? '↑' : '↓'} ${Math.abs(p)}%`, up: p > 0 };
    }
  }
  const color = tone === 'good' ? colors.success : tone === 'warn' ? colors.warning : tone === 'bad' ? colors.danger : colors.text;
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, { color }]}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
      {delta && <Text style={[styles.delta, { color: delta.up ? colors.success : colors.danger }]}>{delta.text}</Text>}
    </View>
  );
}

function Meter({ label, part, whole, good }: { label: string; part: number; whole: number; good?: boolean }) {
  const p = whole > 0 ? part / whole : 0;
  const color = good ? (p >= 0.7 ? colors.success : p >= 0.4 ? colors.warning : colors.danger) : colors.primary;
  return (
    <View style={styles.meter}>
      <View style={styles.meterTop}>
        <Text style={styles.meterLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.meterValue}>
          {part}/{whole} · {pct(part, whole)}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.bar, { width: `${p * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{text}</Text>
    </View>
  );
}

/** A tiny bar line for a closed section ("▁▃▅█") */
function Spark({ values }: { values: number[] }) {
  const bars = '▁▂▃▄▅▆▇█';
  const max = Math.max(1, ...values);
  return <Text style={styles.spark}>{values.map((v) => bars[Math.min(7, Math.round((v / max) * 7))]).join('')}</Text>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  header: { gap: spacing.md, marginBottom: spacing.sm },
  noShrink: { flexGrow: 0, flexShrink: 0 },

  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  avatarText: { fontSize: 20, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  dot: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  name: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  role: { fontSize: fontSize.small, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  online: { color: '#BBF7D0', fontWeight: fontWeight.bold },

  chips: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.xl },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  error: { flex: 1, fontSize: fontSize.small, color: colors.danger },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  subTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text, marginTop: spacing.sm },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '30%',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    alignItems: 'center',
  },
  tileValue: { fontSize: fontSize.body, fontWeight: fontWeight.bold },
  tileLabel: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  delta: { fontSize: 10, fontWeight: fontWeight.bold, marginTop: 2 },

  meter: { gap: 4 },
  meterTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  meterLabel: { flex: 1, fontSize: fontSize.small, color: colors.text },
  meterValue: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.primary },

  hours: { flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 2 },
  hourCol: { flex: 1, alignItems: 'center', height: '100%' },
  hourTrack: { flex: 1, width: '100%', justifyContent: 'flex-end', borderRadius: 3, backgroundColor: colors.background },
  hourBarCalls: { width: '100%', backgroundColor: colors.primary, borderRadius: 2 },
  hourBarActions: { width: '100%', backgroundColor: '#A5B4FC', borderRadius: 2 },
  hourLabel: { fontSize: 9, color: colors.textMuted, marginTop: 2, height: 12 },
  hourValue: { position: 'absolute', top: -2, fontSize: 8, color: colors.textMuted },
  gap: { fontSize: fontSize.small, color: colors.danger },

  legend: { flexDirection: 'row', gap: spacing.md },
  legendWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: fontSize.caption, color: colors.textMuted },
  stack: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', backgroundColor: colors.border },

  spark: { fontSize: 12, letterSpacing: 1, color: colors.primary },

  dayRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayLabel: { width: 48, fontSize: fontSize.caption, color: colors.textMuted },
  dayValue: { width: 52, fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'right' },
  dayMeta: { width: 74, fontSize: 11, color: colors.textMuted, textAlign: 'right' },

  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  sessionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  sessionDotLive: { backgroundColor: colors.success },
  sessionTime: { fontSize: fontSize.small, color: colors.text },
  sessionDur: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  sessionDevice: { flex: 1, fontSize: 11, color: colors.textMuted, textAlign: 'right' },
});
