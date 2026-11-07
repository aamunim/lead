import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  ACTIVITY_PERIODS,
  activityRange,
  canOpenActivity,
  formatDuration,
  getActivitySettings,
  getTeamLost,
  listTeamActivity,
  previousRange,
  type ActivityPeriod,
  type TeamLost,
  type TeamMember,
} from '@/features/activity/api';
import { LostSection } from '@/features/activity/LostSection';
import { writeAndShareSpreadsheet } from '@/features/import-export/excel';
import { ExportWorkSheet } from '@/features/activity/ExportWorkSheet';
import { getTeamCredits } from '@/features/credits/api';
import { CellText, Chips, Tool, WebTable, webPage, type WebCol } from '@/features/web/WebTable';
import { colors, fontSize, fontWeight } from '@/shared/theme';

// =====================================================================
// 🌐⏱ Team activity on a computer screen: one line per person, every
//   number in its own column (sort by any), the period before next to
//   it (↑↓), the whole team's totals on top, Excel. A row opens that
//   person's day (the phone's page).
// =====================================================================

const ONLINE_MS = 6 * 60 * 1000;

function seen(iso: string | null): { text: string; online: boolean } {
  if (!iso) return { text: 'Never opened', online: false };
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < ONLINE_MS) return { text: '🟢 Online now', online: true };
  const min = Math.round(ms / 60000);
  if (min < 60) return { text: `${min} min ago`, online: false };
  const h = Math.round(min / 60);
  if (h < 24) return { text: `${h} h ago`, online: false };
  const d = Math.round(h / 24);
  return { text: d === 1 ? 'Yesterday' : `${d} days ago`, online: false };
}

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : '—';

type Row = TeamMember & { before: TeamMember | null };

function Delta({ now, before, time }: { now: number; before: number | null | undefined; time?: boolean }) {
  if (before == null) return null;
  const d = now - before;
  if (d === 0) return null;
  const text = time ? formatDuration(Math.abs(d)) : String(Math.abs(d));
  return (
    <Text style={{ fontSize: 11, fontWeight: fontWeight.bold, color: d > 0 ? colors.success : colors.danger }}>
      {d > 0 ? '▲ ' : '▼ '}
      {text}
    </Text>
  );
}

function Num({ v, before, time }: { v: number; before?: number | null; time?: boolean }) {
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <CellText bold>{time ? formatDuration(v) : v}</CellText>
      <Delta now={v} before={before} time={time} />
    </View>
  );
}

export function WebTeamActivity() {
  const { hasPermission } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [credits, setCredits] = useState<Map<string, number>>(new Map());
  // ❌ who marked how many leads Lost (loads by itself)
  const [lost, setLost] = useState<TeamLost | null>(null);
  // another period: never show the last period's Lost numbers meanwhile
  useEffect(() => setLost(null), [period]);
  const lostAsk = useRef(0);
  const lostBy = useMemo(() => new Map((lost?.people ?? []).map((p) => [p.user_id, p.count])), [lost]);

  useEffect(() => {
    getActivitySettings()
      .then((s) => setAllowed(canOpenActivity(s, hasPermission)))
      .catch(() => setAllowed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const range = activityRange(period);
    const prev = previousRange(range);
    setLoading(true);
    setError(null);
    try {
      const [now, before] = await Promise.all([
        listTeamActivity(range.from, range.to),
        listTeamActivity(prev.from, prev.to).catch(() => [] as TeamMember[]),
      ]);
      const b = new Map(before.map((x) => [x.user_id, x]));
      setRows(now.map((x) => ({ ...x, before: b.get(x.user_id) ?? null })));
      getTeamCredits(range.from, range.to).then(setCredits);
      // only the newest answer counts (a quick change of period)
      const ask = ++lostAsk.current;
      getTeamLost(range.from, range.to)
        .then((v) => ask === lostAsk.current && setLost(v))
        .catch(() => ask === lostAsk.current && setLost(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const totals = useMemo(() => {
    const t = { app: 0, calls: 0, connected: 0, talk: 0, actions: 0, admitted: 0, added: 0, online: 0, wa: 0 };
    for (const r of rows) {
      t.app += r.app_sec;
      t.calls += r.calls;
      t.connected += r.connected;
      t.talk += r.talk_sec;
      t.actions += r.actions;
      t.admitted += r.admitted;
      t.added += r.leads_added ?? 0;
      t.wa += (r.wa_calls ?? 0) + (r.wa_messages ?? 0);
      if (seen(r.last_seen_at).online) t.online += 1;
    }
    return t;
  }, [rows]);

  const cols: WebCol<Row>[] = [
    {
      key: 'name',
      label: 'Person',
      flex: 1.4,
      render: (r) => (
        <View>
          <CellText bold>{r.name ?? 'No name'}</CellText>
          <CellText small tone={seen(r.last_seen_at).online ? 'good' : 'muted'}>
            {seen(r.last_seen_at).text}
          </CellText>
        </View>
      ),
      sortValue: (r) => (r.name ?? '').toLowerCase(),
      text: (r) => r.name,
    },
    {
      key: 'app',
      label: 'App time',
      width: 110,
      align: 'right',
      render: (r) => <Num v={r.app_sec} before={r.before?.app_sec} time />,
      sortValue: (r) => r.app_sec,
      text: (r) => Math.round(r.app_sec / 60),
    },
    {
      key: 'calls',
      label: 'Calls',
      width: 90,
      align: 'right',
      render: (r) => <Num v={r.calls} before={r.before?.calls} />,
      sortValue: (r) => r.calls,
      text: (r) => r.calls,
    },
    {
      key: 'connected',
      label: 'Connected',
      width: 104,
      align: 'right',
      render: (r) => (
        <View style={{ alignItems: 'flex-end' }}>
          <CellText bold>{r.connected}</CellText>
          <CellText small tone="muted">
            {r.calls ? `${Math.round((r.connected / r.calls) * 100)}%` : '—'}
          </CellText>
        </View>
      ),
      sortValue: (r) => r.connected,
      text: (r) => r.connected,
    },
    {
      key: 'talk',
      label: 'Talk time',
      width: 110,
      align: 'right',
      render: (r) => <Num v={r.talk_sec} before={r.before?.talk_sec} time />,
      sortValue: (r) => r.talk_sec,
      text: (r) => Math.round(r.talk_sec / 60),
    },
    {
      key: 'wa',
      label: 'WhatsApp',
      width: 104,
      align: 'right',
      render: (r) => (
        <View style={{ alignItems: 'flex-end' }}>
          <CellText bold>{r.wa_calls ?? 0}</CellText>
          <CellText small tone="muted">{`${r.wa_messages ?? 0} msg`}</CellText>
        </View>
      ),
      sortValue: (r) => (r.wa_calls ?? 0) + (r.wa_messages ?? 0),
      text: (r) => `${r.wa_calls ?? 0} calls, ${r.wa_messages ?? 0} messages`,
    },
    {
      key: 'actions',
      label: 'Work',
      width: 90,
      align: 'right',
      render: (r) => <Num v={r.actions} before={r.before?.actions} />,
      sortValue: (r) => r.actions,
      text: (r) => r.actions,
    },
    {
      key: 'added',
      label: 'Leads added',
      width: 110,
      align: 'right',
      render: (r) => <Num v={r.leads_added ?? 0} before={r.before?.leads_added} />,
      sortValue: (r) => r.leads_added ?? 0,
      text: (r) => r.leads_added ?? 0,
    },
    {
      key: 'admitted',
      label: 'Admitted',
      width: 100,
      align: 'right',
      render: (r) => <Num v={r.admitted} before={r.before?.admitted} />,
      sortValue: (r) => r.admitted,
      text: (r) => r.admitted,
    },
    {
      key: 'lost',
      label: 'Lost',
      width: 80,
      align: 'right',
      render: (r) => (
        <CellText tone={(lostBy.get(r.user_id) ?? 0) > 0 ? undefined : 'muted'}>{`❌ ${lostBy.get(r.user_id) ?? 0}`}</CellText>
      ),
      sortValue: (r) => lostBy.get(r.user_id) ?? 0,
      text: (r) => lostBy.get(r.user_id) ?? 0,
    },
    {
      key: 'credits',
      label: 'Credits',
      width: 96,
      align: 'right',
      render: (r) => <CellText bold>{`⭐ ${Math.round(credits.get(r.user_id) ?? 0)}`}</CellText>,
      sortValue: (r) => credits.get(r.user_id) ?? 0,
      text: (r) => Math.round(credits.get(r.user_id) ?? 0),
    },
    {
      key: 'span',
      label: 'First – last',
      width: 160,
      render: (r) => (
        <CellText tone={r.first_at ? undefined : 'muted'}>
          {r.first_at ? `${clock(r.first_at)} – ${clock(r.last_at)}` : '—'}
        </CellText>
      ),
      sortValue: (r) => r.first_at ?? null,
      text: (r) => (r.first_at ? `${clock(r.first_at)} – ${clock(r.last_at)}` : null),
    },
  ];

  const excel = () => {
    const range = activityRange(period);
    writeAndShareSpreadsheet(
      `team-activity-${range.from}_${range.to}.xlsx`,
      cols.map((c) => (c.key === 'app' || c.key === 'talk' ? `${c.label} (min)` : c.label)),
      rows.map((r) => cols.map((c) => (c.text ? c.text(r) : null))),
      'Team activity',
    );
  };

  if (allowed === false)
    return (
      <View style={webPage.center}>
        <Text style={webPage.muted}>Team activity is for admins and Team Leads. (Settings → Team activity)</Text>
      </View>
    );

  return (
    <View style={webPage.screen}>
      {/* the website's top bar has the name */}
      <Stack.Screen options={{ headerShown: false }} />
      {exporting && (
        <ExportWorkSheet people={rows.map((r) => ({ id: r.user_id, name: r.name ?? 'No name' }))} onClose={() => setExporting(false)} />
      )}
      <View style={webPage.body}>
        <View style={webPage.titleRow}>
          <Text style={webPage.h1}>Team activity</Text>
          <View style={webPage.flex} />
          <Tool label="📜 Change log" onPress={() => router.push('/changes' as Href)} />
          <Tool label="⬇ Excel" onPress={excel} />
          <Tool label="📤 Export work" onPress={() => setExporting(true)} />
          <Tool label="↻" onPress={load} />
        </View>
        <Chips options={ACTIVITY_PERIODS} value={period} onChange={setPeriod} />

        {/* The whole team */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {[
            { label: 'Online now', value: String(totals.online) },
            { label: 'App time', value: formatDuration(totals.app) },
            { label: 'Calls', value: String(totals.calls) },
            {
              label: 'Connected',
              value: `${totals.connected}${totals.calls ? ` · ${Math.round((totals.connected / totals.calls) * 100)}%` : ''}`,
            },
            { label: 'Talk time', value: formatDuration(totals.talk) },
            { label: 'WhatsApp', value: String(totals.wa) },
            { label: 'Leads added', value: String(totals.added) },
            { label: 'Admitted', value: String(totals.admitted) },
            ...(lost ? [{ label: 'Lost', value: String(lost.total) }] : []),
          ].map((t) => (
            <View
              key={t.label}
              style={{
                minWidth: 130,
                flexGrow: 1,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 12,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: fontWeight.bold, color: colors.text }}>{t.value}</Text>
              <Text style={{ fontSize: fontSize.caption, color: colors.textMuted }}>{t.label}</Text>
            </View>
          ))}
        </View>

        {!!error && <Text style={{ color: colors.danger }}>{error}</Text>}
        <Text style={webPage.muted}>
          ▲▼ compared with the same length of time just before. Click a person for their day.
        </Text>
        <WebTable
          cols={cols}
          rows={rows}
          rowKey={(r) => r.user_id}
          loading={loading}
          empty="No one to show."
          onRow={(r) => router.push(`/activity/${r.user_id}` as Href)}
          initialSort={{ key: 'calls', desc: true }}
        />
        {!loading && <LostSection lost={lost} compact />}
      </View>
    </View>
  );
}
