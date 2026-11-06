import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 📱 App versions (admins): each person's phones, the build and the EAS
//   update they run, when last opened. "Old" = an update older than the
//   newest one any phone runs.
// =====================================================================

export type DeviceVersion = {
  userId: string;
  name: string;
  role: string | null;
  device: string | null;
  build: string | null;
  updateId: string | null;
  updateAt: Date | null;
  channel: string | null;
  lastSeen: Date | null;
};

export type VersionState = 'latest' | 'old' | 'builtin' | 'never';

export async function listAppVersions(): Promise<DeviceVersion[]> {
  const { data, error } = await supabase.rpc('app_versions');
  if (error) {
    throw new Error(
      /could not find the function/i.test(error.message)
        ? 'The database is not updated yet (npx supabase db push).'
        : error.message,
    );
  }
  return (data ?? []).map((r) => ({
    userId: r.user_id,
    name: r.full_name,
    role: r.role_name,
    device: r.device_label,
    build: r.app_version,
    updateId: r.update_id,
    updateAt: r.update_at ? new Date(r.update_at) : null,
    channel: r.channel,
    lastSeen: r.last_seen_at ? new Date(r.last_seen_at) : null,
  }));
}

/** The newest update any phone runs */
export function newestUpdate(rows: DeviceVersion[]): DeviceVersion | null {
  let best: DeviceVersion | null = null;
  for (const r of rows) if (r.updateAt && (!best || r.updateAt > best.updateAt!)) best = r;
  return best;
}

/** 🌐 A website line (the website always runs the newest version) */
export const isWebDevice = (r: Pick<DeviceVersion, 'device'>) => !!r.device?.startsWith('🌐');

export function stateOf(r: DeviceVersion, newest: DeviceVersion | null): VersionState {
  if (!r.lastSeen) return 'never';
  if (isWebDevice(r)) return 'latest';
  if (!r.updateId) return newest ? 'old' : 'builtin';
  if (!newest || r.updateId === newest.updateId) return 'latest';
  return r.updateAt && newest.updateAt && r.updateAt >= newest.updateAt ? 'latest' : 'old';
}

export async function askToUpdate(userIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('ask_app_update', { p_users: userIds });
  if (error) throw new Error(error.message);
  return data ?? 0;
}

/** 01a19cb9 */
export const shortId = (id: string | null) => (id ? id.replace(/-/g, '').slice(0, 8) : null);
