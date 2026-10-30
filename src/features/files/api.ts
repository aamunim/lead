import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 📎 Lead files in the institute's Google Drive
//   Upload and open go through the server (Edge Functions drive-*), which
//   holds the Google connection. The app never sees Drive links or tokens.
//   Who sees a file: the person who added it, plus admins and the people
//   allowed in Settings → Google Drive.
// =====================================================================

export type FilesSettings = { enabled: boolean; view_all: WhoRule };
export const DEFAULT_FILES_SETTINGS: FilesSettings = {
  enabled: true,
  view_all: { mode: 'roles', roles: [], user_ids: [] },
};

export type LeadFile = {
  id: string;
  lead_id: string;
  kind: 'paper' | 'voice' | 'other';
  paper_id: string | null;
  call_id: string | null;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  duration_sec: number | null;
  uploaded_by: string | null;
  created_at: string;
};

export type DriveStatus = { connected: boolean; email: string | null; connected_at: string | null; connected_by: string | null };

const FUNCTIONS = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1`;
const APP_LINK = 'leadmanagement://drive-connected';

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  return { Authorization: `Bearer ${token}`, apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '' };
}

// ---------------------------------------------------------------------
// Settings and the Google connection
// ---------------------------------------------------------------------
export async function getFilesSettings(): Promise<FilesSettings> {
  try {
    const saved = await getSetting<Partial<FilesSettings>>('files');
    return {
      ...DEFAULT_FILES_SETTINGS,
      ...(saved ?? {}),
      view_all: { ...DEFAULT_FILES_SETTINGS.view_all, ...(saved?.view_all ?? {}) },
    };
  } catch {
    return DEFAULT_FILES_SETTINGS;
  }
}

export async function saveFilesSettings(s: FilesSettings): Promise<void> {
  await updateSetting('files', s as unknown as Json);
}

/** Sees everyone's files (same rule as can_view_all_files) */
export function canViewAllFiles(s: FilesSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile) return false;
  if (isAdmin) return true;
  if (s.view_all.mode === 'all') return true;
  if (s.view_all.mode === 'roles') return s.view_all.roles.includes(profile.role_key);
  if (s.view_all.mode === 'users') return s.view_all.user_ids.includes(profile.id);
  return false;
}

export async function getDriveStatus(): Promise<DriveStatus> {
  const { data, error } = await supabase.rpc('drive_status');
  if (error) throw toError(error);
  return data as unknown as DriveStatus;
}

/** Admin: sign in to Google in the browser and allow access; back in the app afterwards */
export async function connectDrive(): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${FUNCTIONS}/drive-connect`, { method: 'POST', headers: await authHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) {
    throw new Error(
      res.status === 404
        ? 'The Google Drive server part is not set up yet (Edge Functions not deployed).'
        : body.error ?? 'Could not start.',
    );
  }
  const result = await WebBrowser.openAuthSessionAsync(body.url, APP_LINK);
  if (result.type !== 'success') return { ok: false, message: '' };
  const url = new URL(result.url);
  return { ok: url.searchParams.get('ok') === '1', message: url.searchParams.get('message') ?? '' };
}

export async function disconnectDrive(): Promise<void> {
  const { error } = await supabase.rpc('drive_disconnect');
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// Files of a lead
// ---------------------------------------------------------------------
export async function listLeadFiles(leadId: string): Promise<LeadFile[]> {
  const { data, error } = await supabase
    .from('lead_files')
    .select('id, lead_id, kind, paper_id, call_id, name, mime_type, size_bytes, duration_sec, uploaded_by, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw toError(error);
  return (data ?? []) as unknown as LeadFile[];
}

export async function uploadLeadFile(input: {
  leadId: string;
  kind: LeadFile['kind'];
  paperId?: string | null;
  callId?: string | null;
  uri: string;
  name: string;
  mimeType: string;
  durationSec?: number | null;
}): Promise<LeadFile> {
  const form = new FormData();
  // React Native sends a file from its uri like this
  form.append('file', { uri: input.uri, name: input.name, type: input.mimeType } as unknown as Blob);
  form.append('lead_id', input.leadId);
  form.append('kind', input.kind);
  form.append('name', input.name);
  if (input.paperId) form.append('paper_id', input.paperId);
  if (input.callId) form.append('call_id', input.callId);
  if (input.durationSec) form.append('duration_sec', String(input.durationSec));

  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS}/drive-upload`, { method: 'POST', headers: await authHeaders(), body: form });
  } catch {
    throw new Error('No internet connection. Please try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(res.status === 404 && !body.error ? 'The Google Drive server part is not set up yet.' : body.error ?? 'Could not upload.');
  }
  return body as LeadFile;
}

export async function deleteLeadFile(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_lead_file', { p_file_id: id });
  if (error) throw toError(error);
}

/** Download through the server and open it in the phone's viewer */
export async function openLeadFile(f: LeadFile): Promise<void> {
  const safeName = `${f.id.slice(0, 8)}-${f.name.replace(/[^\w.\- ]+/g, '_')}`;
  const target = new File(Paths.cache, safeName);
  if (!target.exists) {
    try {
      await File.downloadFileAsync(`${FUNCTIONS}/drive-file?id=${encodeURIComponent(f.id)}`, target, {
        headers: await authHeaders(),
      });
    } catch (e) {
      if (target.exists) target.delete();
      throw new Error(e instanceof Error && /404/.test(e.message) ? 'File not found, or you may not open it.' : 'Could not download the file.');
    }
  }

  if (Platform.OS === 'android') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const launcher = require('expo-intent-launcher') as typeof import('expo-intent-launcher');
      await launcher.startActivityAsync('android.intent.action.VIEW', {
        data: target.contentUri,
        type: f.mime_type ?? undefined,
        flags: 1, // read permission for the viewer app
      });
      return;
    } catch {
      // no viewer for this type: share sheet below
    }
  }
  await Sharing.shareAsync(target.uri, { mimeType: f.mime_type ?? undefined, dialogTitle: f.name });
}

export const sizeText = (bytes: number | null) =>
  bytes == null ? '' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
