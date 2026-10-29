import { router, Stack, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import {
  channelLabel,
  directionInfo,
  formatDuration,
  listWhatsAppLogs,
  outcomeInfo,
  WHATSAPP_PAGE,
  type WhatsAppKind,
  type WhatsAppLog,
} from '@/features/calls/api';
import { contactLabel } from '@/features/leads/contact';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 💬 WhatsApp calls and messages with leads (apart from phone calls)
// =====================================================================

type Period = 'today' | '7d' | '30d';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const KINDS: { value: WhatsAppKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'calls', label: '📞 Calls' },
  { value: 'messages', label: '💬 Messages' },
];

function sinceOf(period: Period): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === '7d') d.setDate(d.getDate() - 6);
  if (period === '30d') d.setDate(d.getDate() - 29);
  return d;
}

function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

function titleOf(c: WhatsAppLog): string {
  if (c.outcome === 'message') return c.direction === 'incoming' ? 'Message received' : 'Message sent';
  const kind = c.media === 'video' ? 'video call' : 'call';
  if (c.direction === 'missed' || c.direction === 'rejected') return `Missed ${kind}`;
  const dir = c.direction === 'incoming' ? 'Incoming' : 'Outgoing';
  return `${dir} ${kind} · ${outcomeInfo(c.outcome).label}`;
}

export default function WhatsAppLogScreen() {
  const [period, setPeriod] = useState<Period>('7d');
  const [kind, setKind] = useState<WhatsAppKind>('all');
  const [items, setItems] = useState<WhatsAppLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const rows = await listWhatsAppLogs({ since: sinceOf(period), kind });
      setItems(rows);
      setHasMore(rows.length === WHATSAPP_PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period, kind]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load]),
  );

  const loadMore = async () => {
    if (!hasMore || loadingMore || items.length === 0) return;
    setLoadingMore(true);
    try {
      const rows = await listWhatsAppLogs({
        since: sinceOf(period),
        kind,
        before: items[items.length - 1].called_at,
      });
      setItems((list) => [...list, ...rows]);
      setHasMore(rows.length === WHATSAPP_PAGE);
    } catch {
      // keep what we have
    } finally {
      setLoadingMore(false);
    }
  };

  const calls = items.filter((c) => c.outcome !== 'message');
  const connected = calls.filter((c) => c.outcome === 'connected').length;
  const messages = items.length - calls.length;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'WhatsApp calls' }} />

      <View style={styles.filters}>
        <View style={styles.chips}>
          {PERIODS.map((p) => (
            <Chip key={p.value} label={p.label} on={period === p.value} onPress={() => setPeriod(p.value)} />
          ))}
        </View>
        <View style={styles.chips}>
          {KINDS.map((k) => (
            <Chip key={k.value} label={k.label} on={kind === k.value} onPress={() => setKind(k.value)} />
          ))}
        </View>
        {!loading && items.length > 0 && (
          <Text style={styles.summary}>
            {calls.length} calls ({connected} connected) · {messages} messages
            {hasMore ? ' · scroll for more' : ''}
          </Text>
        )}
      </View>

      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        ListHeaderComponent={error ? <Text style={styles.error}>{error}</Text> : undefined}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : (
            <Text style={styles.empty}>
              No WhatsApp calls or messages saved yet. After WhatsApp, the app asks what happened.
            </Text>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} /> : undefined}
        renderItem={({ item: c }) => {
          const info = outcomeInfo(c.outcome);
          const dir = directionInfo(c.direction);
          const duration = c.duration_sec && c.duration_sec > 0 ? formatDuration(c.duration_sec) : null;
          return (
            <Pressable
              onPress={() => c.lead && router.push(`/leads/${c.lead.id}` as Href)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`${c.lead?.name ?? 'Lead'}, ${channelLabel(c.channel, c.media)}, ${titleOf(c)}`}
            >
              <View style={[styles.badge, { backgroundColor: dir.color + '1A' }]}>
                <Text style={styles.badgeIcon}>{c.media === 'message' ? '💬' : c.media === 'video' ? '🎥' : '📞'}</Text>
              </View>
              <View style={styles.flex}>
                <View style={styles.top}>
                  <Text style={styles.name} numberOfLines={1}>
                    {c.lead?.name ?? 'Lead'}
                  </Text>
                  <Text style={styles.time}>{when(c.called_at)}</Text>
                </View>
                <Text style={[styles.what, { color: c.outcome === 'message' ? colors.text : info.color }]}>
                  {dir.arrow} {titleOf(c)}
                  {duration ? ` · ${duration}` : ''}
                </Text>
                {c.notes ? (
                  <Text style={styles.note} numberOfLines={2}>
                    “{c.notes}”
                  </Text>
                ) : null}
                <Text style={styles.meta} numberOfLines={1}>
                  {c.lead ? contactLabel(c.lead) : ''}
                  {c.caller?.full_name ? ` · ${c.caller.full_name}` : ''}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const WHATSAPP_GREEN = '#1F7A57';

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  filters: {
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: WHATSAPP_GREEN, borderColor: WHATSAPP_GREEN },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  summary: { fontSize: fontSize.caption, color: colors.textMuted },
  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  loader: { paddingVertical: spacing.xxl },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.xxl },
  error: { fontSize: fontSize.small, color: colors.danger, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.7 },
  badge: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  badgeIcon: { fontSize: 18 },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  time: { fontSize: fontSize.caption, color: colors.textMuted },
  what: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, marginTop: 2 },
  note: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  meta: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
});
