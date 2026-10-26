import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { listUsers, type UserFilter, type UserRow } from '@/features/users/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

const FILTERS: { key: UserFilter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'active', label: 'Active' },
  { key: 'deactivated', label: 'Deactivated' },
  { key: 'all', label: 'All' },
];

export default function UsersScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('users.manage');

  const [filter, setFilter] = useState<UserFilter>('pending');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wait until the user stops typing for 300 ms before searching
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    try {
      setError(null);
      setUsers(await listUsers({ filter, search: debouncedSearch }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, debouncedSearch]);

  // Reload whenever the screen comes into view (e.g. back from editing)
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  if (!canManage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Users' }} />
        <Text style={styles.emptyTitle}>No access</Text>
        <Text style={styles.emptyText}>Only admins can manage users.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Users' }} />

      {/* Search */}
      <View style={styles.searchWrap}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, email or phone"
          placeholderTextColor={colors.textMuted}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {/* Filter chips */}
      <View style={styles.chips}>
        {FILTERS.map((f) => {
          const selected = f.key === filter;
          return (
            <Pressable
              key={f.key}
              onPress={() => {
                setLoading(true);
                setFilter(f.key);
              }}
              style={[styles.chip, selected && styles.chipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={
            error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            !error ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>
                  {filter === 'pending' ? 'No one is waiting' : 'No users found'}
                </Text>
                <Text style={styles.emptyText}>
                  {filter === 'pending'
                    ? 'New sign-ups will appear here for approval.'
                    : 'Try another filter or search.'}
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <UserCard user={item} onPress={() => router.push(`/users/${item.id}`)} />
          )}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
// One user card
// ---------------------------------------------------------------------
function UserCard({ user, onPress }: { user: UserRow; onPress: () => void }) {
  const name = user.full_name || 'No name';
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const status = user.is_active ? 'active' : user.deactivated_at ? 'deactivated' : 'pending';
  const statusStyle = STATUS_STYLES[status];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${statusStyle.label}`}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials || '?'}</Text>
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {user.email ?? user.phone ?? ''}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {user.role?.name ?? 'No role'}
          {user.branch ? ` · ${user.branch.name}` : ''}
        </Text>
      </View>

      <View style={[styles.statusPill, { backgroundColor: statusStyle.background }]}>
        <Text style={[styles.statusText, { color: statusStyle.color }]}>{statusStyle.label}</Text>
      </View>
    </Pressable>
  );
}

const STATUS_STYLES = {
  active: { label: 'Active', background: colors.successSoft, color: colors.success },
  pending: { label: 'Pending', background: colors.warningSoft, color: colors.warning },
  deactivated: { label: 'Off', background: colors.dangerSoft, color: colors.danger },
} as const;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  search: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: fontSize.body,
    color: colors.text,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chip: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  chipText: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  chipTextSelected: {
    color: colors.surface,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
    flexGrow: 1,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardPressed: { opacity: 0.7 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.primaryDark,
  },
  cardBody: { flex: 1, gap: 2 },
  name: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  meta: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
  },
  statusPill: {
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  statusText: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.xs,
  },
  emptyTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  emptyText: {
    fontSize: fontSize.small,
    color: colors.textMuted,
    textAlign: 'center',
  },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
    marginBottom: spacing.sm,
  },
  errorText: {
    fontSize: fontSize.small,
    color: colors.danger,
  },
});