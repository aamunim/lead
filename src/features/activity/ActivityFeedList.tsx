import { router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  describeChange,
  groupFeed,
  kindOf,
  type FeedGroup,
  type FeedItem,
  type StageInfo,
} from '@/features/activity/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// The change list: newest first, split by day; the same change to many
// leads at once is one line ("×25") that opens to show the leads.
// =====================================================================

type Row = { type: 'day'; key: string; label: string } | { type: 'group'; key: string; group: FeedGroup };

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

type Props = {
  items: FeedItem[];
  stages: Map<string, StageInfo>;
  userNames: Map<string, string>;
  /** Show who did it (off on one person's page) */
  showUser: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  header?: React.ReactElement;
  empty: string;
  refreshControl?: React.ReactElement<import('react-native').RefreshControlProps>;
};

export function ActivityFeedList({
  items,
  stages,
  userNames,
  showUser,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  header,
  empty,
  refreshControl,
}: Props) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    let lastDay = '';
    for (const g of groupFeed(items)) {
      const label = dayLabel(g.items[0].created_at);
      if (label !== lastDay) {
        out.push({ type: 'day', key: `day-${g.key}`, label });
        lastDay = label;
      }
      out.push({ type: 'group', key: g.key, group: g });
    }
    return out;
  }, [items]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      ListHeaderComponent={header}
      contentContainerStyle={styles.list}
      refreshControl={refreshControl}
      onEndReached={() => {
        if (hasMore && !loadingMore && !loading) onLoadMore();
      }}
      onEndReachedThreshold={0.4}
      renderItem={({ item }) =>
        item.type === 'day' ? (
          <Text style={styles.day}>{item.label}</Text>
        ) : (
          <GroupRow group={item.group} stages={stages} userNames={userNames} showUser={showUser} />
        )
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : (
          <Text style={styles.empty}>{empty}</Text>
        )
      }
      ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : undefined}
    />
  );
}

function GroupRow({
  group,
  stages,
  userNames,
  showUser,
}: {
  group: FeedGroup;
  stages: Map<string, StageInfo>;
  userNames: Map<string, string>;
  showUser: boolean;
}) {
  const [open, setOpen] = useState(false);
  const first = group.items[0];
  const many = group.items.length > 1;
  const kind = kindOf(first.action);
  const { text, warn } = describeChange(first, stages, userNames);

  const openLead = (id: string) => router.push(`/leads/${id}` as Href);

  return (
    <View style={[styles.row, warn && styles.rowWarn]}>
      <Pressable
        onPress={() => (many ? setOpen((o) => !o) : openLead(first.lead_id))}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${time(first.created_at)}, ${showUser ? `${first.user_name ?? 'Someone'}, ` : ''}${
          kind?.label ?? first.action
        }, ${many ? `${group.items.length} leads` : first.lead_name}: ${text}`}
      >
        <Text style={styles.time}>{time(first.created_at)}</Text>
        <Text style={styles.icon}>{warn ? '⚠️' : kind?.icon ?? '•'}</Text>
        <View style={styles.flex}>
          <Text style={styles.top} numberOfLines={1}>
            {showUser && <Text style={styles.user}>{first.user_name ?? 'Someone'} · </Text>}
            <Text style={styles.kind}>
              {kind?.label ?? first.action}
              {many ? ` ×${group.items.length}` : ''}
            </Text>
            {' · '}
            <Text style={styles.lead}>{many ? `${group.items.length} leads` : first.lead_name}</Text>
          </Text>
          <Text style={[styles.text, warn && styles.textWarn]} numberOfLines={open ? undefined : 2}>
            {text}
          </Text>
        </View>
        {many && <Text style={styles.chevron}>{open ? '▴' : '▾'}</Text>}
      </Pressable>

      {many && open && (
        <View style={styles.sub}>
          {group.items.map((i) => (
            <Pressable
              key={i.id}
              onPress={() => openLead(i.lead_id)}
              style={({ pressed }) => [styles.subRow, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.subName} numberOfLines={1}>
                {i.lead_name}
              </Text>
              <Text style={styles.subMeta}>
                {i.lead_phone} · {time(i.created_at)} ›
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  loader: { paddingVertical: spacing.xl },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.xl },
  day: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
    color: colors.textMuted,
    marginTop: spacing.md,
    textTransform: 'uppercase',
  },
  row: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  rowWarn: { borderColor: colors.danger },
  rowMain: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md },
  pressed: { opacity: 0.7 },
  time: { width: 62, fontSize: fontSize.caption, color: colors.textMuted, marginTop: 1 },
  icon: { fontSize: 15, width: 22, textAlign: 'center' },
  top: { fontSize: fontSize.small, color: colors.text },
  user: { fontWeight: fontWeight.bold, color: colors.text },
  kind: { fontWeight: fontWeight.semibold, color: colors.textMuted },
  lead: { fontWeight: fontWeight.bold, color: colors.primary },
  text: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  textWarn: { color: colors.danger, fontWeight: fontWeight.semibold },
  chevron: { fontSize: fontSize.body, color: colors.textMuted },
  sub: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  subName: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  subMeta: { fontSize: fontSize.caption, color: colors.textMuted },
});
