import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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

import { useAuth } from '@/features/auth/AuthProvider';
import { listLeadsByIds, type LeadListItem } from '@/features/leads/api';
import { duplicateGroups, ignoreDuplicates, type DuplicateGroup } from '@/features/leads/merge';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🔍 Possible duplicates: leads that share a number (phone, alt phone,
//   more numbers or WhatsApp). Merge them in one tap, or mark them
//   "not the same person" so they stop showing here.
// =====================================================================

type Group = DuplicateGroup & { leads: LeadListItem[] };

function ask(title: string, text: string, ok: string, run: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${text}`)) run();
    return;
  }
  Alert.alert(title, text, [
    { text: 'Cancel', style: 'cancel' },
    { text: ok, onPress: run },
  ]);
}

export default function DuplicatesScreen() {
  const { hasPermission } = useAuth();
  const allowed = hasPermission('leads.merge');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const gs = await duplicateGroups(200);
      const ids = [...new Set(gs.flatMap((g) => g.ids))];
      const leads = ids.length ? await listLeadsByIds(ids) : [];
      const byId = new Map(leads.map((l) => [l.id, l]));
      setGroups(
        gs
          .map((g) => ({ ...g, leads: g.ids.map((id) => byId.get(id)).filter(Boolean) as LeadListItem[] }))
          .filter((g) => g.leads.length > 1),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setGroups((g) => g ?? []);
    }
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const notSame = (g: Group) =>
    ask('Not the same person?', 'These leads stop showing as duplicates. Nothing else changes.', 'Not the same', () => {
      setGroups((cur) => (cur ?? []).filter((x) => x !== g));
      ignoreDuplicates(g.ids).catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not save.');
        load();
      });
    });

  if (!allowed) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Possible duplicates' }} />
        <Text style={styles.muted}>You are not allowed to merge leads. Ask an admin (Settings → Roles).</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Possible duplicates' }} />
      <FlatList
        data={groups ?? []}
        keyExtractor={(g) => g.ids.join(',')}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.head}>
            <Text style={styles.muted}>
              Leads with the same number (phone, alt phone, more numbers or WhatsApp). The same person usually: merge
              them so every call and note is in one place.
            </Text>
            {groups && groups.length > 0 && (
              <Text style={styles.count}>
                {groups.length} {groups.length === 1 ? 'group' : 'groups'}
              </Text>
            )}
            {error && <Text style={styles.error}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={
          groups === null ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : (
            <Text style={[styles.muted, styles.empty]}>✅ No duplicates found.</Text>
          )
        }
        renderItem={({ item: g }) => (
          <View style={styles.card}>
            {!!g.number && <Text style={styles.number}>☎ {g.number}</Text>}
            {g.leads.map((l) => (
              <Pressable
                key={l.id}
                onPress={() => router.push(`/leads/${l.id}` as Href)}
                style={styles.lead}
                accessibilityRole="button"
                accessibilityLabel={`Open ${l.name}`}
              >
                <View style={styles.flex}>
                  <Text style={styles.name} numberOfLines={1}>
                    {l.name}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {[
                      (l as unknown as { stage?: { name?: string } | null }).stage?.name,
                      (l as unknown as { assignee?: { full_name?: string } | null }).assignee?.full_name ??
                        'Unassigned',
                      new Date(l.created_at).toLocaleDateString(),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Text style={styles.open}>›</Text>
              </Pressable>
            ))}
            <View style={styles.actions}>
              <View style={styles.flex}>
                <Button
                  title={`🔗 Merge ${g.leads.length}`}
                  onPress={() => router.push(`/leads/merge?ids=${g.leads.map((l) => l.id).join(',')}` as Href)}
                  fullWidth
                />
              </View>
              <View style={styles.flex}>
                <Button title="Not the same" variant="ghost" onPress={() => notSame(g)} fullWidth />
              </View>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl * 2 },
  head: { gap: spacing.sm, marginBottom: spacing.sm },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  count: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  error: { fontSize: fontSize.small, color: colors.danger },
  empty: { textAlign: 'center', marginTop: spacing.xl },
  loader: { marginTop: spacing.xl },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  number: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  lead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  flex: { flex: 1 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  meta: { fontSize: fontSize.small, color: colors.textMuted },
  open: { fontSize: fontSize.title, color: colors.textMuted },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
});
