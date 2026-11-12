import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
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

import { Chip, s as ui, when } from '@/features/alumni/ui';
import {
  cancelBatch,
  getBatch,
  KIND_LABEL,
  listBatches,
  retryBatch,
  STATUS_LABEL,
  type DetailFilter,
  type SmsBatch,
  type SmsBatchDetail,
  type SmsMessage,
} from '@/features/sms/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📨 SMS sent: every send (sent / failed / waiting), and one send in full:
//   who got it, who didn't and why; stop the rest, send the failed again
// =====================================================================

const say = (title: string, msg: string) =>
  Platform.OS === 'web' ? window.alert(`${title}\n\n${msg}`) : Alert.alert(title, msg);
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export default function SmsScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return id ? <BatchDetail id={id} /> : <BatchList />;
}

function BatchList() {
  const [rows, setRows] = useState<SmsBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows(await listBatches(100));
      setError(null);
    } catch (e) {
      setError(errText(e));
      setRows((r) => r ?? []);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // still going out: look again every 15 s
  const busy = (rows ?? []).some((b) => b.waiting > 0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      supabase.rpc('sms_check_now' as never).then(load, load);
    }, 15000);
    return () => clearInterval(t);
  }, [busy, load]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'SMS sent' }} />
      {rows === null ? (
        <ActivityIndicator style={styles.pad} color={colors.primary} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(b) => b.id}
          contentContainerStyle={styles.list}
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
          ListHeaderComponent={error ? <Text style={ui.error}>{error}</Text> : undefined}
          ListEmptyComponent={
            <Text style={[ui.muted, styles.pad]}>
              No SMS yet. On Alumni, mark people (or “Mark all”), then tap SMS.
            </Text>
          }
          renderItem={({ item: b }) => (
            <Pressable
              onPress={() => router.push(`/alumni/sms?id=${b.id}` as Href)}
              style={({ pressed }) => [ui.card, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <View style={styles.rowTop}>
                <Text style={[styles.title, styles.flex]} numberOfLines={1}>
                  {b.audience === 'test' ? '🧪 Test' : b.name || b.message}
                </Text>
                <Text style={ui.muted}>{when(b.created_at)}</Text>
              </View>
              {!!b.name && (
                <Text style={ui.muted} numberOfLines={2}>
                  {b.message}
                </Text>
              )}
              <Counts sent={b.sent} failed={b.failed} waiting={b.waiting} cancelled={b.cancelled} total={b.total} />
              <Text style={ui.muted}>
                From {b.sender_text ?? '?'}
                {b.sender_kind ? ` (${KIND_LABEL[b.sender_kind]})` : ''}
                {b.by_name ? ` · by ${b.by_name}` : ''}
                {b.parts_sent ? ` · ${b.parts_sent} SMS used` : ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function Counts({
  sent,
  failed,
  waiting,
  cancelled,
  total,
}: {
  sent: number;
  failed: number;
  waiting: number;
  cancelled: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round(((sent + failed + cancelled) / total) * 100) : 100;
  return (
    <View style={styles.counts}>
      <Text style={styles.ok}>✅ {sent} sent</Text>
      {failed > 0 && <Text style={styles.bad}>❌ {failed} failed</Text>}
      {waiting > 0 && (
        <Text style={styles.wait}>
          ⏳ {waiting} waiting ({pct}%)
        </Text>
      )}
      {cancelled > 0 && <Text style={ui.muted}>⏹ {cancelled} stopped</Text>}
    </View>
  );
}

const FILTERS: { key: DetailFilter; label: string }[] = [
  { key: null, label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'cancelled', label: 'Stopped' },
];

function BatchDetail({ id }: { id: string }) {
  const [filter, setFilter] = useState<DetailFilter>(null);
  const [d, setD] = useState<SmsBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setD(await getBatch(id, filter));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [id, filter]);
  useEffect(() => {
    load();
  }, [load]);
  const waiting = (d?.counts.waiting ?? 0) > 0;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      supabase.rpc('sms_check_now' as never).then(load, load);
    }, 10000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const act = async (fn: () => Promise<number>, done: (n: number) => string) => {
    setBusy(true);
    try {
      say('Done', done(await fn()));
      await load();
    } catch (e) {
      say('Could not do it', errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'SMS' }} />
        {error ? (
          <Text style={[ui.error, styles.pad]}>{error}</Text>
        ) : (
          <ActivityIndicator style={styles.pad} color={colors.primary} />
        )}
      </View>
    );
  }
  const b = d.batch;
  const c = d.counts;
  const total = c.sent + c.failed + c.waiting + c.cancelled;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: b.audience === 'test' ? 'Test SMS' : b.name || 'SMS' }} />
      <FlatList
        data={d.messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.head}>
            <View style={ui.card}>
              <Text style={styles.text}>{b.message}</Text>
              <Text style={ui.muted}>
                From {b.sender_text ?? '?'}
                {b.sender_kind ? ` (${KIND_LABEL[b.sender_kind]})` : ''} · {when(b.created_at)}
                {b.by_name ? ` · by ${b.by_name}` : ''}
              </Text>
              <Counts sent={c.sent} failed={c.failed} waiting={c.waiting} cancelled={c.cancelled} total={total} />
              {c.parts > 0 && <Text style={ui.muted}>{c.parts} SMS used</Text>}
              <View style={styles.buttons}>
                {c.waiting > 0 && (
                  <Button
                    title="⏹ Stop the rest"
                    variant="danger"
                    loading={busy}
                    onPress={() =>
                      act(
                        () => cancelBatch(id),
                        (n) => `${n} SMS will not be sent.`,
                      )
                    }
                  />
                )}
                {c.failed + c.cancelled > 0 && (
                  <Button
                    title={`↻ Send again to ${c.failed + c.cancelled}`}
                    variant="secondary"
                    loading={busy}
                    onPress={() =>
                      act(
                        () => retryBatch(id),
                        (n) => `${n} SMS are in the queue again.`,
                      )
                    }
                  />
                )}
              </View>
            </View>
            <View style={ui.chips}>
              {FILTERS.map((f) => (
                <Chip
                  key={f.label}
                  text={f.label}
                  count={
                    f.key === null
                      ? total
                      : f.key === 'sent'
                        ? c.sent
                        : f.key === 'failed'
                          ? c.failed
                          : f.key === 'waiting'
                            ? c.waiting
                            : c.cancelled
                  }
                  on={filter === f.key}
                  onPress={() => setFilter(f.key)}
                />
              ))}
            </View>
            {b.audience === 'alumni' && (
              <Text style={ui.muted}>
                On Alumni → Filter → SMS you can list who got this send and who didn’t (e.g. to send them another way).
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={<Text style={[ui.muted, styles.pad]}>Nobody here.</Text>}
        renderItem={({ item }) => <Row m={item} />}
      />
    </View>
  );
}

function Row({ m }: { m: SmsMessage }) {
  const icon = m.status === 'sent' ? '✅' : m.status === 'failed' ? '❌' : m.status === 'cancelled' ? '⏹' : '⏳';
  return (
    <Pressable
      disabled={!m.alumni_id}
      onPress={() => m.alumni_id && router.push(`/alumni/${m.alumni_id}` as Href)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text style={styles.icon}>{icon}</Text>
      <View style={styles.flex}>
        <Text style={styles.text} numberOfLines={1}>
          {m.name ?? m.phone}
        </Text>
        <Text style={ui.muted} numberOfLines={2}>
          {m.phone} · {STATUS_LABEL[m.status]}
          {m.parts > 1 ? ` · ${m.parts} SMS` : ''}
          {m.sent_at ? ` · ${when(m.sent_at)}` : ''}
          {m.error ? `\n${m.error}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 80, width: '100%', maxWidth: 820, alignSelf: 'center' },
  head: { gap: spacing.md, marginBottom: spacing.sm },
  pad: { padding: spacing.xl },
  flex: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.body, color: colors.text },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  ok: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  bad: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },
  wait: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  icon: { fontSize: 18 },
  pressed: { opacity: 0.7 },
});
