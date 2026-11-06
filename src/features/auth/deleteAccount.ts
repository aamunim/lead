import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearSaved } from '@/shared/lib/saved';
import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🗑 Delete my account (Google Play: from the app and from the web)
//   The password is asked again; then the database removes the person's
//   own data and closes the login for ever. The institute's records
//   (leads, calls, payments) stay, as "Deleted user".
// =====================================================================

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'The password is not right.';
  if (/could not find the function/i.test(message)) return 'This is not ready yet. Please try again later.';
  if (/network|fetch/i.test(message)) return 'No internet connection. Please try again.';
  return message;
}

/** Signed in: check the password, delete, sign out on this device */
export async function deleteMyAccount(password: string, reason: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const email = data.session?.user.email;
  if (!email) throw new Error('Please sign in first.');
  return deleteAccountWithLogin(email, password, reason);
}

/** From the web page, signed out: sign in with e-mail + password, then delete */
export async function deleteAccountWithLogin(email: string, password: string, reason: string): Promise<void> {
  if (!password) throw new Error('Please type your password.');
  const signIn = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (signIn.error) throw new Error(friendly(signIn.error.message));
  const { error } = await supabase.rpc('delete_my_account' as never, { p_reason: reason.trim() || null } as never);
  if (error) throw new Error(friendly(error.message));
  // The login no longer exists on the server: forget it here too
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  await clearSaved().catch(() => undefined);
  await AsyncStorage.multiRemove(['push.token', 'auth:setup_done']).catch(() => undefined);
}

/** "I can't sign in": a request for an admin */
export async function requestAccountDeletion(name: string, contact: string, note: string): Promise<void> {
  const { error } = await supabase.rpc(
    'request_account_deletion' as never,
    { p_name: name.trim() || null, p_contact: contact.trim(), p_note: note.trim() || null } as never,
  );
  if (error) throw new Error(friendly(error.message));
}

export type DeletionRequest = {
  id: string;
  name: string | null;
  contact: string;
  note: string | null;
  user_id: string | null;
  created_at: string;
  user: { full_name: string | null; email: string | null; phone: string | null } | null;
};

/** Admins: the open requests */
export async function listDeletionRequests(): Promise<DeletionRequest[]> {
  const { data, error } = await supabase
    .from('account_deletion_requests' as never)
    .select(
      'id, name, contact, note, user_id, created_at, user:profiles!account_deletion_requests_user_id_fkey(full_name, email, phone)',
    )
    .is('done_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(friendly(error.message));
  return (data ?? []) as unknown as DeletionRequest[];
}

export async function adminDeleteAccount(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('admin_delete_account' as never, { p_request: requestId } as never);
  if (error) throw new Error(friendly(error.message));
}

export async function closeDeletionRequest(requestId: string, result: 'not_found' | 'rejected'): Promise<void> {
  const { error } = await supabase.rpc(
    'close_deletion_request' as never,
    { p_request: requestId, p_result: result } as never,
  );
  if (error) throw new Error(friendly(error.message));
}
