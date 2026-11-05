import type { RealtimeChannel } from '@supabase/supabase-js';

import { appInfo, type Attachment, type FeedbackKind, type FeedbackStatus } from '@/features/feedback/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 💬 Contact developer as a chat: one chat per person, topics inside
//   (🐞 problem · 💡 idea · ❓ question, each with its own status).
//   New messages, reactions and ✓✓ seen come at once (Realtime); typing
//   goes over a broadcast channel (nothing is saved).
// =====================================================================

export type ChatMessage = {
  id: string;
  chatUser: string;
  sender: string;
  kind: 'text' | 'topic' | 'status';
  topicId: string | null;
  replyTo: string | null;
  body: string | null;
  attachments: Attachment[];
  reactions: Record<string, string>;
  info: Record<string, string>;
  createdAt: Date;
  deleted: boolean;
};

export type ChatTopic = {
  id: string;
  kind: FeedbackKind;
  message: string;
  status: FeedbackStatus;
  createdAt: Date;
};

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
/** Own messages can be deleted this long */
export const DELETE_MS = 5 * 60 * 1000;
export const PAGE = 60;

function toError(e: { message: string }): Error {
  if (/could not find the function|feedback_messages/i.test(e.message))
    return new Error('The database is not updated yet.');
  return new Error(/network|fetch/i.test(e.message) ? 'No internet connection. Please try again.' : e.message);
}

type Row = {
  id: string;
  chat_user: string;
  sender: string;
  kind: string;
  topic_id: string | null;
  reply_to: string | null;
  body: string | null;
  attachments: Json;
  reactions: Json;
  info: Json;
  created_at: string;
  deleted_at: string | null;
};

export const toMessage = (r: Row): ChatMessage => ({
  id: r.id,
  chatUser: r.chat_user,
  sender: r.sender,
  kind: (r.kind as ChatMessage['kind']) ?? 'text',
  topicId: r.topic_id,
  replyTo: r.reply_to,
  body: r.body,
  attachments: Array.isArray(r.attachments) ? (r.attachments as unknown as Attachment[]) : [],
  reactions: (r.reactions ?? {}) as Record<string, string>,
  info: (r.info ?? {}) as Record<string, string>,
  createdAt: new Date(r.created_at),
  deleted: !!r.deleted_at,
});

const COLS =
  'id, chat_user, sender, kind, topic_id, reply_to, body, attachments, reactions, info, created_at, deleted_at';

/** The newest messages (or older than a time), oldest first */
export async function listChat(chatUser: string, before?: Date): Promise<{ items: ChatMessage[]; more: boolean }> {
  let q = supabase
    .from('feedback_messages')
    .select(COLS)
    .eq('chat_user', chatUser)
    .order('created_at', { ascending: false })
    .limit(PAGE);
  if (before) q = q.lt('created_at', before.toISOString());
  const { data, error } = await q;
  if (error) throw toError(error);
  const rows = (data ?? []) as unknown as Row[];
  return { items: rows.map(toMessage).reverse(), more: rows.length === PAGE };
}

/** One message (a reply's original, when it is older than the loaded page) */
export async function getMessage(id: string): Promise<ChatMessage | null> {
  const { data } = await supabase.from('feedback_messages').select(COLS).eq('id', id).maybeSingle();
  return data ? toMessage(data as unknown as Row) : null;
}

export async function listTopics(chatUser: string): Promise<ChatTopic[]> {
  const { data, error } = await supabase
    .from('feedback')
    .select('id, kind, message, status, created_at')
    .eq('user_id', chatUser)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw toError(error);
  return (data ?? []).map((t) => ({
    id: t.id,
    kind: t.kind as FeedbackKind,
    message: t.message,
    status: t.status as FeedbackStatus,
    createdAt: new Date(t.created_at),
  }));
}

/** When each side last read this chat (✓✓ seen) */
export async function getReads(chatUser: string): Promise<Record<string, Date>> {
  const { data } = await supabase.from('feedback_reads').select('reader, read_at').eq('chat_user', chatUser);
  const out: Record<string, Date> = {};
  (data ?? []).forEach((r) => (out[r.reader] = new Date(r.read_at)));
  return out;
}

export async function sendChat(input: {
  /** the developer writes in someone's chat; the person leaves it out */
  chatUser?: string | null;
  body: string;
  attachments?: Attachment[];
  replyTo?: string | null;
  topicId?: string | null;
  /** start a new topic */
  topicKind?: FeedbackKind | null;
  extraInfo?: Record<string, string>;
}): Promise<string> {
  const { data, error } = await supabase.rpc('chat_send', {
    p_chat_user: input.chatUser ?? undefined,
    p_body: input.body.trim() || undefined,
    p_attachments: (input.attachments ?? []) as unknown as Json,
    p_reply_to: input.replyTo ?? undefined,
    p_topic: input.topicId ?? undefined,
    p_topic_kind: input.topicKind ?? undefined,
    p_info: (input.topicKind ? { ...appInfo(), ...(input.extraInfo ?? {}) } : {}) as unknown as Json,
  });
  if (error) throw toError(error);
  return String(data);
}

export async function reactChat(messageId: string, emoji: string | null): Promise<void> {
  const { error } = await supabase.rpc('chat_react', { p_message: messageId, p_emoji: emoji ?? '' });
  if (error) throw toError(error);
}

export async function deleteChat(messageId: string): Promise<void> {
  const { error } = await supabase.rpc('chat_delete', { p_message: messageId });
  if (error) throw toError(error);
}

export async function markChatRead(chatUser?: string | null): Promise<void> {
  await supabase.rpc('chat_mark_read', { p_chat_user: chatUser ?? undefined });
}

export async function setTopicStatus(topicId: string, status: FeedbackStatus): Promise<void> {
  const { error } = await supabase.rpc('chat_topic_status', { p_topic: topicId, p_status: status });
  if (error) throw toError(error);
}

/** 🔴 Unread: my chat (or, for the developer, every chat) */
export async function chatUnread(): Promise<number> {
  const { data } = await supabase.rpc('chat_unread');
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------
// The developer's inbox
// ---------------------------------------------------------------------
export type ChatRow = {
  chatUser: string;
  name: string | null;
  role: string | null;
  avatarUrl: string | null;
  lastBody: string | null;
  lastKind: string;
  lastFiles: number;
  lastSender: string;
  lastAt: Date;
  unread: number;
  open: { bug: number; idea: number; question: number };
};

export async function chatInbox(): Promise<ChatRow[]> {
  const { data, error } = await supabase.rpc('chat_inbox');
  if (error) throw toError(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    chatUser: String(r.chat_user),
    name: (r.name as string) ?? null,
    role: (r.role_name as string) ?? null,
    avatarUrl: (r.avatar_url as string) ?? null,
    lastBody: (r.last_body as string) ?? null,
    lastKind: String(r.last_kind ?? 'text'),
    lastFiles: Number(r.last_files ?? 0),
    lastSender: String(r.last_sender ?? ''),
    lastAt: new Date(String(r.last_at)),
    unread: Number(r.unread ?? 0),
    open: { bug: Number(r.open_bug ?? 0), idea: Number(r.open_idea ?? 0), question: Number(r.open_question ?? 0) },
  }));
}

export type OpenTopic = ChatTopic & { chatUser: string; name: string | null; updatedAt: Date; replies: number };

export async function openTopics(): Promise<OpenTopic[]> {
  const { data, error } = await supabase.rpc('chat_open_topics');
  if (error) throw toError(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    chatUser: String(r.chat_user),
    name: (r.name as string) ?? null,
    kind: r.kind as FeedbackKind,
    message: String(r.message ?? ''),
    status: r.status as FeedbackStatus,
    createdAt: new Date(String(r.created_at)),
    updatedAt: new Date(String(r.updated_at)),
    replies: Number(r.replies ?? 0),
  }));
}

// ---------------------------------------------------------------------
// ⚡ Live: changes in one chat, and "typing…"
// ---------------------------------------------------------------------
export type ChatLive = {
  /** say "I am typing" (sent at most every 2 seconds) */
  typing: () => void;
  close: () => void;
};

export function watchChat(
  chatUser: string,
  me: string,
  on: {
    message: (m: ChatMessage) => void;
    read: (reader: string, at: Date) => void;
    topic: () => void;
    typing: (who: string) => void;
  },
): ChatLive {
  let channel: RealtimeChannel | null = null;
  let lastTyping = 0;
  try {
    channel = supabase
      .channel(`chat:${chatUser}`, { config: { broadcast: { self: false } } })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'feedback_messages', filter: `chat_user=eq.${chatUser}` },
        (p) => {
          const row = p.new as Row | undefined;
          if (row && row.id) on.message(toMessage(row));
          if (row?.kind === 'status' || row?.kind === 'topic') on.topic();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'feedback_reads', filter: `chat_user=eq.${chatUser}` },
        (p) => {
          const row = p.new as { reader?: string; read_at?: string } | undefined;
          if (row?.reader && row.read_at) on.read(row.reader, new Date(row.read_at));
        },
      )
      .on('broadcast', { event: 'typing' }, (p) => {
        const who = (p.payload as { who?: string })?.who;
        if (who && who !== me) on.typing(who);
      })
      .subscribe();
  } catch {
    channel = null;
  }
  return {
    typing: () => {
      const now = Date.now();
      if (!channel || now - lastTyping < 2000) return;
      lastTyping = now;
      channel.send({ type: 'broadcast', event: 'typing', payload: { who: me } }).catch(() => undefined);
    },
    close: () => {
      if (channel) supabase.removeChannel(channel).catch(() => undefined);
    },
  };
}

/** "Today", "Yesterday", "Mon 3 Nov" */
export function dayLabel(d: Date): string {
  const today = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.round((b - a) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export const timeOf = (d: Date) => d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });

/** For the chat list: "2m", "3h", "Yesterday", "3 Nov" */
export function shortWhen(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24 && d.getDate() === new Date().getDate()) return timeOf(d);
  const l = dayLabel(d);
  return l === 'Yesterday' ? l : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const STATUS_LINE: Record<FeedbackStatus, string> = {
  new: '🆕 Open again',
  seen: '👀 Seen',
  working: '🔧 Working on it',
  done: '✅ Solved',
  wont: '❌ Won’t do',
};
