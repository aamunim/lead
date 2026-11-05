import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  KINDS,
  MAX_IMAGES,
  MAX_VOICE_SEC,
  uploadFeedbackFile,
  type FeedbackKind,
  type FeedbackStatus,
} from '@/features/feedback/api';
import { AttachmentView, readyAttachments, stillUploading, type Picked } from '@/features/feedback/Attachments';
import {
  DELETE_MS,
  REACTIONS,
  STATUS_LINE,
  dayLabel,
  deleteChat,
  getMessage,
  getReads,
  listChat,
  listTopics,
  markChatRead,
  reactChat,
  sendChat,
  setTopicStatus,
  timeOf,
  watchChat,
  type ChatLive,
  type ChatMessage,
  type ChatTopic,
} from '@/features/feedback/chat';
import { hasAudio, hasCamera } from '@/features/voice/native';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 💬 One chat with the developer, topics inside (Messenger-like)
//   • my messages right (blue), theirs left; day lines; ✓ sent ✓✓ seen
//   • 🐞 💡 ❓ topic cards with their own status; the shelf on top shows
//     the topics: tap one to see only its messages
//   • swipe right (or press and hold → Reply) to answer one message
//   • press and hold: 👍❤️😂😮😢🙏, copy, delete (own, 5 minutes),
//     a topic's status
//   • ＋ new topic / camera · 🖼 pictures · 🎙 voice · ➤ send
// =====================================================================

const OPEN: FeedbackStatus[] = ['new', 'seen', 'working'];
const kindOf = (k: FeedbackKind) => KINDS.find((x) => x.kind === k) ?? KINDS[0];
const ME_BUBBLE = colors.primary;
const THEM_BUBBLE = isDark ? '#2A2F3A' : '#EEF0F4';

type ImagePickerModule = typeof import('expo-image-picker');
const picker = (): ImagePickerModule | null =>
  Platform.OS === 'web' || hasCamera
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('expo-image-picker') as ImagePickerModule)
    : null;

type Row = { key: string; day: string } | { key: string; m: ChatMessage };

export function ChatView({
  chatUser,
  me,
  isDev,
  otherName,
  otherAvatar,
  firstFiles,
  startTopic,
  headerRight,
}: {
  /** whose chat (the person's id) */
  chatUser: string;
  me: string;
  isDev: boolean;
  /** "Developer" for the person; the person's name for the developer */
  otherName: string;
  otherAvatar?: string | null;
  /** 📸 a screenshot to start with (three-finger screenshot) */
  firstFiles?: { uri: string; mime: string }[];
  /** open with a new topic of this kind */
  startTopic?: FeedbackKind | null;
  headerRight?: React.ReactNode;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingOld, setLoadingOld] = useState(false);
  const [topics, setTopics] = useState<ChatTopic[]>([]);
  const [reads, setReads] = useState<Record<string, Date>>({});
  const [typingAt, setTypingAt] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the composer
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [newKind, setNewKind] = useState<FeedbackKind | null>(startTopic ?? null);
  const [sending, setSending] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [extra, setExtra] = useState<Record<string, ChatMessage>>({});
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const live = useRef<ChatLive | null>(null);
  const firstLoad = useRef(true);

  const devSide = (m: ChatMessage) => (isDev ? m.sender === me : m.sender !== m.chatUser);
  const mine = (m: ChatMessage) => m.sender === me;

  // ── loading, live updates, read marks ──
  const merge = useCallback((list: ChatMessage[]) => {
    setMessages((now) => {
      const map = new Map((now ?? []).map((m) => [m.id, m]));
      list.forEach((m) => map.set(m.id, m));
      return [...map.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [page, t, r] = await Promise.all([listChat(chatUser), listTopics(chatUser), getReads(chatUser)]);
      merge(page.items);
      setMessages((now) => now ?? []);
      if (firstLoad.current) {
        firstLoad.current = false;
        setMore(page.more);
      }
      setTopics(t);
      setReads(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setMessages((now) => now ?? []);
    }
  }, [chatUser, merge]);

  const readNow = useCallback(() => {
    if (AppState.currentState !== 'active') return;
    markChatRead(isDev ? chatUser : null).catch(() => undefined);
  }, [chatUser, isDev]);

  useEffect(() => {
    setMessages(null);
    setFilter(null);
    firstLoad.current = true;
    refresh().then(readNow);
    live.current = watchChat(chatUser, me, {
      message: (m) => {
        merge([m]);
        if (m.sender !== me) {
          setTypingAt(0);
          readNow();
        }
      },
      read: (reader, at) => setReads((now) => ({ ...now, [reader]: at })),
      topic: () =>
        listTopics(chatUser)
          .then(setTopics)
          .catch(() => undefined),
      typing: () => setTypingAt(Date.now()),
    });
    // a quiet check, in case the live link is down
    const timer = setInterval(() => refresh(), 15000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh().then(readNow));
    return () => {
      live.current?.close();
      clearInterval(timer);
      sub.remove();
    };
  }, [chatUser, me, merge, readNow, refresh]);

  // "typing…" fades after 4 seconds
  const [, tick] = useState(0);
  useEffect(() => {
    if (!typingAt) return;
    const t = setTimeout(() => tick((n) => n + 1), 4200);
    return () => clearTimeout(t);
  }, [typingAt]);
  const typing = typingAt > 0 && Date.now() - typingAt < 4000;

  // 📸 a screenshot to start with
  useEffect(() => {
    (firstFiles ?? []).forEach((f) => addFile('image', f.uri, f.mime));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadOlder = async () => {
    const oldest = messages?.[0];
    if (!oldest || loadingOld || !more) return;
    setLoadingOld(true);
    try {
      const page = await listChat(chatUser, oldest.createdAt);
      merge(page.items);
      setMore(page.more);
    } catch {
      // try again on the next scroll
    } finally {
      setLoadingOld(false);
    }
  };

  // ── what the list shows ──
  const byId = useMemo(() => {
    const m = new Map((messages ?? []).map((x) => [x.id, x]));
    Object.values(extra).forEach((x) => m.set(x.id, x));
    return m;
  }, [messages, extra]);
  const topicById = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);

  // a reply to an older message (not loaded): fetch it once
  useEffect(() => {
    (messages ?? []).forEach((m) => {
      if (m.replyTo && !byId.has(m.replyTo)) {
        getMessage(m.replyTo).then((x) => x && setExtra((now) => ({ ...now, [x.id]: x })));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const shown = useMemo(() => (messages ?? []).filter((m) => !filter || m.topicId === filter), [messages, filter]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    let day = '';
    shown.forEach((m) => {
      const d = dayLabel(m.createdAt);
      if (d !== day) {
        out.push({ key: `d-${d}-${m.id}`, day: d });
        day = d;
      }
      out.push({ key: m.id, m });
    });
    return out.reverse(); // the list is upside down: newest at the bottom
  }, [shown]);

  // ✓✓ the other side read up to here
  const otherRead = isDev ? reads[chatUser] : Object.entries(reads).find(([k]) => k !== me)?.[1];
  const lastMineId = useMemo(() => [...shown].reverse().find((m) => mine(m) && m.kind !== 'status')?.id, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const replyCount = useCallback(
    (topicId: string) =>
      (messages ?? []).filter((m) => m.topicId === topicId && m.kind === 'text' && !m.deleted).length,
    [messages],
  );

  // ── the composer ──
  const patchFile = (key: string, p: Partial<Picked>) =>
    setFiles((now) => now.map((x) => (x.key === key ? { ...x, ...p } : x)));
  function addFile(kind: 'image', uri: string, mime: string) {
    const key = `f${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFiles((now) => [...now, { key, kind, uri }]);
    uploadFeedbackFile(uri, mime)
      .then((path) => patchFile(key, { path }))
      .catch((e) => {
        patchFile(key, { failed: true });
        Alert.alert('Could not add the picture', e instanceof Error ? e.message : '');
      });
  }
  const imageRoom = MAX_IMAGES - files.filter((f) => f.kind === 'image').length;
  const ip = picker();
  const fromGallery = async () => {
    if (!ip || imageRoom <= 0) return;
    const res = await ip.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.5,
      allowsMultipleSelection: imageRoom > 1,
      selectionLimit: imageRoom,
    });
    if (!res.canceled)
      res.assets.slice(0, imageRoom).forEach((a) => addFile('image', a.uri, a.mimeType ?? 'image/jpeg'));
  };
  const fromCamera = async () => {
    if (!ip || imageRoom <= 0) return;
    const perm = await ip.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert('Camera', 'Allow the camera in the phone’s Settings to take a photo.');
    const res = await ip.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5 });
    if (!res.canceled && res.assets[0]) addFile('image', res.assets[0].uri, res.assets[0].mimeType ?? 'image/jpeg');
  };

  const canSend = (!!text.trim() || readyAttachments(files).length > 0) && !stillUploading(files);
  const send = async (voice?: { path: string; sec: number }) => {
    if (sending) return;
    const attachments = [
      ...readyAttachments(files.filter((f) => f.kind === 'image')),
      ...(voice ? [{ path: voice.path, kind: 'voice' as const, sec: voice.sec }] : []),
    ];
    if (!text.trim() && attachments.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await sendChat({
        chatUser: isDev ? chatUser : null,
        body: text,
        attachments,
        replyTo: replyTo?.id ?? null,
        topicId: newKind ? null : filter,
        topicKind: newKind,
      });
      setText('');
      setFiles([]);
      setReplyTo(null);
      setNewKind(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const Recorder = recording
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/features/voice/VoiceRecorderSheet') as typeof import('@/features/voice/VoiceRecorderSheet'))
        .VoiceRecorderSheet
    : null;

  // ── the topics shelf ──
  const openTopics = topics.filter((t) => OPEN.includes(t.status));
  const closedTopics = topics.filter((t) => !OPEN.includes(t.status));
  const shelf = [...openTopics, ...(showClosed ? closedTopics : [])];
  const filterTopic = filter ? topicById.get(filter) : null;

  const startReply = (m: ChatMessage) => {
    if (m.deleted || m.kind === 'status') return;
    setReplyTo(m);
    setNewKind(null);
    inputRef.current?.focus();
  };

  // ───────────────────────────── view ─────────────────────────────
  return (
    <View style={styles.wrap}>
      {/* Who, and what they are doing */}
      <View style={styles.head}>
        <Avatar name={otherName} url={otherAvatar} dev={!isDev} />
        <View style={styles.flex}>
          <Text style={styles.headName} numberOfLines={1}>
            {otherName}
          </Text>
          <Text style={[styles.headSub, typing && styles.typingText]} numberOfLines={1}>
            {typing
              ? `${isDev ? otherName.split(' ')[0] : 'Developer'} is typing…`
              : otherRead
                ? `Seen ${dayLabel(otherRead) === 'Today' ? timeOf(otherRead) : dayLabel(otherRead)}`
                : isDev
                  ? ''
                  : 'Problems, ideas and questions about the app'}
          </Text>
        </View>
        {headerRight}
      </View>

      {/* 🗂 Topics: tap one to see only its messages */}
      {topics.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.shelfScroll}
          contentContainerStyle={styles.shelf}
        >
          <Chip label="All" on={!filter} onPress={() => setFilter(null)} />
          {shelf.map((t) => (
            <Chip
              key={t.id}
              label={`${kindOf(t.kind).icon} ${short(t.message, 22)} ${STATUS_LINE[t.status].split(' ')[0]}`}
              on={filter === t.id}
              onPress={() => setFilter(filter === t.id ? null : t.id)}
            />
          ))}
          {closedTopics.length > 0 && (
            <Chip
              label={showClosed ? 'Hide closed' : `✅ ${closedTopics.length} closed`}
              on={false}
              onPress={() => setShowClosed(!showClosed)}
            />
          )}
        </ScrollView>
      )}
      {filterTopic && (
        <View style={styles.filterBar}>
          <Text style={styles.filterText} numberOfLines={1}>
            {kindOf(filterTopic.kind).icon} Only “{short(filterTopic.message, 40)}” · {STATUS_LINE[filterTopic.status]}
          </Text>
          <Pressable onPress={() => setFilter(null)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.filterClose}>Show all</Text>
          </Pressable>
        </View>
      )}

      {/* Messages (upside down: the newest is at the bottom) */}
      {messages === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingOld ? <ActivityIndicator color={colors.primary} /> : undefined}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>💬</Text>
              <Text style={styles.emptyTitle}>{isDev ? 'No messages yet' : 'Write to the developer'}</Text>
              {!isDev && (
                <Text style={styles.emptyText}>
                  Tap ＋ for a 🐞 problem, 💡 idea or ❓ question. The app version and phone go with it.
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => {
            if ('day' in item) {
              return (
                <View style={styles.dayWrap}>
                  <Text style={styles.day}>{item.day}</Text>
                </View>
              );
            }
            const m = item.m;
            if (m.kind === 'status') {
              const t = m.topicId ? topicById.get(m.topicId) : null;
              return (
                <View style={styles.statusWrap}>
                  <Text style={styles.statusLine}>
                    {STATUS_LINE[(m.body as FeedbackStatus) ?? 'seen'] ?? m.body} ·{' '}
                    {devSide(m) ? 'Developer' : mine(m) ? 'You' : otherName.split(' ')[0]}
                    {t ? ` · ${kindOf(t.kind).icon} ${short(t.message, 28)}` : ''} · {timeOf(m.createdAt)}
                  </Text>
                </View>
              );
            }
            return (
              <Bubble
                m={m}
                mineSide={mine(m)}
                senderName={devSide(m) ? 'Developer' : otherName}
                me={me}
                topic={m.topicId ? (topicById.get(m.topicId) ?? null) : null}
                replied={m.replyTo ? (byId.get(m.replyTo) ?? null) : null}
                repliedName={(x) => (x.sender === me ? 'You' : devSide(x) ? 'Developer' : otherName.split(' ')[0])}
                replies={m.kind === 'topic' && m.topicId ? replyCount(m.topicId) : 0}
                seen={!!otherRead && mine(m) && otherRead >= m.createdAt}
                showTick={mine(m) && m.id === lastMineId}
                onReply={() => startReply(m)}
                onMenu={() => setMenuFor(m)}
                onReact={(e) =>
                  reactChat(m.id, e)
                    .then(refresh)
                    .catch(() => undefined)
                }
                onOpenTopic={() => m.topicId && setFilter(m.topicId)}
              />
            );
          }}
        />
      )}

      {/* typing… */}
      {typing && (
        <View style={styles.typingRow}>
          <View style={[styles.bubble, styles.them, styles.typingBubble]}>
            <Text style={styles.dots}>• • •</Text>
          </View>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {/* ── The composer ── */}
      <View style={styles.composer}>
        {newKind && (
          <Banner
            text={`${kindOf(newKind).icon} New ${kindOf(newKind).label.toLowerCase()}: ${kindOf(newKind).hint}`}
            onClose={() => setNewKind(null)}
          />
        )}
        {replyTo && (
          <Banner
            text={`↪ Replying to ${replyTo.sender === me ? 'yourself' : devSide(replyTo) ? 'Developer' : otherName.split(' ')[0]}: ${short(
              replyTo.body ?? (replyTo.attachments.length ? '📎 file' : ''),
              60,
            )}`}
            onClose={() => setReplyTo(null)}
          />
        )}
        {!newKind && !replyTo && filterTopic && (
          <Text style={styles.inTopic}>
            Writing in {kindOf(filterTopic.kind).icon} {short(filterTopic.message, 40)}
          </Text>
        )}
        {files.length > 0 && (
          <ScrollView horizontal contentContainerStyle={styles.thumbs} showsHorizontalScrollIndicator={false}>
            {files.map((f) => (
              <View key={f.key} style={styles.thumb}>
                {f.uri ? <Image source={{ uri: f.uri }} style={styles.thumbImg} /> : null}
                {!f.path && !f.failed && (
                  <View style={styles.thumbBusy}>
                    <ActivityIndicator color="#FFFFFF" />
                  </View>
                )}
                {f.failed && (
                  <View style={styles.thumbBusy}>
                    <Text style={styles.failText}>Not sent</Text>
                  </View>
                )}
                <Pressable
                  onPress={() => setFiles((now) => now.filter((x) => x.key !== f.key))}
                  style={styles.thumbX}
                  hitSlop={8}
                  accessibilityLabel="Remove picture"
                >
                  <Text style={styles.thumbXText}>✕</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <View style={styles.inputRow}>
          <RoundBtn label="＋" a11y="New topic or camera" onPress={() => setPlusOpen(true)} />
          {ip && <RoundBtn label="🖼" a11y="Add pictures" onPress={fromGallery} off={imageRoom <= 0} />}
          <TextInput
            ref={inputRef as never}
            value={text}
            onChangeText={(t) => {
              setText(t);
              live.current?.typing();
            }}
            placeholder={newKind ? kindOf(newKind).hint : 'Message…'}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            multiline
            maxLength={4000}
            onKeyPress={(e) => {
              // 🌐 Enter sends, Shift+Enter is a new line
              const ne = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey) {
                (e as unknown as { preventDefault: () => void }).preventDefault?.();
                if (canSend) send();
              }
            }}
            accessibilityLabel="Message"
          />
          {canSend || !hasAudio ? (
            <RoundBtn
              label={sending ? '…' : '➤'}
              a11y="Send"
              onPress={() => send()}
              primary
              off={!canSend || sending}
            />
          ) : (
            <RoundBtn label="🎙" a11y="Record a voice message" onPress={() => setRecording(true)} primary />
          )}
        </View>
      </View>

      {/* ＋ new topic / camera */}
      <Sheet visible={plusOpen} onClose={() => setPlusOpen(false)} title="Start a topic">
        {KINDS.map((k) => (
          <MenuRow
            key={k.kind}
            label={`${k.icon} New ${k.label.toLowerCase()}`}
            hint={k.hint}
            onPress={() => {
              setPlusOpen(false);
              setNewKind(k.kind);
              setReplyTo(null);
              inputRef.current?.focus();
            }}
          />
        ))}
        {ip && Platform.OS !== 'web' && (
          <MenuRow
            label="📷 Take a photo"
            onPress={() => {
              setPlusOpen(false);
              fromCamera();
            }}
          />
        )}
      </Sheet>

      {/* Press and hold on a message */}
      <MessageMenu
        m={menuFor}
        me={me}
        isDev={isDev}
        topic={menuFor?.topicId ? (topicById.get(menuFor.topicId) ?? null) : null}
        onClose={() => setMenuFor(null)}
        onReply={() => {
          if (menuFor) startReply(menuFor);
          setMenuFor(null);
        }}
        onDone={() => {
          setMenuFor(null);
          refresh();
        }}
        onShowTopic={() => {
          if (menuFor?.topicId) setFilter(menuFor.topicId);
          setMenuFor(null);
        }}
      />

      {Recorder && (
        <Recorder
          title="🎙 Voice message"
          maxSec={MAX_VOICE_SEC}
          upload={(uri) => uploadFeedbackFile(uri, 'audio/mp4')}
          onClose={() => setRecording(false)}
          onSaved={(sec, path) => {
            setRecording(false);
            send({ path, sec });
          }}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------
function Bubble({
  m,
  mineSide,
  senderName,
  me,
  topic,
  replied,
  repliedName,
  replies,
  seen,
  showTick,
  onReply,
  onMenu,
  onReact,
  onOpenTopic,
}: {
  m: ChatMessage;
  mineSide: boolean;
  senderName: string;
  me: string;
  topic: ChatTopic | null;
  replied: ChatMessage | null;
  repliedName: (m: ChatMessage) => string;
  replies: number;
  seen: boolean;
  showTick: boolean;
  onReply: () => void;
  onMenu: () => void;
  onReact: (emoji: string | null) => void;
  onOpenTopic: () => void;
}) {
  // ↪ swipe right to reply
  const dx = useRef(new Animated.Value(0)).current;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dy) < 10,
      onPanResponderMove: (_, g) => dx.setValue(Math.max(0, Math.min(g.dx, 80))),
      onPanResponderRelease: (_, g) => {
        if (g.dx > 56) onReply();
        Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;

  const reactions = Object.entries(m.reactions);
  const counts = reactions.reduce<Record<string, number>>((acc, [, e]) => ({ ...acc, [e]: (acc[e] ?? 0) + 1 }), {});
  const myReaction = m.reactions[me];
  const isTopic = m.kind === 'topic' && !m.deleted;
  const k = topic ? kindOf(topic.kind) : null;

  return (
    <Animated.View
      style={[styles.row, mineSide ? styles.rowMine : styles.rowThem, { transform: [{ translateX: dx }] }]}
      {...pan.panHandlers}
    >
      <Pressable
        onLongPress={onMenu}
        delayLongPress={300}
        // 🌐 a click opens the menu on the website (no long press with a mouse)
        onPress={Platform.OS === 'web' ? onMenu : undefined}
        style={[
          isTopic ? styles.topicCard : styles.bubble,
          !isTopic && (mineSide ? styles.mine : styles.them),
          isTopic && (mineSide ? styles.topicMine : styles.topicThem),
          m.deleted && styles.deletedBubble,
        ]}
        accessibilityHint="Press and hold for reactions, reply and more"
      >
        {!mineSide && !isTopic && <Text style={styles.sender}>{senderName}</Text>}

        {/* 🐞 The topic card's head */}
        {isTopic && k && topic && (
          <View style={styles.topicHead}>
            <Text style={styles.topicKind}>
              {k.icon} {k.label.toUpperCase()}
              {!mineSide ? ` · ${senderName}` : ''}
            </Text>
            <StatusPill s={topic.status} />
          </View>
        )}

        {/* ↪ what this answers */}
        {!m.deleted && replied && (
          <View style={[styles.quote, mineSide && styles.quoteMine]}>
            <Text style={[styles.quoteName, mineSide && styles.textOnMine]}>↪ {repliedName(replied)}</Text>
            <Text style={[styles.quoteText, mineSide && styles.textOnMineSoft]} numberOfLines={2}>
              {replied.deleted
                ? 'Message deleted'
                : replied.kind === 'topic' && topic
                  ? `${kindOf(topic.kind).icon} ${topic.message}`
                  : (replied.body ?? (replied.attachments.length ? '📎 File' : ''))}
            </Text>
          </View>
        )}
        {!m.deleted && !replied && m.kind === 'text' && topic && (
          <Pressable onPress={onOpenTopic} hitSlop={4}>
            <Text style={[styles.inTopicTag, mineSide && styles.textOnMineSoft]}>
              ↪ {kindOf(topic.kind).icon} {short(topic.message, 30)}
            </Text>
          </Pressable>
        )}

        {m.deleted ? (
          <Text style={[styles.deletedText, mineSide && styles.textOnMineSoft]}>🗑 Message deleted</Text>
        ) : (
          <>
            {!!m.body && (
              <Text
                style={[styles.body, mineSide && !isTopic && styles.textOnMine, isTopic && styles.topicBody]}
                selectable={Platform.OS === 'web'}
              >
                {m.body}
              </Text>
            )}
            {m.attachments.length > 0 && (
              <View style={styles.files}>
                <AttachmentView files={m.attachments} />
              </View>
            )}
          </>
        )}

        <View style={styles.metaRow}>
          {isTopic && (
            <Pressable onPress={onOpenTopic} hitSlop={6} accessibilityRole="button">
              <Text style={styles.replies}>
                {replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'} ›` : 'Open ›'}
              </Text>
            </Pressable>
          )}
          <View style={styles.flex} />
          <Text style={[styles.time, mineSide && !isTopic && styles.textOnMineSoft]}>
            {timeOf(m.createdAt)}
            {mineSide && showTick ? (seen ? '  ✓✓' : '  ✓') : ''}
          </Text>
        </View>
      </Pressable>

      {/* 👍 reactions */}
      {reactions.length > 0 && (
        <View style={[styles.reactions, mineSide ? styles.reactMine : styles.reactThem]}>
          {Object.entries(counts).map(([e, n]) => (
            <Pressable
              key={e}
              onPress={() => onReact(myReaction === e ? null : e)}
              style={[styles.reaction, myReaction === e && styles.reactionOn]}
              accessibilityRole="button"
              accessibilityLabel={`${e} ${n}`}
            >
              <Text style={styles.reactionText}>
                {e}
                {n > 1 ? ` ${n}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------
// Press and hold: reactions, reply, copy, delete, the topic's status
// ---------------------------------------------------------------------
function MessageMenu({
  m,
  me,
  isDev,
  topic,
  onClose,
  onReply,
  onDone,
  onShowTopic,
}: {
  m: ChatMessage | null;
  me: string;
  isDev: boolean;
  topic: ChatTopic | null;
  onClose: () => void;
  onReply: () => void;
  onDone: () => void;
  onShowTopic: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!m) return null;
  const canDelete = m.sender === me && !m.deleted && Date.now() - m.createdAt.getTime() < DELETE_MS;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      Alert.alert('Could not do it', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };
  const closed = topic ? ['done', 'wont'].includes(topic.status) : false;
  const statuses: FeedbackStatus[] = isDev
    ? ['seen', 'working', 'done', 'wont', 'new']
    : closed
      ? ['new']
      : ['done'];

  return (
    <Sheet visible onClose={onClose}>
      {!m.deleted && (
        <View style={styles.reactPick}>
          {REACTIONS.map((e) => (
            <Pressable
              key={e}
              onPress={() => run(() => reactChat(m.id, m.reactions[me] === e ? null : e))}
              style={[styles.reactBtn, m.reactions[me] === e && styles.reactBtnOn]}
              accessibilityRole="button"
              accessibilityLabel={`React ${e}`}
            >
              <Text style={styles.reactBtnText}>{e}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {busy && <ActivityIndicator color={colors.primary} />}
      {!m.deleted && <MenuRow label="↪ Reply" onPress={onReply} />}
      {!!m.body && !m.deleted && (
        <MenuRow
          label="📋 Copy"
          onPress={() => {
            Clipboard.setStringAsync(m.body ?? '').catch(() => undefined);
            onClose();
          }}
        />
      )}
      {topic && (
        <MenuRow
          label={`🗂 Only this topic (${kindOf(topic.kind).icon} ${short(topic.message, 24)})`}
          onPress={onShowTopic}
        />
      )}
      {topic && (
        <>
          <Text style={styles.menuLabel}>TOPIC STATUS · now {STATUS_LINE[topic.status]}</Text>
          <View style={styles.statusPick}>
            {statuses
              .filter((s) => s !== topic.status)
              .map((s) => (
                <Pressable
                  key={s}
                  onPress={() => run(() => setTopicStatus(topic.id, s))}
                  style={styles.statusBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.statusBtnText}>{STATUS_LINE[s]}</Text>
                </Pressable>
              ))}
          </View>
        </>
      )}
      {canDelete && (
        <MenuRow
          label={m.kind === 'topic' ? '🗑 Delete (the topic goes too)' : '🗑 Delete'}
          danger
          onPress={() => run(() => deleteChat(m.id))}
        />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------
function short(s: string, n: number) {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function Avatar({
  name,
  url,
  dev,
  size = 38,
}: {
  name: string;
  url?: string | null;
  dev?: boolean;
  size?: number;
}) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (url) return <Image source={{ uri: url }} style={[styles.avatar, box]} />;
  return (
    <View style={[styles.avatar, box, dev && styles.avatarDev]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>
        {dev ? '🛠' : (name.trim()[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

export function StatusPill({ s }: { s: FeedbackStatus }) {
  const tone =
    s === 'done' ? styles.pillGood : s === 'wont' ? styles.pillOff : s === 'working' ? styles.pillWork : styles.pillNew;
  return (
    <View style={[styles.pill, tone]}>
      <Text style={[styles.pillText, tone]}>{STATUS_LINE[s]}</Text>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Banner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText} numberOfLines={2}>
        {text}
      </Text>
      <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Cancel">
        <Text style={styles.bannerX}>✕</Text>
      </Pressable>
    </View>
  );
}

function RoundBtn({
  label,
  a11y,
  onPress,
  primary,
  off,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  primary?: boolean;
  off?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.round,
        primary && styles.roundPrimary,
        off && styles.roundOff,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    >
      <Text style={[styles.roundText, primary && styles.roundTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          {!!title && <Text style={styles.sheetTitle}>{title}</Text>}
          {children}
        </View>
      </View>
    </Modal>
  );
}

function MenuRow({
  label,
  hint,
  onPress,
  danger,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Text style={[styles.menuText, danger && styles.danger]}>{label}</Text>
      {!!hint && <Text style={styles.menuHint}>{hint}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headName: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  headSub: { fontSize: fontSize.caption, color: colors.textMuted },
  typingText: { color: colors.primary, fontWeight: fontWeight.semibold },
  avatar: { backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarDev: { backgroundColor: isDark ? '#3B2F12' : '#FFF4D6' },
  avatarText: { fontWeight: fontWeight.bold, color: colors.primary },

  shelfScroll: { flexGrow: 0, flexShrink: 0, minHeight: 46, backgroundColor: colors.surface },
  shelf: { gap: spacing.xs, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, alignItems: 'center' },
  chip: {
    maxWidth: 240,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    backgroundColor: colors.primarySoft,
  },
  filterText: { flex: 1, fontSize: fontSize.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  filterClose: { fontSize: fontSize.caption, color: colors.primary, fontWeight: fontWeight.bold },

  list: { padding: spacing.md, gap: 6 },
  empty: { alignItems: 'center', gap: spacing.sm, padding: spacing.xl, transform: [{ scaleY: -1 }] },
  emptyIcon: { fontSize: 44 },
  emptyTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },

  dayWrap: { alignItems: 'center', marginVertical: spacing.sm },
  day: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  statusWrap: { alignItems: 'center', marginVertical: 4 },
  statusLine: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },

  row: { maxWidth: '100%' },
  rowMine: { alignItems: 'flex-end' },
  rowThem: { alignItems: 'flex-start' },
  bubble: { maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18 },
  mine: { backgroundColor: ME_BUBBLE, borderBottomRightRadius: 6 },
  them: { backgroundColor: THEM_BUBBLE, borderBottomLeftRadius: 6 },
  deletedBubble: { opacity: 0.7 },
  sender: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.primary, marginBottom: 2 },
  body: { fontSize: fontSize.body, color: colors.text, lineHeight: 21 },
  textOnMine: { color: '#FFFFFF' },
  textOnMineSoft: { color: 'rgba(255,255,255,0.8)' },
  deletedText: { fontSize: fontSize.small, fontStyle: 'italic', color: colors.textMuted },
  files: { marginTop: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 3 },
  time: { fontSize: 10.5, color: colors.textMuted },

  topicCard: {
    width: '86%',
    maxWidth: 520,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    backgroundColor: colors.surface,
    gap: 4,
  },
  topicMine: { borderColor: colors.primary },
  topicThem: { borderColor: colors.border },
  topicHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  topicKind: { flex: 1, fontSize: 11.5, fontWeight: fontWeight.bold, color: colors.textMuted, letterSpacing: 0.6 },
  topicBody: { fontSize: fontSize.body, color: colors.text, fontWeight: fontWeight.semibold },
  replies: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },

  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    paddingLeft: 8,
    paddingVertical: 2,
    marginBottom: 4,
    backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    borderRadius: 6,
  },
  quoteMine: { borderLeftColor: '#FFFFFF', backgroundColor: 'rgba(255,255,255,0.15)' },
  quoteName: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.primary },
  quoteText: { fontSize: fontSize.caption, color: colors.textMuted },
  inTopicTag: { fontSize: 11, fontWeight: fontWeight.semibold, color: colors.textMuted, marginBottom: 2 },

  reactions: { flexDirection: 'row', gap: 4, marginTop: -6, zIndex: 1 },
  reactMine: { marginRight: 10 },
  reactThem: { marginLeft: 10 },
  reaction: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reactionOn: { borderColor: colors.primary },
  reactionText: { fontSize: 12, color: colors.text },

  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  pillText: { fontSize: 11, fontWeight: fontWeight.bold, backgroundColor: 'transparent' },
  pillNew: { backgroundColor: colors.primarySoft, color: colors.primary },
  pillWork: { backgroundColor: colors.warningSoft, color: colors.warning },
  pillGood: { backgroundColor: colors.successSoft, color: colors.success },
  pillOff: { backgroundColor: colors.background, color: colors.textMuted },

  typingRow: { paddingHorizontal: spacing.md, paddingBottom: 4 },
  typingBubble: { alignSelf: 'flex-start', paddingVertical: 6 },
  dots: { fontSize: 16, color: colors.textMuted, letterSpacing: 2 },

  composer: {
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingTop: 6,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 130,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 20,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.body,
  },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  roundPrimary: { backgroundColor: colors.primary },
  roundOff: { opacity: 0.45 },
  roundText: { fontSize: 19, color: colors.primary, fontWeight: fontWeight.bold },
  roundTextPrimary: { color: colors.textOnPrimary },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  bannerText: { flex: 1, fontSize: fontSize.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  bannerX: { fontSize: 15, color: colors.primary },
  inTopic: { fontSize: 11, color: colors.textMuted, paddingHorizontal: spacing.sm },
  thumbs: { gap: spacing.sm, paddingHorizontal: spacing.xs },
  thumb: { width: 56, height: 72, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.border },
  thumbImg: { width: 56, height: 72 },
  thumbBusy: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  failText: { fontSize: 10, color: '#FFFFFF', fontWeight: fontWeight.bold },
  thumbX: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbXText: { color: '#FFFFFF', fontSize: 11, fontWeight: fontWeight.bold },
  error: { fontSize: fontSize.small, color: colors.danger, paddingHorizontal: spacing.lg },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  menuRow: { paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  menuText: { fontSize: fontSize.body, color: colors.text, fontWeight: fontWeight.semibold },
  menuHint: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  menuLabel: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.6,
    marginTop: spacing.sm,
  },
  danger: { color: colors.danger },
  reactPick: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
  },
  reactBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  reactBtnOn: { backgroundColor: colors.primarySoft },
  reactBtnText: { fontSize: 26 },
  statusPick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statusBtn: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusBtnText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
});
