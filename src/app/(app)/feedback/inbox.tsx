import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  KINDS,
  STATUS,
  answerFeedback,
  dayTime,
  isDeveloper,
  listInbox,
  type Feedback,
  type FeedbackStatus,
} from '@/features/feedback/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📥 More → Feedback inbox (the developer only): every message, newest
//   "new" ones first; open one to set its status and answer.
// =====================================================================

type Filter = 'open' | 'all' | FeedbackStatus;
const OPEN: FeedbackStatus[] = ['new', 'seen', 'working'];

export default function FeedbackInboxScreen() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const ok = await isDeveloper().catch(() => false);
    setAllowed(ok);
    if (!ok) return;
    try {
      setRows(await listInbox());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (allowed === false)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Feedback inbox' }} />
        <Text style={styles.muted}>Only the developer can see this.</Text>
      </View>
    );

  const shown = (rows ?? []).filter((r) =>
    filter === 'all' ? true : filter === 'open' ? OPEN.includes(r.status) : r.status === filter,
  );
  const count = (f: Filter) =>
    (rows ?? []).filter((r) => (f === 'all' ? true : f === 'open' ? OPEN.includes(r.status) : r.status === f)).length;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
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
    >
      <Stack.Screen options={{ title: 'Feedback inbox' }} />
      {error && <Text style={styles.error}>{error}</Text>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {(['open', 'new', 'working', 'done', 'wont', 'all'] as Filter[]).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.chip, filter === f && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: filter === f }}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>
              {f === 'open' ? 'Open' : f === 'all' ? 'All' : `${STATUS[f].icon} ${STATUS[f].label}`} · {count(f)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {rows === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : shown.length === 0 ? (
        <Text style={styles.muted}>Nothing here.</Text>
      ) : (
        shown.map((f) => (
          <Item
            key={f.id}
            f={f}
            open={openId === f.id}
            onToggle={() => setOpenId(openId === f.id ? null : f.id)}
            onSaved={load}
          />
        ))
      )}
    </ScrollView>
  );
}

function Item({
  f,
  open,
  onToggle,
  onSaved,
}: {
  f: Feedback;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const k = KINDS.find((x) => x.kind === f.kind);
  const s = STATUS[f.status];
  const [status, setStatus] = useState<FeedbackStatus>(f.status === 'new' ? 'seen' : f.status);
  const [reply, setReply] = useState(f.reply ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await answerFeedback(f.id, status, reply);
      onSaved();
      onToggle();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const info = Object.entries(f.info)
    .filter(([key]) => key !== 'update_at')
    .map(([key, v]) => `${key}: ${v}`)
    .join(' · ');

  return (
    <View style={[styles.item, f.status === 'new' && styles.itemNew]}>
      <Pressable onPress={onToggle} accessibilityRole="button" style={styles.gap}>
        <View style={styles.itemHead}>
          <Text style={styles.itemKind}>
            {k?.icon} {f.sender ?? 'Someone'}
            {f.role ? <Text style={styles.small}> · {f.role}</Text> : null}
          </Text>
          <Text style={styles.statusText}>
            {s.icon} {s.label}
          </Text>
        </View>
        <Text style={styles.message} numberOfLines={open ? undefined : 3}>
          {f.message}
        </Text>
        <Text style={styles.small}>{dayTime(f.createdAt)}</Text>
        {!!info && <Text style={styles.small}>📱 {info}</Text>}
        {!open && !!f.reply && (
          <Text style={styles.small} numberOfLines={1}>
            💬 {f.reply}
          </Text>
        )}
      </Pressable>

      {open && (
        <View style={styles.answer}>
          <View style={styles.statusRow}>
            {(['seen', 'working', 'done', 'wont'] as FeedbackStatus[]).map((st) => (
              <Pressable
                key={st}
                onPress={() => setStatus(st)}
                style={[styles.chip, status === st && styles.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: status === st }}
              >
                <Text style={[styles.chipText, status === st && styles.chipTextOn]}>
                  {STATUS[st].icon} {STATUS[st].label}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Answer (the sender sees it and gets a notification)"
            placeholderTextColor={colors.textMuted}
            multiline
            style={styles.input}
            textAlignVertical="top"
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="Save" onPress={save} loading={saving} fullWidth />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted, fontWeight: fontWeight.regular },
  error: { fontSize: fontSize.small, color: colors.danger },
  gap: { gap: spacing.xs },
  chips: { gap: spacing.sm },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  item: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemNew: { borderColor: colors.primary, borderLeftWidth: 4 },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  itemKind: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  statusText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  message: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  answer: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  input: {
    minHeight: 90,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.small,
  },
});
