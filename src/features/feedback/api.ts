import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { File, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

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
  done: { icon: '✅', label: 'Solved' },
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
  /** 📸 pictures and 🎙 a voice message */
  attachments: Attachment[];
  solvedAt: Date | null;
  solvedBy: string | null;
};

export type Attachment = { path: string; kind: 'image' | 'voice'; sec?: number | null };

/** Most pictures with one message */
export const MAX_IMAGES = 3;
/** Longest voice message (seconds) */
export const MAX_VOICE_SEC = 180;

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

export async function sendFeedback(
  kind: FeedbackKind,
  message: string,
  attachments: Attachment[] = [],
  extraInfo: Record<string, string> = {},
): Promise<void> {
  const { error } = await supabase.rpc('send_feedback', {
    p_kind: kind,
    p_message: message,
    p_info: { ...appInfo(), ...extraInfo } as unknown as Json,
    p_attachments: attachments as unknown as Json,
  });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 📎 Files (Supabase Storage, private bucket "feedback", folder = your id)
// ---------------------------------------------------------------------
const BUCKET = 'feedback';

function extFor(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.startsWith('audio/')) return 'm4a';
  return 'jpg';
}

/** Uploads one picture or voice message; gives the path to send with the message */
export async function uploadFeedbackFile(uri: string, mime: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) throw new Error('Please sign in again.');
  const path = `${session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extFor(mime)}`;
  try {
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob();
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: mime });
      if (error) throw error;
    } else {
      // The phone sends the file straight from where it is (no copy in memory)
      const res = await new File(uri).upload(
        `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
        {
          httpMethod: 'POST',
          uploadType: UploadType.BINARY_CONTENT,
          mimeType: mime,
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
            'Content-Type': mime,
          },
        },
      );
      if (res.status < 200 || res.status >= 300) {
        let msg = '';
        try {
          msg = (JSON.parse(res.body) as { message?: string }).message ?? '';
        } catch {
          msg = res.body?.slice(0, 120) ?? '';
        }
        throw new Error(/bucket not found/i.test(msg) ? 'The database is not updated yet.' : msg || 'Could not upload.');
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    throw new Error(/network|internet|offline|timed out|resolve/i.test(m) ? 'No internet connection. Please try again.' : m);
  }
  return path;
}

/** A link to open a file for an hour (only the sender and the developer may) */
export async function feedbackFileUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'Could not open the file.');
  return data.signedUrl;
}

/** ✅ Solved (or open again): the developer, or the sender for their own */
export async function solveFeedback(id: string, solved = true): Promise<void> {
  const { error } = await supabase.rpc('solve_feedback', { p_id: id, p_solved: solved });
  if (error) throw toError(error);
}

/** 🧹 The developer's app removes files of messages solved 90+ days ago (quietly) */
export async function cleanupOldFiles(): Promise<void> {
  try {
    const { data } = await supabase.rpc('feedback_old_files');
    const rows = (data ?? []) as { id: string; paths: string[] }[];
    if (rows.length === 0) return;
    const paths = rows.flatMap((r) => r.paths ?? []).filter(Boolean);
    if (paths.length > 0) {
      const { error } = await supabase.storage.from(BUCKET).remove(paths);
      if (error) return;
    }
    await supabase.rpc('feedback_files_removed', { p_ids: rows.map((r) => r.id) });
  } catch {
    // next time
  }
}

// ---------------------------------------------------------------------
// 💥 Crash reports (the developer's inbox)
// ---------------------------------------------------------------------
export type Crash = {
  id: string;
  name: string | null;
  message: string | null;
  stack: string | null;
  screen: string | null;
  fatal: boolean;
  count: number;
  people: number;
  versions: string[];
  info: Record<string, string>;
  lastUser: string | null;
  firstAt: Date;
  lastAt: Date;
  status: 'open' | 'solved';
  solvedAt: Date | null;
};

export async function listCrashes(): Promise<Crash[]> {
  const { data, error } = await supabase.rpc('crash_inbox');
  if (error) throw toError(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: (r.name as string) ?? null,
    message: (r.message as string) ?? null,
    stack: (r.stack as string) ?? null,
    screen: (r.screen as string) ?? null,
    fatal: !!r.fatal,
    count: Number(r.count ?? 1),
    people: Number(r.people ?? 1),
    versions: (r.versions as string[]) ?? [],
    info: (r.last_info ?? {}) as Record<string, string>,
    lastUser: (r.last_user_name as string) ?? null,
    firstAt: new Date(String(r.first_at)),
    lastAt: new Date(String(r.last_at)),
    status: r.status === 'solved' ? 'solved' : 'open',
    solvedAt: r.solved_at ? new Date(String(r.solved_at)) : null,
  }));
}

export async function solveCrash(id: string, solved = true): Promise<void> {
  const { error } = await supabase.rpc('solve_crash', { p_id: id, p_solved: solved });
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
  attachments?: Json;
  solved_at?: string | null;
  solved_by_name?: string | null;
  files_removed_at?: string | null;
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
  attachments: r.files_removed_at ? [] : (Array.isArray(r.attachments) ? (r.attachments as unknown as Attachment[]) : []),
  solvedAt: r.solved_at ? new Date(r.solved_at) : null,
  solvedBy: r.solved_by_name ?? null,
});

export async function listMyFeedback(userId: string): Promise<Feedback[]> {
  const { data, error } = await supabase
    .from('feedback')
    .select('id, user_id, kind, message, info, status, reply, replied_at, created_at, attachments, solved_at, files_removed_at')
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
