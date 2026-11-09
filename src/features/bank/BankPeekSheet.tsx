import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { describeChange, kindOf } from '@/features/activity/api';
import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { channelLabel, formatDuration, outcomeInfo } from '@/features/calls/api';
import { Avatar, md } from '@/features/home/md';
import { callDot } from '@/features/leads/lastActivity';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import { bankHistory, restingDays, type BankHistory, type BankRow } from './api';

// =====================================================================
// 👁 One bank number, from the bank screen: its details and, for a
//   returned one, its old lead (what it was, every call, every note,
//   every timeline line). Actions: into the leads, do not call, list,
//   delete.
// =====================================================================

type Item = {
  key: string;
  at: string;
  kind: 'call' | 'note' | 'event';
  title: string;
  text: string | null;
  by: string | null;
  dot: string;
};
type Show = 'all' | 'call' | 'note' | 'event';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const time = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function BankPeekSheet({
  row,
  onClose,
  onPull,
  onDnc,
  onMove,
  onDelete,
}: {
  row: BankRow;
  onClose: () => void;
  onPull: () => void;
  onDnc: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const returned = row.status === 'returned' && !!row.lead_id;
  const [h, setH] = useState<BankHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');

  useEffect(() => {
    if (!returned) return;
    let live = true;
    bankHistory(row.id)
      .then((r) => live && setH(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load.'));
    return () => {
      live = false;
    };
  }, [returned, row.id]);

  const items = useMemo<Item[]>(() => {
    if (!h) return [];
    const stages = new Map(Object.entries(h.stages ?? {}));
    const people = new Map(Object.entries(h.people ?? {}));
    const calls = h.calls.map((c): Item => {
      const wa = channelLabel(c.channel, c.media);
      const length = c.outcome === 'connected' ? formatDuration(c.duration_sec) : null;
      const dir = c.direction === 'incoming' ? 'Incoming ' : c.direction === 'missed' ? 'Missed ' : '';
      return {
        key: `c-${c.id}`,
        at: c.called_at,
        kind: 'call',
        title: `${wa ? `💬 ${dir}${wa}` : `📞 ${dir ? `${dir}call` : 'Call'}`} · ${outcomeInfo(c.outcome).label}${length ? ` · ${length}` : ''}`,
        text: c.notes,
        by: c.by,
        dot: callDot(c.outcome),
      };
    });
    const acts = h.activity.map((a): Item => {
      if (a.action === 'note_added') {
        return {
          key: `a-${a.id}`,
          at: a.created_at,
          kind: 'note',
          title: '📝 Note',
          text: String((a.details as { note?: string } | null)?.note ?? ''),
          by: a.by,
          dot: colors.primary,
        };
      }
      const k = kindOf(a.action);
      const d = describeChange(a, stages, people);
      if (a.action === 'bank_returned' || a.action === 'bank_pulled') {
        return {
          key: `a-${a.id}`,
          at: a.created_at,
          kind: 'event',
          title: '🏦 Lead Bank',
          text: d.text.replace(/^🏦\s*/, ''),
          by: a.by,
          dot: md.onPrimaryC,
        };
      }
      return {
        key: `a-${a.id}`,
        at: a.created_at,
        kind: 'event',
        title: `${k?.icon ?? '•'} ${k?.label ?? a.action.replace(/_/g, ' ')}`,
        text: d.text,
        by: a.by,
        dot: d.warn ? md.onWarnC : md.outline,
      };
    });
    return [...calls, ...acts].sort((x, y) => (x.at < y.at ? 1 : -1));
  }, [h]);

  const count = (k: Show) => (k === 'all' ? items.length : items.filter((i) => i.kind === k).length);
  const shown = show === 'all' ? items : items.filter((i) => i.kind === show);
  const rest = restingDays(row);
  const lead = h?.lead ?? null;

  return (
    <Sheet title={returned ? '↩️ Returned number' : '🆕 New number'} onClose={onClose}>
      {/* who */}
      <View style={styles.who}>
        <Avatar name={row.name ?? row.phone} size={48} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={2}>
            {row.name ?? 'No name'}
          </Text>
          <Text style={styles.phone} selectable>
            📞 {row.phone}
            {row.whatsapp_number ? `   💬 ${row.whatsapp_number}` : ''}
          </Text>
        </View>
      </View>

      <View style={styles.pills}>
        <Pill text={`📁 ${row.list?.name ?? 'No list'}`} />
        {row.area ? <Pill text={`📍 ${row.area}`} /> : null}
        {row.do_not_call ? <Pill text="⛔ Do not call" tone="bad" /> : null}
        {rest ? <Pill text={`⏳ Rests ${rest} more day${rest === 1 ? '' : 's'}`} tone="warn" /> : null}
        {row.times_pulled ? <Pill text={`➡️ Out ${row.times_pulled}×`} /> : null}
        {(row.tags ?? []).map((t) => (
          <Pill key={t} text={`#${t}`} />
        ))}
      </View>

      {returned && (
        <View style={[styles.box, styles.boxWarn]}>
          <Text style={styles.boxTitle}>↩️ Came back {row.returned_at ? day(row.returned_at) : ''}</Text>
          <Text style={styles.boxText}>{row.return_reason ? `Reason: ${row.return_reason}` : 'No reason given'}</Text>
        </View>
      )}
      {row.note ? (
        <View style={styles.box}>
          <Text style={styles.boxTitle}>📝 Note</Text>
          <Text style={styles.boxText}>{row.note}</Text>
        </View>
      ) : null}
      <Text style={ui.muted}>Added to the bank {day(row.created_at)}</Text>

      {/* its old lead */}
      {returned &&
        (error ? (
          <Text style={ui.error}>{error}</Text>
        ) : !h ? (
          <ActivityIndicator color={colors.primary} style={styles.loading} />
        ) : (
          <>
            {lead && (
              <View style={styles.box}>
                <Text style={styles.boxTitle}>📒 Its lead (kept with all its history)</Text>
                <Line
                  k="Stage"
                  v={
                    lead.stage_kind === 'lost'
                      ? `✕ Not Now${lead.lost_reason ? ` · ${lead.lost_reason}` : ''}`
                      : lead.stage
                  }
                />
                {lead.lost_note ? <Line k="Why" v={lead.lost_note} /> : null}
                <Line k="Course" v={lead.courses} />
                <Line k="Was with" v={lead.owner} />
                <Line k="Source" v={lead.source} />
                <Line k="Lead since" v={day(lead.created_at)} />
              </View>
            )}

            <View style={ui.chips}>
              {(
                [
                  ['all', 'All'],
                  ['call', '📞 Calls'],
                  ['note', '📝 Notes'],
                  ['event', '🕘 Activity'],
                ] as [Show, string][]
              ).map(([k, label]) => (
                <Chip key={k} text={`${label} · ${count(k)}`} on={show === k} onPress={() => setShow(k)} />
              ))}
            </View>

            {shown.length === 0 ? (
              <Text style={[ui.muted, styles.empty]}>Nothing here.</Text>
            ) : (
              <View style={styles.timeline}>
                {shown.map((it) => (
                  <View key={it.key} style={styles.item}>
                    <View style={[styles.dot, { backgroundColor: it.dot }]} />
                    <View style={styles.flex}>
                      <Text style={styles.itemTitle}>{it.title}</Text>
                      {it.text ? <Text style={styles.itemText}>{it.text}</Text> : null}
                      <Text style={styles.itemWhen}>
                        {time(it.at)}
                        {it.by ? ` · ${it.by}` : ''}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        ))}

      {/* what to do with it */}
      <View style={styles.actions}>
        <Button
          title={returned ? '➡️ Back into the leads' : '➡️ Into the leads'}
          onPress={onPull}
          disabled={row.do_not_call || !!rest}
          fullWidth
        />
        {(row.do_not_call || !!rest) && (
          <Text style={ui.muted}>
            {row.do_not_call
              ? 'Marked “do not call”: turn it off first.'
              : 'Still resting: it can go out when the rest ends.'}
          </Text>
        )}
        <View style={styles.row}>
          <View style={styles.flex}>
            <Button
              title={row.do_not_call ? 'Can call' : '⛔ Do not call'}
              variant="secondary"
              onPress={onDnc}
              fullWidth
            />
          </View>
          <View style={styles.flex}>
            <Button title="📁 List" variant="secondary" onPress={onMove} fullWidth />
          </View>
        </View>
        <Button title="Delete from the bank" variant="ghost" onPress={onDelete} fullWidth />
      </View>
    </Sheet>
  );
}

function Pill({ text, tone }: { text: string; tone?: 'bad' | 'warn' }) {
  const bg = tone === 'bad' ? md.errorC : tone === 'warn' ? md.warnC : md.surface2;
  const fg = tone === 'bad' ? md.onErrorC : tone === 'warn' ? md.onWarnC : colors.text;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{text}</Text>
    </View>
  );
}

function Line({ k, v }: { k: string; v: string | null | undefined }) {
  if (!v) return null;
  return (
    <View style={styles.line}>
      <Text style={styles.lineKey}>{k}</Text>
      <Text style={styles.lineValue}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  phone: { fontSize: fontSize.body, color: colors.text, marginTop: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm },
  pillText: { fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  box: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: md.surface1 },
  boxWarn: { backgroundColor: md.warnC },
  boxTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  boxText: { fontSize: fontSize.small, color: colors.text },
  line: { flexDirection: 'row', gap: spacing.sm },
  lineKey: { width: 84, fontSize: fontSize.small, color: colors.textMuted },
  lineValue: { flex: 1, fontSize: fontSize.small, color: colors.text },
  loading: { marginVertical: spacing.lg },
  empty: { textAlign: 'center', paddingVertical: spacing.md },
  timeline: { gap: spacing.md, paddingLeft: 2 },
  item: { flexDirection: 'row', gap: spacing.md },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  itemTitle: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  itemText: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  itemWhen: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  actions: { gap: spacing.sm, paddingTop: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
});
