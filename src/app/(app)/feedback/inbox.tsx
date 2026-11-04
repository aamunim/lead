import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
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
  cleanupOldFiles,
  dayTime,
  isDeveloper,
  listCrashes,
  listInbox,
  solveCrash,
  solveFeedback,
  type Crash,
  type Feedback,
  type FeedbackStatus,
} from '@/features/feedback/api';
import { AttachmentView } from '@/features/feedback/Attachments';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📥 More → Feedback inbox (the developer only): every message, newest
//   "new" ones first; open one to set its status and answer.
// =====================================================================

type Filter = 'open' | 'all' | 'crashes' | FeedbackStatus;
const OPEN: FeedbackStatus[] = ['new', 'seen', 'working'];

export default function FeedbackInboxScreen() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useLocalSearchParams<{ tab?: string }>();
  const [filter, setFilter] = useState<Filter>(params.tab === 'crashes' ? 'crashes' : 'open');
  // 💥 crash reports, and whether solved ones show too
  const [crashes, setCrashes] = useState<Crash[] | null>(null);
  const [showSolvedCrashes, setShowSolvedCrashes] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const ok = await isDeveloper().catch(() => false);
    setAllowed(ok);
    if (!ok) return;
    try {
      const [msgs, cr] = await Promise.all([listInbox(), listCrashes().catch(() => [] as Crash[])]);
      setRows(msgs);
      setCrashes(cr);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
    cleanupOldFiles(); // 🧹 files of messages solved 90+ days ago
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
    f === 'crashes'
      ? (crashes ?? []).filter((c) => c.status === 'open').length
      : (rows ?? []).filter((r) => (f === 'all' ? true : f === 'open' ? OPEN.includes(r.status) : r.status === f))
          .length;
  const shownCrashes = (crashes ?? []).filter((c) => showSolvedCrashes || c.status === 'open');

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
        {(['open', 'crashes', 'working', 'done', 'wont', 'all'] as Filter[]).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.chip, filter === f && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: filter === f }}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>
              {f === 'open'
                ? 'Open'
                : f === 'all'
                  ? 'All'
                  : f === 'crashes'
                    ? '💥 Crashes'
                    : `${STATUS[f].icon} ${STATUS[f].label}`}{' '}
              · {count(f)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {filter === 'crashes' ? (
        <>
          <Pressable
            onPress={() => setShowSolvedCrashes(!showSolvedCrashes)}
            style={styles.toggle}
            accessibilityRole="switch"
            accessibilityState={{ checked: showSolvedCrashes }}
          >
            <Text style={styles.small}>{showSolvedCrashes ? '☑' : '☐'} Show solved ones too</Text>
          </Pressable>
          {crashes === null ? (
            <ActivityIndicator color={colors.primary} />
          ) : shownCrashes.length === 0 ? (
            <Text style={styles.muted}>No crashes. 🎉</Text>
          ) : (
            shownCrashes.map((c) => (
              <CrashItem
                key={c.id}
                c={c}
                open={openId === c.id}
                onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                onSaved={load}
              />
            ))
          )}
        </>
      ) : rows === null ? (
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
        <AttachmentView files={f.attachments} />
        <Text style={styles.small}>
          {dayTime(f.createdAt)}
          {f.solvedAt ? ` · ✅ ${f.solvedBy ? `${f.solvedBy} · ` : ''}${dayTime(f.solvedAt)}` : ''}
        </Text>
        {!!info && <Text style={styles.small}>📱 {info}</Text>}
        {!open && !!f.reply && (
          <Text style={styles.small} numberOfLines={1}>
            💬 {f.reply}
          </Text>
        )}
      </Pressable>

      <View style={styles.quick}>
        <QuickButton
          label={f.status === 'done' ? '↩ Open again' : '✅ Solved'}
          done={f.status !== 'done'}
          onPress={async () => {
            await solveFeedback(f.id, f.status !== 'done');
            onSaved();
          }}
        />
      </View>

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

function QuickButton({ label, onPress, done }: { label: string; onPress: () => Promise<void>; done: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Pressable
        onPress={async () => {
          setBusy(true);
          setErr(null);
          try {
            await onPress();
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'Could not save.');
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        style={[styles.quickBtn, done ? styles.quickSolve : styles.quickOpen]}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.success} />
        ) : (
          <Text style={[styles.quickText, done && styles.quickTextSolve]}>{label}</Text>
        )}
      </Pressable>
      {err && <Text style={styles.error}>{err}</Text>}
    </>
  );
}

// ---------------------------------------------------------------------
// 💥 One kind of crash: how often, how many people, which versions
// ---------------------------------------------------------------------
function CrashItem({ c, open, onToggle, onSaved }: { c: Crash; open: boolean; onToggle: () => void; onSaved: () => void }) {
  const [copied, setCopied] = useState(false);
  const info = Object.entries(c.info)
    .filter(([key]) => key !== 'update_at')
    .map(([key, v]) => `${key}: ${v}`)
    .join(' · ');
  const copy = async () => {
    await Clipboard.setStringAsync(
      [`${c.name}: ${c.message}`, `Screen: ${c.screen ?? '?'}`, `Versions: ${c.versions.join(', ')}`, info, '', c.stack ?? '']
        .filter((x) => x !== undefined)
        .join('\n'),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <View style={[styles.item, c.status === 'open' && styles.itemCrash]}>
      <Pressable onPress={onToggle} accessibilityRole="button" style={styles.gap}>
        <View style={styles.itemHead}>
          <Text style={styles.itemKind} numberOfLines={open ? undefined : 1}>
            💥 {c.name ?? 'Error'}
            {c.fatal ? <Text style={styles.fatal}> · closed the app</Text> : null}
          </Text>
          <Text style={styles.statusText}>{c.status === 'solved' ? '✅ Solved' : `×${c.count}`}</Text>
        </View>
        <Text style={styles.message} numberOfLines={open ? undefined : 2} selectable={open}>
          {c.message}
        </Text>
        <Text style={styles.small}>
          👥 {c.people} {c.people === 1 ? 'person' : 'people'} · last {dayTime(c.lastAt)}
          {c.lastUser ? ` (${c.lastUser})` : ''} · first {dayTime(c.firstAt)}
        </Text>
        <Text style={styles.small}>
          📍 {c.screen || '?'} · 📦 {c.versions.slice(-3).join(', ') || '?'}
        </Text>
      </Pressable>
      {open && (
        <View style={styles.answer}>
          {!!info && <Text style={styles.small}>📱 {info}</Text>}
          {!!c.stack && (
            <ScrollView horizontal style={styles.stackBox}>
              <Text style={styles.stack} selectable>
                {c.stack}
              </Text>
            </ScrollView>
          )}
          <Pressable onPress={copy} style={styles.toggle} accessibilityRole="button">
            <Text style={styles.link}>{copied ? '✓ Copied' : '📋 Copy for fixing'}</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.quick}>
        <QuickButton
          label={c.status === 'solved' ? '↩ Open again' : '✅ Solved'}
          done={c.status !== 'solved'}
          onPress={async () => {
            await solveCrash(c.id, c.status !== 'solved');
            onSaved();
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  quick: { flexDirection: 'row', justifyContent: 'flex-end' },
  quickBtn: { minWidth: 96, alignItems: 'center', paddingVertical: 6, paddingHorizontal: spacing.md, borderRadius: radius.pill },
  quickSolve: { backgroundColor: colors.successSoft },
  quickOpen: { borderWidth: 1, borderColor: colors.border },
  quickText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  quickTextSolve: { color: colors.success },
  itemCrash: { borderColor: colors.danger, borderLeftWidth: 4 },
  fatal: { fontSize: fontSize.caption, color: colors.danger, fontWeight: fontWeight.regular },
  toggle: { alignSelf: 'flex-start', paddingVertical: 4 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  stackBox: { maxHeight: 220, borderRadius: radius.md, backgroundColor: colors.background, padding: spacing.sm },
  stack: { fontSize: 11, lineHeight: 15, color: colors.text, fontFamily: 'monospace' },
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
