import * as Clipboard from 'expo-clipboard';
import { Stack, router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  KINDS,
  cleanupOldFiles,
  dayTime,
  isDeveloper,
  listCrashes,
  solveCrash,
  type Crash,
} from '@/features/feedback/api';
import { Avatar, ChatView, StatusPill } from '@/features/feedback/ChatView';
import { chatInbox, openTopics, shortWhen, type ChatRow, type OpenTopic } from '@/features/feedback/chat';
import { PersonInfo } from '@/features/feedback/PersonInfo';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📥 More → Feedback inbox (the developer only), like Messenger:
//   💬 Chats: one row per person (newest first, unread ●, open topics)
//   🗂 Topics: every open problem / idea / question, by status
//   💥 Crashes: errors the app sent by itself
//   🌐 A wide screen shows the chat next to the list.
// =====================================================================

type Tab = 'chats' | 'topics' | 'crashes';

export default function FeedbackInboxScreen() {
  const { profile } = useAuth();
  const params = useLocalSearchParams<{ tab?: string }>();
  const { width } = useWindowDimensions();
  const wide = width >= 960;
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>(params.tab === 'crashes' ? 'crashes' : 'chats');
  const [chats, setChats] = useState<ChatRow[] | null>(null);
  const [topics, setTopics] = useState<OpenTopic[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [crashes, setCrashes] = useState<Crash[] | null>(null);
  const [showSolvedCrashes, setShowSolvedCrashes] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ChatRow | null>(null);
  const [info, setInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const ok = await isDeveloper().catch(() => false);
    setAllowed(ok);
    if (!ok) return;
    try {
      const [c, t, cr] = await Promise.all([chatInbox(), openTopics(), listCrashes().catch(() => [] as Crash[])]);
      setChats(c);
      setTopics(t);
      setCrashes(cr);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
    cleanupOldFiles(); // 🧹 files of topics solved 90+ days ago
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      const t = setInterval(load, 20000);
      return () => clearInterval(t);
    }, [load]),
  );

  const openChat = (c: { chatUser: string; name: string | null; avatarUrl?: string | null }) => {
    if (wide) {
      const row = chats?.find((x) => x.chatUser === c.chatUser);
      setPicked(
        row ?? {
          chatUser: c.chatUser,
          name: c.name,
          role: null,
          avatarUrl: c.avatarUrl ?? null,
          lastBody: null,
          lastKind: 'text',
          lastFiles: 0,
          lastSender: '',
          lastAt: new Date(),
          unread: 0,
          open: { bug: 0, idea: 0, question: 0 },
        },
      );
      setChats((now) => (now ?? []).map((x) => (x.chatUser === c.chatUser ? { ...x, unread: 0 } : x)));
    } else router.push(`/feedback/chat?u=${c.chatUser}` as Href);
  };

  const shownChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (chats ?? []).filter(
      (c) => !q || (c.name ?? '').toLowerCase().includes(q) || (c.lastBody ?? '').toLowerCase().includes(q),
    );
  }, [chats, search]);
  const shownTopics = (topics ?? []).filter((t) => showClosed || !['done', 'wont'].includes(t.status));
  const shownCrashes = (crashes ?? []).filter((c) => showSolvedCrashes || c.status === 'open');
  const unread = (chats ?? []).reduce((n, c) => n + c.unread, 0);
  const openCount = (topics ?? []).filter((t) => !['done', 'wont'].includes(t.status)).length;
  const crashCount = (crashes ?? []).filter((c) => c.status === 'open').length;

  if (allowed === false)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Feedback inbox' }} />
        <Text style={styles.muted}>Only the developer can see this.</Text>
      </View>
    );

  const list = (
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
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.tabs}>
        {(
          [
            ['chats', `💬 Chats${unread ? ` · ${unread}` : ''}`],
            ['topics', `🗂 Topics · ${openCount}`],
            ['crashes', `💥 Crashes · ${crashCount}`],
          ] as const
        ).map(([k, label]) => (
          <Pressable
            key={k}
            onPress={() => setTab(k)}
            style={[styles.tab, tab === k && styles.tabOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === k }}
          >
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'chats' && (
        <>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="🔍 Search people or messages"
            placeholderTextColor={colors.textMuted}
            style={styles.search}
          />
          {chats === null ? (
            <ActivityIndicator color={colors.primary} />
          ) : shownChats.length === 0 ? (
            <Text style={styles.muted}>No chats yet.</Text>
          ) : (
            shownChats.map((c) => (
              <Pressable
                key={c.chatUser}
                onPress={() => openChat(c)}
                style={({ pressed }) => [
                  styles.chatRow,
                  picked?.chatUser === c.chatUser && wide && styles.chatRowOn,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
              >
                <Avatar name={c.name ?? '?'} url={c.avatarUrl} size={46} />
                <View style={styles.flex}>
                  <View style={styles.chatTop}>
                    <Text style={[styles.chatName, c.unread > 0 && styles.bold]} numberOfLines={1}>
                      {c.name ?? 'Someone'}
                      {c.role ? <Text style={styles.small}> · {c.role}</Text> : null}
                    </Text>
                    <Text style={[styles.when, c.unread > 0 && styles.whenOn]}>{shortWhen(c.lastAt)}</Text>
                  </View>
                  <View style={styles.chatTop}>
                    <Text style={[styles.last, c.unread > 0 && styles.lastOn]} numberOfLines={1}>
                      {c.lastSender === profile?.id ? 'You: ' : ''}
                      {c.lastKind === 'status'
                        ? '🗂 Topic status changed'
                        : (c.lastBody ?? (c.lastFiles ? '📎 File' : ''))}
                    </Text>
                    {c.unread > 0 && (
                      <View style={styles.dot}>
                        <Text style={styles.dotText}>{c.unread}</Text>
                      </View>
                    )}
                  </View>
                  {c.open.bug + c.open.idea + c.open.question > 0 && (
                    <Text style={styles.openLine}>
                      {[
                        c.open.bug ? `🐞${c.open.bug}` : null,
                        c.open.idea ? `💡${c.open.idea}` : null,
                        c.open.question ? `❓${c.open.question}` : null,
                      ]
                        .filter(Boolean)
                        .join('  ')}{' '}
                      open
                    </Text>
                  )}
                </View>
              </Pressable>
            ))
          )}
        </>
      )}

      {tab === 'topics' && (
        <>
          <Pressable
            onPress={() => setShowClosed(!showClosed)}
            style={styles.toggle}
            accessibilityRole="switch"
            accessibilityState={{ checked: showClosed }}
          >
            <Text style={styles.small}>{showClosed ? '☑' : '☐'} Show solved / won’t do too</Text>
          </Pressable>
          {topics === null ? (
            <ActivityIndicator color={colors.primary} />
          ) : shownTopics.length === 0 ? (
            <Text style={styles.muted}>Nothing open. 🎉</Text>
          ) : (
            shownTopics.map((t) => {
              const k = KINDS.find((x) => x.kind === t.kind);
              return (
                <Pressable
                  key={t.id}
                  onPress={() => openChat({ chatUser: t.chatUser, name: t.name })}
                  style={({ pressed }) => [styles.topicRow, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <View style={styles.chatTop}>
                    <Text style={styles.topicKind}>
                      {k?.icon} {k?.label} · {t.name ?? 'Someone'}
                    </Text>
                    <StatusPill s={t.status} />
                  </View>
                  <Text style={styles.topicText} numberOfLines={2}>
                    {t.message}
                  </Text>
                  <Text style={styles.small}>
                    {dayTime(t.createdAt)} · {t.replies} repl{t.replies === 1 ? 'y' : 'ies'} · updated{' '}
                    {shortWhen(t.updatedAt)}
                  </Text>
                </Pressable>
              );
            })
          )}
        </>
      )}

      {tab === 'crashes' && (
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
      )}
    </ScrollView>
  );

  if (!wide) {
    return (
      <>
        <Stack.Screen options={{ title: 'Feedback inbox' }} />
        {list}
      </>
    );
  }

  // 🌐 Wide: the list on the left, the chat on the right
  return (
    <View style={styles.split}>
      <Stack.Screen options={{ title: 'Feedback inbox' }} />
      <View style={styles.left}>{list}</View>
      <View style={styles.flex}>
        {picked && profile?.id ? (
          <ChatView
            key={picked.chatUser}
            chatUser={picked.chatUser}
            me={profile.id}
            isDev
            otherName={picked.name ?? 'Someone'}
            otherAvatar={picked.avatarUrl}
            headerRight={
              <View style={styles.headBtns}>
                <Pressable onPress={() => setInfo(true)} hitSlop={8} accessibilityRole="button">
                  <Text style={styles.headBtn}>ℹ️ Phone & app</Text>
                </Pressable>
                <Pressable
                  onPress={() => router.push(`/users/${picked.chatUser}` as Href)}
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text style={styles.headBtn}>👤 Open</Text>
                </Pressable>
              </View>
            }
          />
        ) : (
          <View style={styles.center}>
            <Text style={styles.bigIcon}>💬</Text>
            <Text style={styles.muted}>Choose a chat on the left.</Text>
          </View>
        )}
        {info && picked && (
          <PersonInfo chatUser={picked.chatUser} name={picked.name ?? ''} onClose={() => setInfo(false)} />
        )}
      </View>
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
function CrashItem({
  c,
  open,
  onToggle,
  onSaved,
}: {
  c: Crash;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const info = Object.entries(c.info)
    .filter(([key]) => key !== 'update_at')
    .map(([key, v]) => `${key}: ${v}`)
    .join(' · ');
  const copy = async () => {
    await Clipboard.setStringAsync(
      [
        `${c.name}: ${c.message}`,
        `Screen: ${c.screen ?? '?'}`,
        `Versions: ${c.versions.join(', ')}`,
        info,
        '',
        c.stack ?? '',
      ]
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
  split: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  left: { width: 400, borderRightWidth: 1, borderRightColor: colors.border },
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  bold: { fontWeight: fontWeight.bold },
  bigIcon: { fontSize: 48 },
  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.pill },
  tabOn: { backgroundColor: colors.primary },
  tabText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  tabTextOn: { color: colors.textOnPrimary },
  search: {
    height: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: fontSize.body,
  },
  chatRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: radius.md,
  },
  chatRowOn: { backgroundColor: colors.primarySoft },
  chatTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chatName: { flex: 1, fontSize: fontSize.body, color: colors.text, fontWeight: fontWeight.semibold },
  when: { fontSize: fontSize.caption, color: colors.textMuted },
  whenOn: { color: colors.primary, fontWeight: fontWeight.bold },
  last: { flex: 1, fontSize: fontSize.small, color: colors.textMuted },
  lastOn: { color: colors.text, fontWeight: fontWeight.semibold },
  dot: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  dotText: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  openLine: { fontSize: fontSize.caption, color: colors.warning, fontWeight: fontWeight.semibold, marginTop: 2 },
  topicRow: {
    gap: 4,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  topicKind: { flex: 1, fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  topicText: { fontSize: fontSize.body, color: colors.text },
  headBtns: { flexDirection: 'row', gap: spacing.md },
  headBtn: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  quick: { flexDirection: 'row', justifyContent: 'flex-end' },
  quickBtn: {
    minWidth: 96,
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
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
