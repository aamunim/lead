import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import {
  fillAlumniMessage,
  getCampaignItems,
  listAlumniCampaigns,
  markAlumniCampaign,
  type AlumniCampaign,
  type CampaignItem,
} from '@/features/alumni/api';
import { alumniChanged, Avatar, s as ui } from '@/features/alumni/ui';
import { md, Tap } from '@/features/home/md';
import { openWhatsApp } from '@/features/leads/contact';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📣 Sending a campaign: one person at a time — their message (name,
//   links filled in) → 💬 opens WhatsApp with it → marked sent, the next
//   one comes up. Skip for anyone. It goes into each person's history.
// =====================================================================

export default function CampaignRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [c, setC] = useState<AlumniCampaign | null | undefined>(undefined);
  const [items, setItems] = useState<CampaignItem[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [all, its] = await Promise.all([listAlumniCampaigns(id), getCampaignItems(id)]);
      setC(all.find((x) => x.id === id) ?? null);
      setItems(its);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setC((o) => o ?? null);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const pending = useMemo(() => items.filter((i) => !i.sent_at && !i.skipped), [items]);
  const now = items.find((i) => i.alumni_id === current && !i.sent_at && !i.skipped) ?? pending[0] ?? null;
  const text = useMemo(
    () =>
      c && now
        ? fillAlumniMessage(c.message, {
            name: now.alumni.name,
            ref_code: now.alumni.ref_code,
            batch_name: now.alumni.batch?.name ?? null,
            course_name: now.alumni.course?.name ?? null,
            update_token: now.alumni.update_token,
          })
        : '',
    [c, now],
  );

  const mark = async (sent: boolean) => {
    if (!c || !now) return;
    setBusy(true);
    setError(null);
    try {
      if (sent) {
        const ok = await openWhatsApp({ phone: now.alumni.phone, whatsapp_number: now.alumni.whatsapp_number }, text);
        if (!ok) throw new Error('Could not open WhatsApp.');
      }
      await markAlumniCampaign(c.id, now.alumni_id, sent);
      const at = new Date().toISOString();
      setItems((list) =>
        list.map((i) => (i.alumni_id === now.alumni_id ? { ...i, sent_at: sent ? at : null, skipped: !sent } : i)),
      );
      setCurrent(null);
      alumniChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  if (c === undefined) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Campaign' }} />
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  if (c === null) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Campaign' }} />
        <Text style={ui.muted}>{error ?? 'Not found.'}</Text>
      </View>
    );
  }

  const sent = items.filter((i) => i.sent_at).length;
  const skipped = items.filter((i) => i.skipped).length;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: c.name }} />
      <FlatList
        data={items}
        keyExtractor={(i) => i.alumni_id}
        contentContainerStyle={styles.content}
        initialNumToRender={20}
        windowSize={7}
        ListHeaderComponent={
          <View style={styles.head}>
            <Text style={ui.muted}>
              Sent {sent} of {items.length}
              {skipped ? ` · skipped ${skipped}` : ''} · 📨 {c.referrals} referrals · 🎓 {c.admitted} admitted since it
              began
            </Text>
            {now ? (
              <View style={[ui.card, styles.nowCard]}>
                <Text style={ui.label}>NEXT · {pending.length} LEFT</Text>
                <View style={styles.who}>
                  <Avatar name={now.alumni.name} size={44} />
                  <View style={styles.flex}>
                    <Text style={styles.name}>{now.alumni.name}</Text>
                    <Text style={ui.muted}>
                      {[now.alumni.course?.name, now.alumni.batch?.name].filter(Boolean).join(' · ') || ' '}
                    </Text>
                  </View>
                  <Tap onPress={() => router.push(`/alumni/${now.alumni_id}` as Href)} label="Open" style={styles.open}>
                    <Text style={styles.link}>Open ›</Text>
                  </Tap>
                </View>
                <Text style={styles.msg} selectable>
                  {text}
                </Text>
                {error && <Text style={ui.error}>{error}</Text>}
                <View style={styles.buttons}>
                  <View style={styles.flex}>
                    <Button title="Skip" variant="ghost" onPress={() => mark(false)} disabled={busy} fullWidth />
                  </View>
                  <View style={styles.flex2}>
                    <Button title="💬 Send on WhatsApp" onPress={() => mark(true)} loading={busy} fullWidth />
                  </View>
                </View>
              </View>
            ) : (
              <View style={ui.card}>
                <Text style={styles.name}>✅ All done</Text>
                <Text style={ui.muted}>Everyone in this campaign got it (or was skipped).</Text>
              </View>
            )}
            <Text style={styles.section}>Everyone</Text>
          </View>
        }
        renderItem={({ item }) => {
          const st = item.sent_at ? '✓ Sent' : item.skipped ? 'Skipped' : 'Waiting';
          return (
            <Tap
              onPress={() =>
                !item.sent_at && !item.skipped
                  ? setCurrent(item.alumni_id)
                  : router.push(`/alumni/${item.alumni_id}` as Href)
              }
              style={[styles.row, now?.alumni_id === item.alumni_id && styles.rowOn]}
              label={item.alumni.name}
            >
              <Text style={[styles.rowName, styles.flex]} numberOfLines={1}>
                {item.alumni.name}
              </Text>
              <Text style={[styles.status, item.sent_at ? styles.ok : item.skipped ? styles.mutedS : styles.wait]}>
                {st}
              </Text>
            </Tap>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  content: { padding: spacing.lg, gap: 2, paddingBottom: spacing.xxl },
  head: { gap: spacing.md, marginBottom: spacing.sm },
  nowCard: { gap: spacing.md },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1 },
  flex2: { flex: 2 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  open: { padding: spacing.xs, borderRadius: radius.sm, overflow: 'hidden' },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  msg: {
    fontSize: fontSize.body,
    lineHeight: 22,
    color: colors.text,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: md.waC,
  },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  section: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowOn: { backgroundColor: md.primaryC },
  rowName: { fontSize: fontSize.body, color: colors.text },
  status: { fontSize: fontSize.small, fontWeight: fontWeight.semibold },
  ok: { color: colors.success },
  mutedS: { color: colors.textMuted },
  wait: { color: colors.primary },
});
