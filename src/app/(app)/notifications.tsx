import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { KIND_INFO, listNotifications, markRead, type AppNotification } from '@/features/notifications/api';
import { openNotificationTarget } from '@/features/notifications/open';
import { getPushPermission, registerForPush, type PushPermission } from '@/features/notifications/push';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🔔 Notifications (the last 100; push or not, they all stay here)
// =====================================================================

function when(iso: string): string {
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const iconOf = (kind: string) => KIND_INFO.find((k) => k.kind === kind)?.icon ?? '🔔';

export default function NotificationsScreen() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<PushPermission>('granted');

  const load = useCallback(async () => {
    try {
      setError(null);
      getPushPermission()
        .then(setPermission)
        .catch(() => undefined);
      setItems(await listNotifications());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the notifications.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const unread = items.filter((n) => !n.read_at).length;

  const open = (n: AppNotification) => {
    if (!n.read_at) {
      setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      markRead([n.id]).catch(() => undefined);
    }
    openNotificationTarget(n.data);
  };

  // Phone notifications are off: ask again, or open the phone's settings
  const turnOnPush = async () => {
    if (permission === 'denied') {
      Linking.openSettings();
      return;
    }
    if (await registerForPush()) setPermission('granted');
    else setPermission(await getPushPermission());
  };

  const readAll = () => {
    setItems((list) => list.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    markRead().catch(() => undefined);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'Notifications',
          headerRight: () =>
            unread > 0 ? (
              <Pressable onPress={readAll} hitSlop={10} accessibilityRole="button">
                <Text style={styles.headerAction}>Mark all read</Text>
              </Pressable>
            ) : null,
        }}
      />
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        ListHeaderComponent={
          <>
            {permission !== 'granted' && (
              <Pressable
                onPress={turnOnPush}
                style={({ pressed }) => [styles.pushOff, pressed && styles.pressed]}
                accessibilityRole="button"
              >
                <Text style={styles.icon}>📵</Text>
                <View style={styles.flex}>
                  <Text style={styles.title}>Phone notifications are off</Text>
                  <Text style={styles.body}>
                    {permission === 'denied'
                      ? 'Tap to open the phone settings and allow notifications.'
                      : 'Tap to turn them on, so you know when a lead is given to you.'}
                  </Text>
                </View>
              </Pressable>
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : (
            <Text style={styles.empty}>No notifications yet.</Text>
          )
        }
        renderItem={({ item: n }) => (
          <Pressable
            onPress={() => open(n)}
            style={({ pressed }) => [styles.row, !n.read_at && styles.rowNew, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${n.read_at ? '' : 'New. '}${n.title}. ${n.body ?? ''}`}
          >
            <Text style={styles.icon}>{iconOf(n.kind)}</Text>
            <View style={styles.flex}>
              <View style={styles.top}>
                <Text style={[styles.title, !n.read_at && styles.titleNew]} numberOfLines={2}>
                  {n.title.replace(/^\S+\s/, '')}
                </Text>
                <Text style={styles.time}>{when(n.created_at)}</Text>
              </View>
              {n.body ? (
                <Text style={styles.body} numberOfLines={4}>
                  {n.body}
                </Text>
              ) : null}
            </View>
            {!n.read_at && <View style={styles.dot} />}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  loader: { paddingVertical: spacing.xxl },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.xxl },
  error: { fontSize: fontSize.small, color: colors.danger, marginBottom: spacing.sm },
  headerAction: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
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
  pushOff: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
  },
  rowNew: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  pressed: { opacity: 0.7 },
  icon: { fontSize: 20, marginTop: 1 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  title: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  titleNew: { fontWeight: fontWeight.bold },
  time: { fontSize: fontSize.caption, color: colors.textMuted },
  body: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary, marginTop: 4 },
});
