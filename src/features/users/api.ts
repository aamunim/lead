import { supabase } from '@/shared/lib/supabase';
import type { Tables, TablesUpdate } from '@/shared/types/database';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type UserRow = Tables<'profiles'> & {
  role: Pick<Tables<'roles'>, 'key' | 'name' | 'rank'> | null;
  team_lead: Pick<Tables<'profiles'>, 'id' | 'full_name'> | null;
};

export type UserFilter = 'pending' | 'active' | 'deactivated' | 'all';

export type RoleOption = Pick<Tables<'roles'>, 'key' | 'name' | 'rank' | 'description'>;
export type TeamLeadOption = Pick<Tables<'profiles'>, 'id' | 'full_name' | 'role_key'>;

export type UserUpdate = Pick<
  TablesUpdate<'profiles'>,
  'full_name' | 'phone' | 'role_key' | 'team_lead_id' | 'is_active'
>;

// The columns we read for every user, with role and team lead joined in
const USER_SELECT = `
  *,
  role:roles(key, name, rank),
  team_lead:team_lead_id(id, full_name)
`;

function toError(message: string): Error {
  const m = message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  // Messages from our database rules are already written for people
  return new Error(message);
}

// Remove characters that would break the search filter
function cleanSearch(text: string): string {
  return text.replace(/[%,()*]/g, ' ').trim();
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
export async function listUsers(options: {
  filter?: UserFilter;
  search?: string;
} = {}): Promise<UserRow[]> {
  const { filter = 'all', search = '' } = options;

  let query = supabase
    .from('profiles')
    .select(USER_SELECT)
    .order('created_at', { ascending: false });

  if (filter === 'pending') {
    // never activated yet
    query = query.eq('is_active', false).is('deactivated_at', null);
  } else if (filter === 'active') {
    query = query.eq('is_active', true);
  } else if (filter === 'deactivated') {
    // was active before, then switched off
    query = query.eq('is_active', false).not('deactivated_at', 'is', null);
  }

  const term = cleanSearch(search);
  if (term) {
    query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw toError(error.message);
  return (data ?? []) as unknown as UserRow[];
}

export async function getUser(userId: string): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select(USER_SELECT)
    .eq('id', userId)
    .maybeSingle();

  if (error) throw toError(error.message);
  return data as unknown as UserRow | null;
}

export async function updateUser(userId: string, changes: UserUpdate): Promise<void> {
  const { error } = await supabase.from('profiles').update(changes).eq('id', userId);
  if (error) throw toError(error.message);
}

export async function countPendingUsers(): Promise<number> {
  const { count, error } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', false)
    .is('deactivated_at', null);

  if (error) throw toError(error.message);
  return count ?? 0;
}

// ---------------------------------------------------------------------
// Options for the edit form
// ---------------------------------------------------------------------
export async function listRoles(): Promise<RoleOption[]> {
  const { data, error } = await supabase
    .from('roles')
    .select('key, name, rank, description')
    .order('rank', { ascending: false });

  if (error) throw toError(error.message);
  return data ?? [];
}

export async function listTeamLeads(): Promise<TeamLeadOption[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role_key')
    .eq('is_active', true)
    .in('role_key', ['team_lead', 'admin', 'super_admin'])
    .order('full_name');

  if (error) throw toError(error.message);
  return data ?? [];
}