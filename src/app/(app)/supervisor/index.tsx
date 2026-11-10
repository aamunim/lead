import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { Avatar, MIcon, md, Tap } from '@/features/home/md';
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
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🧑‍💼 Supervisor
//   📋 Today: who to call first, and why
//   ⚠️ Issues: what needs attention (mine · my team), done / later / wrong
//   👥 Team (Team Leads / admins): each person today
// =====================================================================

type TabKey = 'tasks' | 'issues' | 'team';

function say(text: string) {
  if (Platform.OS === 'web') window.alert(text);
  else Alert.alert('', text);
}

export default function SupervisorScreen() {
  const { hasPermission } = useAuth();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [home, setHome] = useState<SupervisorHome | null>(null);
  const manager = !!home && home.enabled && home.manager;
  const [tab, setTab] = useState<TabKey>(params.tab === 'team' ? 'team' : params.tab === 'issues' ? 'issues' : 'tasks');
  const [scope, setScope] = useState<'me' | 'team'>(params.tab === 'team' ? 'team' : 'me');
  const [severity, setSeverity] = useState<Severity | null>(null);
  // a person chosen from the team (their list and their issues)
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [issues, setIssues] = useState<Finding[] | null>(null);
  const [team, setTeam] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    if (params.tab === 'team' || params.tab === 'issues' || params.tab === 'tasks') setTab(params.tab);
  }, [params.tab]);

  const load = useCallback(async () => {
    const id = ++req.current;
    setError(null);
    try {
      const h = await supervisorHome();
      if (id !== req.current) return;
      setHome(h);
      if (tab === 'tasks') {
        const t = await todayTasks(who?.id ?? null, 30);
        if (id === req.current) setTasks(t);
      } else if (tab === 'issues') {
        const f = await listFindings({ scope: who ? 'team' : scope, severity, user: who?.id ?? null });
        if (id === req.current) setIssues(f);
      } else {
        const t = await teamToday();
        if (id === req.current) setTeam(t);
      }
    } catch (e) {
      if (id === req.current) setError(e instanceof Error ? e.message : 'লোড করা যায়নি।');
    }
  }, [tab, scope, severity, who]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const mark = useCallback(
    async (f: Finding, status: 'done' | 'wrong' | 'snoozed' | 'open', days = 1) => {
      // shown gone at once; back if the server says no
      setIssues((list) => (list ? list.filter((x) => x.id !== f.id || status === 'open') : list));
      try {
        await markFindings([f.id], status, days);
        if (status === 'open') load();
      } catch (e) {
        say(e instanceof Error ? e.message : 'করা যায়নি।');
        load();
      }
    },
    [load],
  );

  const open = useCallback((f: Finding) => {
    if (f.lead_id) router.push(`/leads/${f.lead_id}` as Href);
    else if (f.data?.route) router.push(f.data.route as Href);
    else if (f.data?.lead_ids?.length) {
      router.push({ pathname: '/leads', params: { ids: f.data.lead_ids.join(',') } } as unknown as Href);
    }
  }, []);

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
        {(
          [['tasks', '📋 আজকের তালিকা'], ['issues', '⚠️ সমস্যা'], ...(manager ? [['team', '👥 টিম']] : [])] as [
            TabKey,
            string,
          ][]
        ).map(([k, label]) => (
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
    (tab === 'tasks' && tasks === null) || (tab === 'issues' && issues === null) || (tab === 'team' && team === null);
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
          data={tasks ?? []}
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
          data={issues ?? []}
          keyExtractor={(x) => x.id}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          renderItem={({ item }) => (
            <IssueRow f={item} showWho={scope === 'team' || !!who} onOpen={open} onMark={mark} />
          )}
        />
      )}
      {tab === 'team' && (
        <FlatList
          data={team ?? []}
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
            />
          )}
        />
      )}
    </View>
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
}: {
  f: Finding;
  showWho: boolean;
  onOpen: (f: Finding) => void;
  onMark: (f: Finding, status: 'done' | 'wrong' | 'snoozed' | 'open', days?: number) => void;
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
}: {
  p: TeamRow;
  onIssues: () => void;
  onTasks: () => void;
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
});
