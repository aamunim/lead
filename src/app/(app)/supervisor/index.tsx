import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { getPendingFollowUp, scheduleFollowUp } from '@/features/follow-ups/api';
import { Avatar, MIcon, md, Tap } from '@/features/home/md';
import { AskTab, CoachSheet, promiseTime, ReportsTab, TipCard, type Qa } from '@/features/supervisor/AiParts';
import { ask } from '@/features/aiChance/ask';
import {
  hourText,
  listFindings,
  markFindings,
  SEVERITY,
  supervisorHome,
  teamToday,
  todayTasks,
  type Finding,
  type Severity,
  type SupervisorHome,
  type Task,
  type TeamRow,
} from '@/features/supervisor/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🧑‍💼 Supervisor
//   📋 Today: who to call first, and why
//   ⚠️ Issues: what needs attention (mine · my team), done / later / wrong
//   👥 Team (Team Leads / admins): each person today
// =====================================================================

type TabKey = 'tasks' | 'issues' | 'team' | 'reports' | 'ask';
const TABS: TabKey[] = ['tasks', 'issues', 'team', 'reports', 'ask'];

function say(text: string) {
  if (Platform.OS === 'web') window.alert(text);
  else Alert.alert('', text);
}

type Rows<T> = { key: string; rows: T[]; page: number; more: boolean };

export default function SupervisorScreen() {
  const { hasPermission, profile } = useAuth();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [home, setHome] = useState<SupervisorHome | null>(null);
  const manager = !!home && home.enabled && home.manager;
  const [tab, setTab] = useState<TabKey>(TABS.includes(params.tab as TabKey) ? (params.tab as TabKey) : 'tasks');
  const [scope, setScope] = useState<'me' | 'team'>(params.tab === 'team' ? 'team' : 'me');
  const [severity, setSeverity] = useState<Severity | null>(null);
  // a person chosen from the team (their list and their issues)
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);

  // each list remembers what it was loaded for: a new filter never shows the old rows
  const [tasks, setTasks] = useState<Rows<Task> | null>(null);
  const [issues, setIssues] = useState<Rows<Finding> | null>(null);
  const [team, setTeam] = useState<Rows<TeamRow> | null>(null);
  // marked done / not right just now (hidden at once, whatever loads meanwhile)
  const [gone, setGone] = useState<Set<string>>(new Set());
  // "N leads": their names in a small sheet
  const [leadsOf, setLeadsOf] = useState<Finding | null>(null);
  // 💬 the questions asked on this screen (a tab switch keeps them)
  const [asked, setAsked] = useState<Qa[]>([]);
  // 🧑‍🏫 a one-to-one page about this person
  const [coachFor, setCoachFor] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const req = useRef(0);

  useEffect(() => {
    if (TABS.includes(params.tab as TabKey)) setTab(params.tab as TabKey);
  }, [params.tab]);

  // me as the chosen person: my own list ("team" leaves me out)
  const self = !!who && who.id === profile?.id;
  const key = `${tab}|${scope}|${severity ?? ''}|${who?.id ?? ''}`;

  const loadHome = useCallback(() => {
    supervisorHome()
      .then(setHome)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadHome();
  }, [loadHome]);

  const loadList = useCallback(
    async (page = 0) => {
      const id = ++req.current;
      setError(null);
      try {
        if (tab === 'tasks') {
          const rows = await todayTasks(who?.id ?? null, 30);
          if (id === req.current) setTasks({ key, rows, page: 0, more: false });
        } else if (tab === 'issues') {
          const rows = await listFindings({
            scope: who && !self ? 'team' : who ? 'me' : scope,
            severity,
            user: who && !self ? who.id : null,
            page,
          });
          if (id === req.current) {
            setIssues((old) => ({
              key,
              rows: page > 0 && old?.key === key ? [...old.rows, ...rows] : rows,
              page,
              more: rows.length === 50,
            }));
          }
        } else if (tab === 'team') {
          const rows = await teamToday();
          if (id === req.current) setTeam({ key, rows, page: 0, more: false });
        }
      } catch (e) {
        if (id === req.current) setError(e instanceof Error ? e.message : 'লোড করা যায়নি।');
      }
    },
    [tab, scope, severity, who, self, key],
  );

  useEffect(() => {
    loadList(0);
  }, [loadList]);

  // a tab I may not see (or not any more, e.g. the AI was switched off): back to Today
  useEffect(() => {
    if (!home || !home.enabled) return;
    const allowed: TabKey[] = ['tasks', 'issues'];
    if (home.manager) allowed.push('team', 'reports');
    if (home.ai?.enabled && home.ai.ask) allowed.push('ask');
    if (!allowed.includes(tab)) setTab('tasks');
  }, [home, tab]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    loadHome();
    await loadList(0);
    setRefreshing(false);
  };

  const mark = useCallback(
    async (f: Finding, status: 'done' | 'wrong' | 'snoozed' | 'open', days = 1) => {
      // shown at once; put back if the server says no
      if (status === 'done' || status === 'wrong') setGone((g) => new Set(g).add(f.id));
      else {
        const until = status === 'snoozed' ? new Date(Date.now() + days * 86400000).toISOString() : null;
        setIssues((l) =>
          l ? { ...l, rows: l.rows.map((x) => (x.id === f.id ? { ...x, status, snooze_until: until } : x)) } : l,
        );
      }
      try {
        const n = await markFindings([f.id], status, days);
        if (n === 0) {
          say('এটা আর বদলানো যায় না (হয়তো নিজে থেকেই মিটে গেছে)।');
          loadList(0);
        }
        loadHome();
      } catch (e) {
        say(e instanceof Error ? e.message : 'করা যায়নি।');
        setGone((g) => {
          const next = new Set(g);
          next.delete(f.id);
          return next;
        });
        loadList(0);
      }
    },
    [loadList, loadHome],
  );

  const setPromise = useCallback(
    async (f: Finding) => {
      if (!f.lead_id) return;
      const leadId = f.lead_id;
      const at = promiseTime(typeof f.data?.at === 'string' ? f.data.at : undefined);
      const set = async () => {
        await scheduleFollowUp(leadId, at, typeof f.data?.note === 'string' ? `🤝 ${f.data.note}` : null);
      };
      try {
        // another call is planned already: ask before it is moved
        const pending = await getPendingFollowUp(leadId);
        if (pending) {
          const when = new Date(pending.due_at).toLocaleString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
          });
          ask('আগে থেকে follow-up আছে', `${when}-এ একটা কল ঠিক করা আছে। সেটা সরিয়ে প্রতিশ্রুতির দিনে নেবেন?`, [
            {
              label: 'প্রতিশ্রুতির দিনে নিন',
              run: () => {
                set()
                  .then(() => mark(f, 'done'))
                  .catch((e) => say(e instanceof Error ? e.message : 'সেট করা যায়নি।'));
              },
            },
            { label: 'আগেরটাই থাক', run: () => mark(f, 'done') },
          ]);
          return;
        }
        await set();
        say(
          `⏰ Follow-up সেট হয়েছে: ${at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`,
        );
        mark(f, 'done');
      } catch (e) {
        say(e instanceof Error ? e.message : 'সেট করা যায়নি।');
      }
    },
    [mark],
  );

  const open = useCallback((f: Finding) => {
    if (f.lead_id) router.push(`/leads/${f.lead_id}` as Href);
    else if (f.data?.route) router.push(f.data.route as Href);
    else if (f.data?.lead_ids?.length) setLeadsOf(f);
  }, []);

  const taskRows = tasks?.key === key ? tasks.rows : null;
  const issueRows = issues?.key === key ? issues.rows.filter((x) => !gone.has(x.id)) : null;
  const teamRows = team?.key === key ? team.rows : null;

  if (home && !home.enabled) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'সুপারভাইজার' }} />
        <Text style={styles.emptyIcon}>🧑‍💼</Text>
        <Text style={ui.muted}>সুপারভাইজার বন্ধ আছে।</Text>
        {hasPermission('settings.manage') && (
          <Tap onPress={() => router.push('/settings/supervisor' as Href)} label="Settings" style={styles.link}>
            <Text style={styles.linkText}>Settings-এ চালু করুন ›</Text>
          </Tap>
        )}
      </View>
    );
  }

  const me = home && home.enabled ? home.me : null;
  const t = home && home.enabled ? home.team : null;
  const ai = home && home.enabled ? home.ai : null;
  const admin = !!home && home.enabled && home.admin;
  const tabs = (
    [
      ['tasks', '📋 আজ'],
      ['issues', '⚠️ সমস্যা'],
      manager ? ['team', '👥 টিম'] : null,
      manager ? ['reports', '📊 রিপোর্ট'] : null,
      ai?.enabled && ai.ask ? ['ask', '💬 প্রশ্ন'] : null,
    ] as ([TabKey, string] | null)[]
  ).filter((x): x is [TabKey, string] => !!x);
  const shownTab: TabKey = home && !tabs.some(([k]) => k === tab) ? 'tasks' : tab;

  const header = (
    <View style={styles.head}>
      {/* the counts */}
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroIcon}>
            <MIcon name="support-agent" size={26} color={md.onPurpleC} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.heroTitle}>সুপারভাইজার</Text>
            <Text style={styles.heroSub}>কী নজর দরকার, আর আজ আগে কাকে কল করবেন</Text>
          </View>
          {hasPermission('settings.manage') && (
            <Tap
              onPress={() => router.push('/settings/supervisor' as Href)}
              label="Supervisor settings"
              style={styles.gear}
            >
              <MIcon name="settings" size={22} color={md.onPurpleC} />
            </Tap>
          )}
        </View>
        <View style={styles.tiles}>
          <Tile value={me?.urgent} label="এখনই" tone={md.errorC} ink={md.onErrorC} />
          <Tile value={me?.today} label="আজ" tone={md.warnC} ink={md.onWarnC} />
          <Tile value={me?.improve} label="উন্নতি" tone={md.okC} ink={md.onOkC} />
          {t ? (
            <Tile value={t.urgent + t.today + t.improve} label="টিমে" tone={md.primaryC} ink={md.onPrimaryC} />
          ) : null}
        </View>
      </View>

      {/* tabs */}
      <View style={styles.tabs}>
        {tabs.map(([k, label]) => (
          <Tap key={k} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]} label={label}>
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]} numberOfLines={1}>
              {label}
            </Text>
          </Tap>
        ))}
      </View>

      {who && (
        <View style={ui.chips}>
          <Chip text={`👤 ${who.name}  ✕`} on onPress={() => setWho(null)} />
        </View>
      )}

      {tab === 'issues' && (
        <View style={ui.chips}>
          {manager && !who && (
            <>
              <Chip text="আমার" on={scope === 'me'} onPress={() => setScope('me')} />
              <Chip text="টিমের" on={scope === 'team'} onPress={() => setScope('team')} />
            </>
          )}
          <Chip text="সব" on={!severity} onPress={() => setSeverity(null)} />
          {(['urgent', 'today', 'improve'] as Severity[]).map((s) => (
            <Chip
              key={s}
              text={`${SEVERITY[s].icon} ${SEVERITY[s].label}`}
              on={severity === s}
              onPress={() => setSeverity(severity === s ? null : s)}
            />
          ))}
        </View>
      )}
      {tab === 'tasks' && !who && ai?.enabled && home?.enabled && home.ai_ready && <TipCard />}
      {tab === 'tasks' && (
        <Text style={ui.muted}>
          {who ? `${who.name}-এর আজকের তালিকা` : 'আগে যাদের কল করবেন, কেন সহ।'} নাম চাপলে lead খুলবে।
        </Text>
      )}
      {tab === 'issues' && (
        <Text style={ui.muted}>✅ হয়ে গেছে · ⏳ পরে মনে করান · ❌ ভুল ধরেছে (৩০ দিন আর দেখাবে না)</Text>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
    </View>
  );

  const loading =
    (tab === 'tasks' && taskRows === null) ||
    (tab === 'issues' && issueRows === null) ||
    (tab === 'team' && teamRows === null);
  const empty = (
    <View style={styles.empty}>
      {loading ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <Text style={styles.emptyIcon}>{tab === 'team' ? '👥' : '🎉'}</Text>
          <Text style={styles.emptyTitle}>
            {tab === 'tasks' ? 'আজকের তালিকা খালি' : tab === 'issues' ? 'কোনো সমস্যা নেই' : 'কেউ নেই'}
          </Text>
          <Text style={[ui.muted, styles.centerText]}>
            {tab === 'tasks'
              ? 'কোনো follow-up, নতুন lead বা চুপচাপ সম্ভাবনাময় lead বাকি নেই।'
              : tab === 'issues'
                ? 'সব ঠিক আছে। নতুন কিছু হলে এখানে আসবে (প্রতি ১৫ মিনিটে দেখা হয়)।'
                : ''}
          </Text>
        </>
      )}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'সুপারভাইজার' }} />
      {tab === 'tasks' && (
        <FlatList
          data={taskRows ?? []}
          keyExtractor={(x) => x.lead_id}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          renderItem={({ item, index }) => <TaskRow t={item} n={index + 1} />}
        />
      )}
      {tab === 'issues' && (
        <FlatList
          data={issueRows ?? []}
          keyExtractor={(x) => x.id}
          onEndReachedThreshold={0.4}
          onEndReached={() => issues?.key === key && issues.more && loadList(issues.page + 1)}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          renderItem={({ item }) => (
            <IssueRow
              f={item}
              showWho={scope === 'team' || !!who}
              onOpen={open}
              onMark={mark}
              // (the person's own planned calls: only they set them)
              onPromise={item.user_id === profile?.id ? setPromise : undefined}
            />
          )}
        />
      )}
      {tab === 'team' && (
        <FlatList
          data={teamRows ?? []}
          keyExtractor={(x) => x.user_id}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          renderItem={({ item }) => (
            <PersonRow
              p={item}
              onIssues={() => {
                setWho({ id: item.user_id, name: item.name ?? 'No name' });
                setTab('issues');
              }}
              onTasks={() => {
                setWho({ id: item.user_id, name: item.name ?? 'No name' });
                setTab('tasks');
              }}
              onCoach={
                ai?.enabled && ai.coach && item.user_id !== profile?.id
                  ? () => setCoachFor({ id: item.user_id, name: item.name ?? 'No name' })
                  : undefined
              }
            />
          )}
        />
      )}
      {home && (shownTab === 'reports' || shownTab === 'ask') && (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        >
          {header}
          {shownTab === 'reports' ? (
            <ReportsTab
              key={refreshKey}
              admin={admin}
              canEdit={hasPermission('settings.manage')}
              aiReports={!!ai?.enabled && !!ai.reports}
            />
          ) : (
            <AskTab manager={manager} list={asked} setList={setAsked} />
          )}
        </ScrollView>
      )}
      {leadsOf && <LeadsSheet f={leadsOf} onClose={() => setLeadsOf(null)} />}
      {coachFor && <CoachSheet person={coachFor} onClose={() => setCoachFor(null)} />}
    </View>
  );
}

/** The leads behind a finding ("12 leads at the same stage"): tap one to open it */
function LeadsSheet({ f, onClose }: { f: Finding; onClose: () => void }) {
  const [rows, setRows] = useState<{ id: string; name: string; phone: string | null }[] | null>(null);
  useEffect(() => {
    const ids = (f.data?.lead_ids ?? []).slice(0, 50);
    let live = true;
    supabase
      .from('leads')
      .select('id, name, phone')
      .in('id', ids)
      .then(({ data }) => {
        if (!live) return;
        const byId = new Map(
          ((data ?? []) as { id: string; name: string; phone: string | null }[]).map((r) => [r.id, r]),
        );
        // the supervisor's order (most important first)
        setRows(ids.map((i) => byId.get(i)).filter((r): r is NonNullable<typeof r> => !!r));
      });
    return () => {
      live = false;
    };
  }, [f]);
  return (
    <Sheet title={f.title} onClose={onClose}>
      {rows === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : rows.length === 0 ? (
        <Text style={ui.muted}>এগুলোর কোনোটা আর দেখা যাচ্ছে না।</Text>
      ) : (
        rows.map((r) => (
          <Pressable
            key={r.id}
            onPress={() => {
              onClose();
              router.push(`/leads/${r.id}` as Href);
            }}
            style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {r.name}
              </Text>
              {!!r.phone && <Text style={ui.muted}>{r.phone}</Text>}
            </View>
            <MIcon name="chevron-right" color={colors.textMuted} />
          </Pressable>
        ))
      )}
    </Sheet>
  );
}

function Tile({ value, label, tone, ink }: { value: number | undefined; label: string; tone: string; ink: string }) {
  return (
    <View style={[styles.tile, { backgroundColor: tone }]}>
      <Text style={[styles.tileValue, { color: ink }]}>{value ?? '–'}</Text>
      <Text style={[styles.tileLabel, { color: ink }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const KIND_TONE: Record<Task['kind'], string> = {
  followup: md.warnC,
  new: md.primaryC,
  visit: md.okC,
  golden: md.goldC,
};

const TaskRow = memo(function TaskRow({ t, n }: { t: Task; n: number }) {
  const best = hourText(t.best_hour);
  return (
    <Pressable
      onPress={() => router.push(`/leads/${t.lead_id}` as Href)}
      android_ripple={{ color: md.ripple }}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`${n}. ${t.name}. ${t.reason}`}
    >
      <View style={[styles.num, { backgroundColor: KIND_TONE[t.kind] }]}>
        <Text style={styles.numText}>{n}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {t.name}
          {t.score != null ? <Text style={styles.score}>{`  ${t.score}`}</Text> : null}
        </Text>
        <Text style={styles.reason}>{t.reason}</Text>
        {(t.phone || best) && (
          <Text style={ui.muted} numberOfLines={1}>
            {[t.phone, best ? `🕐 ${best}` : null].filter(Boolean).join('  ·  ')}
          </Text>
        )}
      </View>
      <MIcon name="chevron-right" color={colors.textMuted} />
    </Pressable>
  );
});

const IssueRow = memo(function IssueRow({
  f,
  showWho,
  onOpen,
  onMark,
  onPromise,
}: {
  f: Finding;
  showWho: boolean;
  onOpen: (f: Finding) => void;
  onMark: (f: Finding, status: 'done' | 'wrong' | 'snoozed' | 'open', days?: number) => void;
  onPromise?: (f: Finding) => void;
}) {
  const sev = SEVERITY[f.severity];
  const canOpen = !!f.lead_id || !!f.data?.route || !!f.data?.lead_ids?.length;
  const tone = f.severity === 'urgent' ? md.errorC : f.severity === 'today' ? md.warnC : md.okC;
  return (
    <View style={[styles.card, styles.issue]}>
      <Pressable
        onPress={() => canOpen && onOpen(f)}
        style={({ pressed }) => [styles.issueTop, pressed && canOpen && styles.pressed]}
        accessibilityRole={canOpen ? 'button' : undefined}
      >
        <View style={[styles.sev, { backgroundColor: tone }]}>
          <Text style={styles.sevText}>{sev.icon}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.name}>{f.title}</Text>
          {!!f.detail && <Text style={styles.reason}>{f.detail}</Text>}
          <Text style={ui.muted} numberOfLines={1}>
            {[
              showWho ? (f.user_name ? `👤 ${f.user_name}` : '👥 পুরো টিম') : null,
              f.for_managers ? '🔒 শুধু Team Lead / admin' : null,
              f.status === 'snoozed' && f.snooze_until
                ? `⏳ ${new Date(f.snooze_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} পর্যন্ত`
                : null,
              f.data?.lead_ids?.length && !f.lead_id ? `${f.data.lead_ids.length}টা lead দেখুন ›` : null,
            ]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </View>
        {canOpen && <MIcon name="chevron-right" color={colors.textMuted} />}
      </Pressable>
      <View style={styles.actions}>
        {f.status === 'snoozed' ? (
          <Action label="↩ এখনই দেখান" onPress={() => onMark(f, 'open')} />
        ) : (
          <>
            {f.data?.action === 'followup' && f.lead_id && onPromise && (
              <Action label="⏰ ঐ দিন follow-up" onPress={() => onPromise(f)} />
            )}
            <Action label="✅ হয়ে গেছে" onPress={() => onMark(f, 'done')} />
            <Action label="⏳ কাল" onPress={() => onMark(f, 'snoozed', 1)} />
            <Action label="❌ ভুল" onPress={() => onMark(f, 'wrong')} />
          </>
        )}
      </View>
    </View>
  );
});

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} label={label} style={styles.action}>
      <Text style={styles.actionText}>{label}</Text>
    </Tap>
  );
}

const PersonRow = memo(function PersonRow({
  p,
  onIssues,
  onTasks,
  onCoach,
}: {
  p: TeamRow;
  onIssues: () => void;
  onTasks: () => void;
  onCoach?: () => void;
}) {
  const last = p.last_call
    ? new Date(p.last_call).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })
    : null;
  return (
    <View style={[styles.card, styles.issue]}>
      <View style={styles.issueTop}>
        <Avatar name={p.name ?? '?'} size={40} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>
            {p.name ?? 'No name'}
            {p.urgent ? <Text style={styles.bad}>{`  🔴 ${p.urgent}`}</Text> : null}
            {p.today ? <Text style={styles.warn}>{`  🟠 ${p.today}`}</Text> : null}
          </Text>
          <Text style={styles.reason}>
            📞 {p.calls} কল · কথা {p.talked} ({p.talk_min} মি.){last ? ` · শেষ ${last}` : ' · আজ কল নেই'}
          </Text>
          <Text style={ui.muted}>
            {p.open_leads} open lead
            {p.followups_late ? ` · ⏰ ${p.followups_late} দেরি` : ''}
            {p.new_waiting ? ` · 🆕 ${p.new_waiting} কল বাকি` : ''}
            {p.golden_quiet ? ` · 🎯 ${p.golden_quiet} চুপচাপ` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Action label="📋 তালিকা" onPress={onTasks} />
        <Action label={`⚠️ সমস্যা ${p.urgent + p.today + p.improve || ''}`.trim()} onPress={onIssues} />
        {onCoach && <Action label="🧑‍🏫 আলোচনা" onPress={onCoach} />}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  centerText: { textAlign: 'center' },
  content: { padding: spacing.lg, paddingBottom: 80, width: '100%', maxWidth: 820, alignSelf: 'center' },
  head: { gap: spacing.md, marginBottom: spacing.sm },
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  hero: { gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: md.purpleC },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: md.onPurpleC },
  heroSub: { fontSize: fontSize.small, color: md.onPurpleC },
  gear: { padding: 6, borderRadius: 18, overflow: 'hidden' },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: { flex: 1, padding: spacing.sm, borderRadius: radius.md, gap: 2 },
  tileValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  tileLabel: { fontSize: fontSize.caption },
  tabs: { flexDirection: 'row', padding: 4, gap: 4, borderRadius: radius.lg, backgroundColor: md.surface2 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.md, overflow: 'hidden' },
  tabOn: { backgroundColor: colors.surface, ...Platform.select({ web: {}, default: { elevation: 1 } }) },
  tabText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  tabTextOn: { color: colors.primary },
  link: { paddingVertical: 6, paddingHorizontal: spacing.md, borderRadius: 16, overflow: 'hidden' },
  linkText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  issue: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.sm },
  issueTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  num: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  sev: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  sevText: { fontSize: 14 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  score: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: md.onGoldC },
  reason: { fontSize: fontSize.small, color: colors.text, marginTop: 1 },
  bad: { fontSize: fontSize.small, color: md.onErrorC },
  warn: { fontSize: fontSize.small, color: md.onWarnC },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingLeft: 44 },
  action: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: md.outline,
    overflow: 'hidden',
  },
  actionText: { fontSize: fontSize.small, fontWeight: fontWeight.medium, color: colors.text },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
});
