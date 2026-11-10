import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { ask } from '@/features/aiChance/ask';
import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, md, Tap } from '@/features/home/md';
import {
  chatAct,
  chatEdit,
  chatGet,
  chatList,
  chatSend,
  type ChatAction,
  type ChatMessage,
  type ChatSummary,
} from '@/features/supervisor/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💬 Supervisor → Chat with the AI supervisor (super admins only)
//   Ask anything about the admission work in plain words. The AI picks
//   the data it needs (as you), answers with the numbers it used, links
//   the leads / people it names, and may suggest an action — a
//   follow-up, a hand over, a message — that happens only when you tap
//   "হ্যাঁ". Chats are kept 90 days.
// =====================================================================

const SUGGEST = [
  'এই সপ্তাহে টিম কেমন করছে? কার দিকে নজর দেওয়া দরকার?',
  'এই মাসের ভর্তির লক্ষ্য পূরণ হবে? কোন কোর্সে পিছিয়ে?',
  'গত ৩০ দিনে Not Now বেশি কেন? কোন কারণে বেশি?',
  'কার follow-up বেশি দেরি হচ্ছে? কী করা উচিত?',
  'ফি নিয়ে আপত্তির উত্তর কীভাবে দিলে ভালো হয়?',
  'আগামী সপ্তাহের জন্য টিমকে একটা message লিখে দিন।',
];

const timeText = (d: string) =>
  new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function say(text: string) {
  if (Platform.OS === 'web') window.alert(text);
  else Alert.alert('', text);
}

/** A message being sent (shown at once), or one that failed (with "try again") */
type Pending = { text: string; error: string | null };

export default function SupervisorChatScreen() {
  const { profile } = useAuth();
  const params = useLocalSearchParams<{ chat?: string; text?: string }>();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const superAdmin = profile?.role_key === 'super_admin';

  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [usage, setUsage] = useState<{ used: number; daily: number } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // the open chat: an id, 'new', or none (phones: the list)
  const [open, setOpen] = useState<string | null>(params.chat ?? (params.text ? 'new' : null));
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [text, setText] = useState(params.text ?? '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [renaming, setRenaming] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // the chat whose messages are wanted now (an older answer arriving late is not shown)
  const want = useRef<string | null>(open);
  want.current = open;
  // a chat made by the first message here: its messages are on the screen already
  const justMade = useRef<string | null>(null);

  // opened again with another chat or a new question (the screen may still be open, e.g. on the web)
  useEffect(() => {
    if (params.chat) setOpen(params.chat);
    else if (params.text) {
      setOpen('new');
      setText(params.text);
    }
  }, [params.chat, params.text]);

  const loadList = useCallback(() => {
    chatList()
      .then((r) => {
        setChats(r.chats);
        setUsage({ used: r.used, daily: r.daily });
        setListError(null);
      })
      .catch((e) => setListError(e instanceof Error ? e.message : 'লোড করা যায়নি।'));
  }, []);

  useEffect(() => {
    if (superAdmin) loadList();
  }, [superAdmin, loadList]);

  // the open chat's messages
  useEffect(() => {
    if (open && open === justMade.current) {
      justMade.current = null;
      return;
    }
    setMsgError(null);
    setPending(null);
    if (!open || open === 'new') {
      setMessages(open === 'new' ? [] : null);
      return;
    }
    setMessages(null);
    const id = open;
    chatGet(id)
      .then((m) => {
        if (want.current === id) setMessages(m);
      })
      .catch((e) => {
        if (want.current === id) setMsgError(e instanceof Error ? e.message : 'লোড করা যায়নি।');
      });
  }, [open]);

  const send = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (q.length < 2 || (pending && !pending.error)) return;
      const chatId = open && open !== 'new' ? open : null;
      setText('');
      setPending({ text: q, error: null });
      try {
        const r = await chatSend(chatId, q);
        setUsage({ used: r.used, daily: r.daily });
        const mine: ChatMessage = {
          id: r.user_message_id,
          role: 'user',
          body: q,
          data: {},
          created_at: new Date().toISOString(),
        };
        // a new chat: it gets its id now (its messages are these two)
        if (!chatId) {
          want.current = r.chat_id;
          justMade.current = r.chat_id;
          setOpen(r.chat_id);
        }
        setMessages((m) => [...(m ?? []).filter((x) => x.id !== mine.id), mine, r.message]);
        setPending(null);
        loadList();
      } catch (e) {
        setPending({ text: q, error: e instanceof Error ? e.message : 'উত্তর পাওয়া যায়নি।' });
      }
    },
    [open, pending, loadList],
  );

  const act = useCallback(async (m: ChatMessage, index: number, yes: boolean) => {
    const a = m.data.actions?.[index];
    if (!a) return;
    const go = async () => {
      try {
        const done = await chatAct(m.id, index, yes);
        setMessages((list) =>
          (list ?? []).map((x) =>
            x.id === m.id
              ? {
                  ...x,
                  data: { ...x.data, actions: (x.data.actions ?? []).map((y, i) => (i === index ? done : y)) },
                }
              : x,
          ),
        );
        if (yes && done.result) say(`✅ ${done.result}`);
      } catch (e) {
        say(e instanceof Error ? e.message : 'করা যায়নি।');
      }
    };
    // giving leads to someone: asked once more
    if (yes && a.type === 'hand_over') {
      ask('Lead দেওয়া', `${a.lead_ids?.length ?? 0}টা lead ${a.user_name}-কে দেবেন?`, [
        { label: 'হ্যাঁ, দিন', run: () => void go() },
        { label: 'না', run: () => undefined },
      ]);
      return;
    }
    await go();
  }, []);

  const current = chats?.find((c) => c.id === open) ?? null;

  const remove = () => {
    if (!current) return;
    ask('চ্যাট মুছবেন?', `"${current.title}" আর ফেরত আসবে না।`, [
      {
        label: 'মুছুন',
        run: () => {
          chatEdit(current.id, { remove: true })
            .then(() => {
              setOpen(wide ? 'new' : null);
              loadList();
            })
            .catch((e) => say(e instanceof Error ? e.message : 'মোছা যায়নি।'));
        },
      },
      { label: 'না', run: () => undefined },
    ]);
  };

  const pin = () => {
    if (!current) return;
    chatEdit(current.id, { pinned: !current.pinned })
      .then(loadList)
      .catch((e) => say(e instanceof Error ? e.message : 'করা যায়নি।'));
  };

  if (!superAdmin) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'সুপারভাইজার চ্যাট' }} />
        <Text style={styles.bigIcon}>🔒</Text>
        <Text style={ui.muted}>শুধু সুপার অ্যাডমিন এই চ্যাট ব্যবহার করতে পারেন।</Text>
      </View>
    );
  }

  // ---- the list of chats ----
  const list = (
    <View style={[styles.listPane, wide && styles.listPaneWide]}>
      <Tap
        onPress={() => {
          setOpen('new');
          setText('');
        }}
        label="নতুন চ্যাট"
        style={styles.newBtn}
      >
        <MIcon name="add" size={20} color={md.onPrimaryC} />
        <Text style={styles.newText}>নতুন চ্যাট</Text>
      </Tap>
      {usage && (
        <Text style={[ui.muted, styles.usage]}>
          আজ {usage.used}/{usage.daily} message
        </Text>
      )}
      {listError ? (
        <Tap onPress={loadList} label="আবার চেষ্টা" style={styles.pad}>
          <Text style={ui.error}>{listError} · আবার চেষ্টা করুন ›</Text>
        </Tap>
      ) : chats === null ? (
        <ActivityIndicator color={colors.primary} style={styles.pad} />
      ) : chats.length === 0 ? (
        <Text style={[ui.muted, styles.pad]}>এখনো কোনো চ্যাট নেই।</Text>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setOpen(item.id)}
              style={({ pressed }) => [styles.chatRow, open === item.id && styles.chatRowOn, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.chatTitle} numberOfLines={1}>
                {item.pinned ? '📌 ' : ''}
                {item.title}
              </Text>
              {!!item.last && (
                <Text style={ui.muted} numberOfLines={1}>
                  {item.last}
                </Text>
              )}
              <Text style={styles.chatTime}>{timeText(item.updated_at)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );

  // ---- one chat ----
  const shown = messages ?? [];
  const busy = !!pending && !pending.error;
  const conversation = (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={90}>
      <View style={styles.chatHead}>
        {!wide && (
          <Tap onPress={() => setOpen(null)} label="সব চ্যাট" style={styles.iconBtn}>
            <MIcon name="arrow-back" size={22} />
          </Tap>
        )}
        <Text style={[styles.chatHeadTitle, styles.flex]} numberOfLines={1}>
          {current?.title ?? 'নতুন চ্যাট'}
        </Text>
        {current && (
          <>
            <Tap onPress={pin} label={current.pinned ? 'Unpin' : 'Pin'} style={styles.iconBtn}>
              <MIcon name="push-pin" size={20} color={current.pinned ? colors.primary : colors.textMuted} />
            </Tap>
            <Tap onPress={() => setRenaming(true)} label="নাম বদলান" style={styles.iconBtn}>
              <MIcon name="edit" size={20} color={colors.textMuted} />
            </Tap>
            <Tap onPress={remove} label="মুছুন" style={styles.iconBtn}>
              <MIcon name="delete-outline" size={20} color={colors.textMuted} />
            </Tap>
          </>
        )}
      </View>

      {msgError ? (
        <View style={styles.center}>
          <Text style={ui.error}>{msgError}</Text>
        </View>
      ) : messages === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={shown}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.thread}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            pending ? undefined : (
              <View style={styles.hello}>
                <Text style={styles.bigIcon}>🧑‍💼🤖</Text>
                <Text style={styles.helloTitle}>AI সুপারভাইজারকে জিজ্ঞেস করুন</Text>
                <Text style={[ui.muted, styles.centerText]}>
                  অ্যাপের আসল তথ্য দেখে উত্তর দেবে, কোন তথ্য দেখেছে তা-ও বলবে। কোনো কাজের পরামর্শ দিলে আপনি "হ্যাঁ"
                  চাপলেই কেবল হবে।
                </Text>
                <View style={styles.suggest}>
                  {SUGGEST.map((s) => (
                    <Chip key={s} text={s} on={false} onPress={() => send(s)} />
                  ))}
                </View>
              </View>
            )
          }
          renderItem={({ item }) => <Bubble m={item} onAct={act} />}
          ListFooterComponent={
            pending ? (
              <View>
                <View style={[styles.bubble, styles.mine]}>
                  <Text style={styles.mineText}>{pending.text}</Text>
                </View>
                {pending.error ? (
                  <View style={[styles.bubble, styles.theirs]}>
                    <Text style={ui.error}>{pending.error}</Text>
                    <Tap onPress={() => send(pending.text)} label="আবার চেষ্টা" style={styles.retry}>
                      <Text style={styles.link}>↻ আবার চেষ্টা করুন</Text>
                    </Tap>
                  </View>
                ) : (
                  <View style={[styles.bubble, styles.theirs, styles.row]}>
                    <ActivityIndicator color={colors.primary} size="small" />
                    <Text style={ui.muted}>তথ্য দেখে উত্তর লিখছে…</Text>
                  </View>
                )}
              </View>
            ) : undefined
          }
        />
      )}

      <View style={styles.composer}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="যা জানতে চান লিখুন…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          multiline
          maxLength={1500}
          editable={!busy}
          accessibilityLabel="Message"
        />
        <Tap
          onPress={() => send(text)}
          label="পাঠান"
          style={[styles.sendBtn, (busy || text.trim().length < 2) && styles.sendOff]}
        >
          {busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <MIcon name="send" size={20} color="#FFFFFF" />}
        </Tap>
      </View>
      <Text style={[ui.muted, styles.note]}>AI ভুল করতে পারে। বড় সিদ্ধান্তের আগে সংখ্যাগুলো যাচাই করুন।</Text>
    </KeyboardAvoidingView>
  );

  return (
    <View style={[styles.screen, wide && styles.wideRow]}>
      <Stack.Screen options={{ title: 'সুপারভাইজার চ্যাট' }} />
      {wide ? (
        <>
          {list}
          <View style={styles.flex}>{conversation}</View>
        </>
      ) : open ? (
        conversation
      ) : (
        list
      )}
      {renaming && current && (
        <RenameSheet
          title={current.title}
          onClose={() => setRenaming(false)}
          onSave={(t) =>
            chatEdit(current.id, { title: t })
              .then(() => {
                setRenaming(false);
                loadList();
              })
              .catch((e) => say(e instanceof Error ? e.message : 'করা যায়নি।'))
          }
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
const ACTION_TITLE: Record<ChatAction['type'], string> = {
  follow_up: '⏰ Follow-up রাখা',
  hand_over: '🔁 Lead অন্যজনকে দেওয়া',
  message: '✉️ Message পাঠানো',
};

const Bubble = memo(function Bubble({
  m,
  onAct,
}: {
  m: ChatMessage;
  onAct: (m: ChatMessage, index: number, yes: boolean) => void;
}) {
  const [showSources, setShowSources] = useState(false);
  if (m.role === 'user') {
    return (
      <View style={[styles.bubble, styles.mine]}>
        <Text style={styles.mineText} selectable>
          {m.body}
        </Text>
      </View>
    );
  }
  const sources = m.data.sources ?? [];
  const links = m.data.links ?? [];
  const actions = m.data.actions ?? [];
  return (
    <View style={[styles.bubble, styles.theirs]}>
      <Text style={styles.theirText} selectable>
        {m.body}
      </Text>

      {links.length > 0 && (
        <View style={styles.links}>
          {links.map((l) => (
            <Chip
              key={l.id}
              text={`${l.type === 'lead' ? '👤' : '🧑‍💼'} ${l.label} ›`}
              on={false}
              onPress={() => router.push((l.type === 'lead' ? `/leads/${l.id}` : `/activity/${l.id}`) as Href)}
            />
          ))}
        </View>
      )}

      {actions.map((a, i) => (
        <View key={i} style={styles.action}>
          <Text style={styles.actionTitle}>{ACTION_TITLE[a.type]}</Text>
          {!!a.lead_names?.length && (
            <Text style={styles.actionLine} numberOfLines={3}>
              Lead: {a.lead_names.slice(0, 8).join(', ')}
              {a.lead_names.length > 8 ? ` +${a.lead_names.length - 8}` : ''}
            </Text>
          )}
          {a.type === 'follow_up' && a.due_at && <Text style={styles.actionLine}>কখন: {timeText(a.due_at)}</Text>}
          {!!a.user_name && (
            <Text style={styles.actionLine}>
              {a.type === 'hand_over' ? 'কাকে' : 'প্রাপক'}: {a.user_name}
            </Text>
          )}
          {!!a.note && <Text style={styles.actionLine}>নোট: {a.note}</Text>}
          {!!a.text && <Text style={styles.actionMsg}>“{a.text}”</Text>}
          {a.status === 'pending' ? (
            <View style={styles.actionBtns}>
              <Tap onPress={() => onAct(m, i, true)} label="হ্যাঁ, করুন" style={styles.yes}>
                <Text style={styles.yesText}>✅ হ্যাঁ, করুন</Text>
              </Tap>
              <Tap onPress={() => onAct(m, i, false)} label="না" style={styles.no}>
                <Text style={styles.noText}>না</Text>
              </Tap>
            </View>
          ) : (
            <Text style={styles.actionDone}>
              {a.status === 'done' ? `✅ ${a.result ?? 'করা হয়েছে'}` : '— বাদ দেওয়া হয়েছে'}
            </Text>
          )}
        </View>
      ))}

      {sources.length > 0 && (
        <Tap onPress={() => setShowSources((v) => !v)} label="কোন তথ্য দেখে" style={styles.sources}>
          <Text style={styles.sourcesText}>
            📎 কোন তথ্য দেখে বললাম {showSources ? '▴' : '▾'}
            {showSources ? `\n${sources.map((s) => `• ${s}`).join('\n')}` : ''}
          </Text>
        </Tap>
      )}
      <Text style={styles.time}>{timeText(m.created_at)}</Text>
    </View>
  );
});

function RenameSheet({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (t: string) => void }) {
  const [t, setT] = useState(title);
  return (
    <Sheet title="চ্যাটের নাম" onClose={onClose}>
      <TextInput
        value={t}
        onChangeText={setT}
        maxLength={60}
        style={styles.renameInput}
        placeholderTextColor={colors.textMuted}
        autoFocus
        accessibilityLabel="চ্যাটের নাম"
      />
      <Button title="রাখুন" onPress={() => onSave(t)} disabled={t.trim().length === 0} fullWidth />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.sm },
  centerText: { textAlign: 'center' },
  pad: { padding: spacing.md },
  pressed: { opacity: 0.7 },
  bigIcon: { fontSize: 40 },

  listPane: { flex: 1, padding: spacing.md, gap: spacing.sm },
  wideRow: { flexDirection: 'row', alignItems: 'stretch' },
  listPaneWide: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 300,
    width: 300,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: md.outline,
  },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: 12,
    borderRadius: radius.lg,
    backgroundColor: md.primaryC,
    overflow: 'hidden',
  },
  newText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: md.onPrimaryC },
  usage: { textAlign: 'center' },
  chatRow: { padding: spacing.md, borderRadius: radius.lg, gap: 2, marginBottom: 4, backgroundColor: md.surface1 },
  chatRowOn: { backgroundColor: md.purpleC },
  chatTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  chatTime: { fontSize: fontSize.caption, color: colors.textMuted },

  chatHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: md.outline,
  },
  chatHeadTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  iconBtn: { padding: 8, borderRadius: 20, overflow: 'hidden' },

  thread: { padding: spacing.md, gap: spacing.sm, flexGrow: 1, maxWidth: 820, width: '100%', alignSelf: 'center' },
  hello: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  helloTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  suggest: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'center' },

  bubble: { maxWidth: '88%', padding: spacing.md, borderRadius: 18, gap: spacing.xs, marginBottom: spacing.xs },
  mine: { alignSelf: 'flex-end', backgroundColor: md.primaryC, borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: md.surface1, borderBottomLeftRadius: 4 },
  mineText: { fontSize: fontSize.body, color: md.onPrimaryC, lineHeight: 22 },
  theirText: { fontSize: fontSize.body, color: colors.text, lineHeight: 23 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  action: {
    gap: 3,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.background,
  },
  actionTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  actionLine: { fontSize: fontSize.small, color: colors.text },
  actionMsg: { fontSize: fontSize.small, color: colors.text, fontStyle: 'italic' },
  actionBtns: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
  yes: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: md.okC, overflow: 'hidden' },
  yesText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: md.onOkC },
  no: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: md.surface1, overflow: 'hidden' },
  noText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  actionDone: { fontSize: fontSize.small, color: colors.textMuted },
  sources: { alignSelf: 'flex-start' },
  sourcesText: { fontSize: fontSize.caption, color: colors.textMuted, lineHeight: 18 },
  time: { fontSize: fontSize.caption, color: colors.textMuted, alignSelf: 'flex-end' },
  retry: { alignSelf: 'flex-start' },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    maxWidth: 820,
    width: '100%',
    alignSelf: 'center',
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
    backgroundColor: md.surface1,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  sendOff: { opacity: 0.5 },
  note: { textAlign: 'center', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, paddingTop: 4 },
  renameInput: {
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
    marginBottom: spacing.sm,
  },
});
