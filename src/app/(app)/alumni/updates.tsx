import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  handleAlumniUpdate,
  listAlumniUpdates,
  UPDATE_FIELD_LABEL,
  type AlumniUpdateRequest,
} from '@/features/alumni/api';
import { alumniChanged, s as ui, useAlumniAccess, when } from '@/features/alumni/ui';
import { Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ✍️ Details alumni sent from their own link (/update/<token>): what
//   changes (old → new). Approve saves it on the alumnus; Reject drops it.
// =====================================================================

export default function AlumniUpdatesScreen() {
  const access = useAlumniAccess();
  const [rows, setRows] = useState<AlumniUpdateRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listAlumniUpdates());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setRows([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (r: AlumniUpdateRequest, approve: boolean) => {
    setBusy(r.id);
    setError(null);
    try {
      await handleAlumniUpdate(r.id, approve);
      setRows((list) => (list ?? []).filter((x) => x.id !== r.id));
      alumniChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => (setRefreshing(true), load().finally(() => setRefreshing(false)))}
        />
      }
    >
      <Stack.Screen options={{ title: 'Updates from alumni' }} />
      <Text style={ui.muted}>
        Each alumnus has a personal link (their page → ✍️ Update link). What they send waits here until you approve it.
      </Text>
      {!access.manage && <Text style={ui.muted}>Only people who manage alumni can approve.</Text>}
      {rows === null && <ActivityIndicator color={colors.primary} />}
      {error && <Text style={ui.error}>{error}</Text>}
      {rows?.length === 0 && <Text style={ui.muted}>Nothing waiting. ✓</Text>}
      {rows?.map((r) => (
        <View key={r.id} style={ui.card}>
          <Tap onPress={() => router.push(`/alumni/${r.alumni_id}` as Href)} label={r.alumni?.name ?? 'Alumnus'}>
            <Text style={styles.name}>{r.alumni?.name ?? 'Alumnus'} ›</Text>
          </Tap>
          <Text style={ui.muted}>Sent {when(r.created_at)}</Text>
          {Object.entries(r.data).map(([k, v]) => {
            const old = (r.alumni as Record<string, unknown> | null)?.[k] as string | null | undefined;
            return (
              <View key={k} style={styles.change}>
                <Text style={styles.field}>{UPDATE_FIELD_LABEL[k] ?? k}</Text>
                <Text style={styles.value}>
                  {old ? <Text style={styles.old}>{old} → </Text> : null}
                  <Text style={styles.new}>{v}</Text>
                </Text>
              </View>
            );
          })}
          {access.manage && (
            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button
                  title="Reject"
                  variant="ghost"
                  onPress={() => act(r, false)}
                  disabled={busy === r.id}
                  fullWidth
                />
              </View>
              <View style={styles.flex}>
                <Button title="Approve" onPress={() => act(r, true)} loading={busy === r.id} fullWidth />
              </View>
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
  change: { gap: 2, paddingVertical: 4 },
  field: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  value: { fontSize: fontSize.body, color: colors.text },
  old: { color: colors.textMuted, textDecorationLine: 'line-through' },
  new: { fontWeight: fontWeight.semibold },
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
});
