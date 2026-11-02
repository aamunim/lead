import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  ACTIVITY_PERIODS,
  CHANGE_KINDS,
  FEED_PAGE,
  activityRange,
  canOpenActivity,
  countActivity,
  describeChange,
  getActivitySettings,
  kindOf,
  listActivityFeed,
  type ActivityPeriod,
  type ChangeKind,
  type FeedItem,
} from '@/features/activity/api';
import { useActivityLookups } from '@/features/activity/useLookups';
import { restoreDeleted } from '@/features/calls/api';
import { writeAndShareSpreadsheet } from '@/features/import-export/excel';
import { CellText, Chips, Tool, WebTable, webPage, type WebCol } from '@/features/web/WebTable';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐📜 Change log on a computer screen: who changed what on which lead.
//   Period, person, kinds of change (with counts), search; a row opens
//   the lead; deleted calls / notes can be restored; Excel.
// =====================================================================

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })}`;
};

// 🗑 A deleted call / note can be brought back (admins, as on the phone)
const DELETES = ['call_deleted', 'call_note_deleted', 'note_deleted'];

export function WebChangeLog() {
  const { hasPermission } = useAuth();
  const canRestore = hasPermission('leads.edit_all');
  const { stages, people, userNames } = useActivityLookups();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const [userId, setUserId] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<ChangeKind>>(new Set());
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    getActivitySettings()
      .then((s) => setAllowed(canOpenActivity(s, hasPermission)))
      .catch(() => setAllowed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const actions = CHANGE_KINDS.filter((k) => kinds.has(k.kind)).flatMap((k) => k.actions);
  const actionsKey = actions.join(',');

  const load = useCallback(async () => {
    const mine = ++req.current;
    const q = { ...activityRange(period), userId, actions, search: debounced };
    setLoading(true);
    try {
      const [rows, c] = await Promise.all([listActivityFeed(q), countActivity({ ...q, actions: null })]);
      if (mine !== req.current) return;
      setItems(rows);
      setCounts(c);
      setMore(rows.length === FEED_PAGE);
    } catch (e) {
      if (mine === req.current) setMsg(e instanceof Error ? e.message : 'Could not load the changes.');
    } finally {
      if (mine === req.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, userId, actionsKey, debounced]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const rows = await listActivityFeed({
        ...activityRange(period),
        userId,
        actions,
        search: debounced,
        before: last.created_at,
      });
      setItems((now) => [...now, ...rows.filter((r) => !now.some((x) => x.id === r.id))]);
      setMore(rows.length === FEED_PAGE);
    } finally {
      setLoadingMore(false);
    }
  };

  const restore = async (it: FeedItem) => {
    if (!window.confirm('Restore it? It will show on the lead and in reports again.')) return;
    try {
      await restoreDeleted(it.id);
      setRestored((s) => new Set(s).add(it.id));
      setMsg('↩ Restored.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not restore.');
    }
  };

  const countOf = (k: (typeof CHANGE_KINDS)[number]) => k.actions.reduce((n, a) => n + (counts.get(a) ?? 0), 0);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const cols: WebCol<FeedItem>[] = [
    {
      key: 'when',
      label: 'When',
      width: 150,
      render: (r) => <CellText tone="muted">{when(r.created_at)}</CellText>,
      text: (r) => when(r.created_at),
    },
    {
      key: 'who',
      label: 'Who',
      width: 160,
      render: (r) => <CellText bold>{r.user_name ?? 'Someone'}</CellText>,
      text: (r) => r.user_name,
    },
    {
      key: 'lead',
      label: 'Lead',
      width: 190,
      render: (r) => (
        <View>
          <CellText bold>{r.lead_name}</CellText>
          {!!r.lead_phone && (
            <CellText small tone="muted">
              {r.lead_phone}
            </CellText>
          )}
        </View>
      ),
      text: (r) => r.lead_name,
    },
    {
      key: 'kind',
      label: 'Kind',
      width: 120,
      render: (r) => {
        const k = kindOf(r.action);
        return <CellText>{k ? `${k.icon} ${k.label}` : r.action}</CellText>;
      },
      text: (r) => kindOf(r.action)?.label ?? r.action,
    },
    {
      key: 'what',
      label: 'What changed',
      flex: 2,
      render: (r) => {
        const d = describeChange(r, stages, userNames);
        const done = restored.has(r.id) || !!(r.details as { restored_at?: string } | null)?.restored_at;
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text
              style={{ flex: 1, fontSize: fontSize.small, color: d.warn ? colors.danger : colors.text }}
              numberOfLines={2}
            >
              {d.text}
            </Text>
            {canRestore &&
              DELETES.includes(r.action) &&
              (done ? (
                <CellText small tone="good">
                  ✓ Restored
                </CellText>
              ) : (
                <Pressable onPress={() => restore(r)} accessibilityRole="button">
                  <Text style={{ fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary }}>
                    ↩ Restore
                  </Text>
                </Pressable>
              ))}
          </View>
        );
      },
      text: (r) => describeChange(r, stages, userNames).text,
    },
  ];

  const excel = () => {
    const range = activityRange(period);
    writeAndShareSpreadsheet(
      `change-log-${range.from}_${range.to}.xlsx`,
      cols.map((c) => c.label),
      items.map((r) => cols.map((c) => (c.text ? c.text(r) : null))),
      'Change log',
    );
  };

  if (allowed === false)
    return (
      <View style={webPage.center}>
        <Text style={webPage.muted}>The change log is for admins and Team Leads. (Settings → Team activity)</Text>
      </View>
    );

  return (
    <View style={webPage.screen}>
      {/* the website's top bar has the name */}
      <Stack.Screen options={{ headerShown: false }} />
      <View style={webPage.body}>
        <View style={webPage.titleRow}>
          <Text style={webPage.h1}>Change log</Text>
          <Text style={webPage.muted}>{total.toLocaleString('en-IN')} changes</Text>
          <View style={webPage.flex} />
          <Tool label="⏱ Team activity" onPress={() => router.push('/activity' as Href)} />
          <Tool label="⬇ Excel" onPress={excel} />
          <Tool label="↻" onPress={load} />
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'center' }}>
          <Chips options={ACTIVITY_PERIODS} value={period} onChange={setPeriod} />
          <View style={webPage.flex} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search a lead's name or phone"
            placeholderTextColor={colors.textMuted}
            style={{
              minWidth: 260,
              height: 36,
              paddingHorizontal: spacing.md,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
              color: colors.text,
              fontSize: fontSize.small,
            }}
          />
        </View>

        {/* Person */}
        <Chips
          options={[{ value: '', label: 'Everyone' }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
          value={userId ?? ''}
          onChange={(v) => setUserId(v || null)}
        />

        {/* Kinds of change, with how many */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {CHANGE_KINDS.map((k) => {
            const on = kinds.has(k.kind);
            const n = countOf(k);
            return (
              <Pressable
                key={k.kind}
                onPress={() =>
                  setKinds((now) => {
                    const next = new Set(now);
                    if (next.has(k.kind)) next.delete(k.kind);
                    else next.add(k.kind);
                    return next;
                  })
                }
                style={{
                  paddingVertical: 5,
                  paddingHorizontal: 12,
                  borderRadius: radius.pill,
                  borderWidth: 1,
                  borderColor: on ? colors.primary : colors.border,
                  backgroundColor: on ? colors.primarySoft : colors.surface,
                  opacity: n === 0 && !on ? 0.5 : 1,
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
              >
                <Text
                  style={{
                    fontSize: fontSize.small,
                    fontWeight: fontWeight.semibold,
                    color: on ? colors.primary : colors.text,
                  }}
                >
                  {k.icon} {k.label} · {n}
                </Text>
              </Pressable>
            );
          })}
          {kinds.size > 0 && (
            <Pressable onPress={() => setKinds(new Set())} accessibilityRole="button" style={{ paddingVertical: 5 }}>
              <Text style={{ fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger }}>
                ✕ Clear
              </Text>
            </Pressable>
          )}
        </View>

        {!!msg && <Text style={{ color: colors.success, fontWeight: fontWeight.semibold }}>{msg}</Text>}
        <WebTable
          cols={cols}
          rows={items}
          rowKey={(r) => r.id}
          loading={loading}
          empty="No changes in this period."
          onRow={(r) => router.push(`/leads/${r.lead_id}` as Href)}
          footer={
            more ? (
              <Pressable
                onPress={loadMore}
                style={{ padding: spacing.md, alignItems: 'center' }}
                accessibilityRole="button"
              >
                <Text style={{ fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary }}>
                  {loadingMore ? 'Loading…' : 'Show more'}
                </Text>
              </Pressable>
            ) : null
          }
        />
      </View>
    </View>
  );
}
