import Constants from 'expo-constants';
import * as Device from 'expo-device';

import { currentVersionInfo } from '@/features/updates/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 💬 Contact developer: problems, ideas, questions. Everyone sends and
//   sees their own (with the answer); the developer sees all.
// =====================================================================

export type FeedbackKind = 'bug' | 'idea' | 'question';
export type FeedbackStatus = 'new' | 'seen' | 'working' | 'done' | 'wont';

export const KINDS: { kind: FeedbackKind; icon: string; label: string; hint: string }[] = [
  { kind: 'bug', icon: '🐞', label: 'Problem', hint: 'What did you do, and what went wrong?' },
  { kind: 'idea', icon: '💡', label: 'Idea', hint: 'What would make the app better for you?' },
  { kind: 'question', icon: '❓', label: 'Question', hint: 'What would you like to know?' },
];

export const STATUS: Record<FeedbackStatus, { icon: string; label: string }> = {
  new: { icon: '🆕', label: 'New' },
  seen: { icon: '👀', label: 'Seen' },
  working: { icon: '🔧', label: 'Working on it' },
  done: { icon: '✅', label: 'Done' },
  wont: { icon: '❌', label: 'Won’t do' },
};

export type Feedback = {
  id: string;
  userId: string;
  sender: string | null;
  role: string | null;
  kind: FeedbackKind;
  message: string;
  info: Record<string, string>;
  status: FeedbackStatus;
  reply: string | null;
  repliedAt: Date | null;
  createdAt: Date;
};

function toError(e: { message: string }): Error {
  if (/could not find the function|relation .*feedback/i.test(e.message))
    return new Error('The database is not updated yet (npx supabase db push).');
  return new Error(/network|fetch/i.test(e.message) ? 'No internet connection. Please try again.' : e.message);
}

/** The app and phone, sent with each message */
export function appInfo(): Record<string, string> {
  const u = currentVersionInfo();
  const info: Record<string, string> = {};
  const add = (k: string, v: string | null | undefined) => {
    if (v) info[k] = v;
  };
  add('app', Constants.expoConfig?.version);
  add('update', u.builtIn ? 'built in' : u.updateId?.replace(/-/g, '').slice(0, 8));
  add('update_at', !u.builtIn && u.createdAt ? u.createdAt.toISOString() : null);
  add('phone', [Device.manufacturer, Device.modelName].filter(Boolean).join(' '));
  add('android', Device.osVersion);
  return info;
}

export async function isDeveloper(): Promise<boolean> {
  const { data } = await supabase.rpc('is_developer');
  return !!data;
}

export async function sendFeedback(kind: FeedbackKind, message: string): Promise<void> {
  const { error } = await supabase.rpc('send_feedback', {
    p_kind: kind,
    p_message: message,
    p_info: appInfo() as unknown as Json,
  });
  if (error) throw toError(error);
}

const map = (r: {
  id: string;
  user_id: string;
  sender?: string | null;
  role_name?: string | null;
  kind: string;
  message: string;
  info: Json;
  status: string;
  reply: string | null;
  replied_at: string | null;
  created_at: string;
}): Feedback => ({
  id: r.id,
  userId: r.user_id,
  sender: r.sender ?? null,
  role: r.role_name ?? null,
  kind: r.kind as FeedbackKind,
  message: r.message,
  info: (r.info ?? {}) as Record<string, string>,
  status: r.status as FeedbackStatus,
  reply: r.reply,
  repliedAt: r.replied_at ? new Date(r.replied_at) : null,
  createdAt: new Date(r.created_at),
});

export async function listMyFeedback(userId: string): Promise<Feedback[]> {
  const { data, error } = await supabase
    .from('feedback')
    .select('id, user_id, kind, message, info, status, reply, replied_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw toError(error);
  return (data ?? []).map(map);
}

export async function listInbox(): Promise<Feedback[]> {
  const { data, error } = await supabase.rpc('feedback_inbox');
  if (error) throw toError(error);
  return (data ?? []).map(map);
}

export async function countNewFeedback(): Promise<number> {
  const { count } = await supabase.from('feedback').select('id', { count: 'exact', head: true }).eq('status', 'new');
  return count ?? 0;
}

export async function answerFeedback(id: string, status: FeedbackStatus, reply: string): Promise<void> {
  const { error } = await supabase.rpc('answer_feedback', { p_id: id, p_status: status, p_reply: reply });
  if (error) throw toError(error);
}

export function dayTime(d: Date): string {
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
