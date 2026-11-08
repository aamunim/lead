import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AlumniMessageSheet } from '@/features/alumni/AlumniMessageSheet';
import { createAlumniCampaign, listAlumniCampaigns, MESSAGE_VARS, type AlumniCampaign } from '@/features/alumni/api';
import { campaignDraft } from '@/features/alumni/draft';
import { alumniChanged, s as ui, useAlumniVersion, when } from '@/features/alumni/ui';
import { md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📣 Campaigns: one message to many alumni, sent one by one on WhatsApp
//   ?new=1 (from the marked alumni) → name + message ({first_name} …,
//   or ✨ AI) → the campaign; each campaign shows sent / skipped and the
//   referrals and admissions from those alumni since it began.
// =====================================================================

export default function CampaignsScreen() {
  const params = useLocalSearchParams<{ new?: string }>();
  const version = useAlumniVersion();
  const [list, setList] = useState<AlumniCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const draft = params.new === '1' ? campaignDraft.get() : [];
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [ai, setAi] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await listAlumniCampaigns());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setList([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, version]);

  const create = async () => {
    if (!name.trim() || !message.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const id = await createAlumniCampaign(name.trim(), message.trim(), draft);
      campaignDraft.clear();
      alumniChanged();
      router.replace(`/alumni/campaign?id=${id}` as Href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make it.');
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => (setRefreshing(true), load().finally(() => setRefreshing(false)))}
        />
      }
    >
      <Stack.Screen options={{ title: draft.length ? 'New campaign' : 'Campaigns' }} />

      {draft.length > 0 ? (
        <View style={ui.card}>
          <Text style={ui.label}>NEW CAMPAIGN · {draft.length} ALUMNI</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Name, e.g. January admission"
            placeholderTextColor={colors.textMuted}
            maxLength={80}
            style={styles.input}
          />
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="Hi {first_name}, …"
            placeholderTextColor={colors.textMuted}
            maxLength={2000}
            multiline
            style={[styles.input, styles.multi]}
          />
          <View style={ui.chips}>
            {MESSAGE_VARS.map((v) => (
              <Tap
                key={v}
                onPress={() => setMessage((m) => `${m}${m && !m.endsWith(' ') ? ' ' : ''}${v}`)}
                style={styles.var}
                label={`Add ${v}`}
              >
                <Text style={styles.varText}>{v}</Text>
              </Tap>
            ))}
          </View>
          <Text style={ui.muted}>
            Each person gets their own name and links. Those marked “do not contact” or with no number are left out.
          </Text>
          <Button title="✨ Write with AI" variant="secondary" onPress={() => setAi(true)} fullWidth />
          {error && <Text style={ui.error}>{error}</Text>}
          <Button
            title="Make the campaign"
            onPress={create}
            loading={saving}
            disabled={!name.trim() || !message.trim()}
            fullWidth
          />
        </View>
      ) : (
        <Text style={ui.muted}>
          To start one: on the Alumni list, mark people (or filter and “select all”), then More → 📣 Campaign.
        </Text>
      )}

      <Text style={styles.section}>Campaigns</Text>
      {list === null && <ActivityIndicator color={colors.primary} />}
      {list?.length === 0 && <Text style={ui.muted}>None yet.</Text>}
      {!draft.length && error && <Text style={ui.error}>{error}</Text>}
      {list?.map((c) => {
        const left = c.total - c.sent - c.skipped;
        return (
          <Tap
            key={c.id}
            onPress={() => router.push(`/alumni/campaign?id=${c.id}` as Href)}
            style={styles.row}
            label={c.name}
          >
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                📣 {c.name}
              </Text>
              <Text style={ui.muted} numberOfLines={1}>
                {when(c.created_at)}
                {c.by_name ? ` · ${c.by_name}` : ''}
              </Text>
              <View style={styles.bar}>
                <View style={[styles.barFill, { flex: Math.max(c.sent, 0) }]} />
                <View style={[styles.barSkip, { flex: Math.max(c.skipped, 0) }]} />
                <View style={{ flex: Math.max(left, 0) }} />
              </View>
              <Text style={styles.nums}>
                Sent {c.sent}/{c.total}
                {c.skipped ? ` · skipped ${c.skipped}` : ''} · 📨 {c.referrals} referrals ·{' '}
                <Text style={styles.ok}>🎓 {c.admitted}</Text>
              </Text>
            </View>
            {left > 0 && <Text style={styles.left}>{left} left ›</Text>}
          </Tap>
        );
      })}

      {ai && (
        <AlumniMessageSheet
          title="✨ Campaign message"
          alumniId={null}
          purposes={['campaign']}
          defaultPurpose="campaign"
          initial={message}
          sendLabel="Use this"
          onClose={() => setAi(false)}
          onSend={(t) => {
            setMessage(t);
            setAi(false);
          }}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  section: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary, marginTop: spacing.sm },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 140, paddingTop: spacing.sm, textAlignVertical: 'top' },
  var: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: md.surface2,
    overflow: 'hidden',
  },
  varText: { fontSize: fontSize.caption, color: colors.text },
  flex: { flex: 1, gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  nums: { fontSize: fontSize.small, color: colors.textMuted },
  ok: { color: colors.success, fontWeight: fontWeight.bold },
  left: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  bar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: md.surface2 },
  barFill: { backgroundColor: colors.success },
  barSkip: { backgroundColor: colors.textMuted },
});
