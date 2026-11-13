import { unregisterPush } from '@/features/notifications/push';
import { supabase } from '@/shared/lib/supabase';
import type { Tables } from '@/shared/types/database';
import { forgetAll } from '@/shared/lib/memo';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type MyProfile = Tables<'profiles'> & {
  role: Pick<Tables<'roles'>, 'key' | 'name' | 'permissions'> | null;
};

export type SignUpInput = {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
};

export type SignInInput = {
  email: string;
  password: string;
};

export type FirstRunSetupInput = {
  fullName: string;
  institutionName: string;
};

// ---------------------------------------------------------------------
// Friendly error messages
// ---------------------------------------------------------------------
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();

  if (m.includes('invalid login credentials')) {
    return 'Email or password is incorrect.';
  }
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'An account with this email already exists.';
  }
  if (m.includes('password should be at least')) {
    return 'Password must be at least 6 characters.';
  }
  if (m.includes('unable to validate email') || m.includes('invalid email')) {
    return 'Please enter a valid email address.';
  }
  if (m.includes('network request failed') || m.includes('fetch')) {
    return 'No internet connection. Please try again.';
  }
  return message;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
export async function isSetupComplete(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_setup_complete');
  if (error) throw new Error(friendlyAuthError(error.message));
  return data === true;
}

export async function completeFirstRunSetup(input: FirstRunSetupInput): Promise<void> {
  const { error } = await supabase.rpc('complete_first_run_setup', {
    p_full_name: input.fullName.trim(),
    p_institution_name: input.institutionName.trim(),
  });
  if (error) throw new Error(friendlyAuthError(error.message));
}

// ---------------------------------------------------------------------
// Sign up / sign in / sign out
// ---------------------------------------------------------------------
export async function signUp(input: SignUpInput) {
  const { data, error } = await supabase.auth.signUp({
    email: normalizeEmail(input.email),
    password: input.password,
    options: {
      data: {
        full_name: input.fullName.trim(),
        phone: input.phone?.trim() ?? '',
      },
    },
  });
  if (error) throw new Error(friendlyAuthError(error.message));
  return data;
}

export async function signIn(input: SignInInput) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(input.email),
    password: input.password,
  });
  if (error) throw new Error(friendlyAuthError(error.message));
  return data;
}

// ---------------------------------------------------------------------
// 📱 Sign in with mobile + SMS code (Edge Function otp-login)
// ---------------------------------------------------------------------
/** Is "sign in with a code" on (an SMS company and a non-masking sender in use)? */
export async function otpLoginReady(): Promise<boolean> {
  const { data, error } = await supabase.rpc('otp_login_ready' as never);
  if (error) return false;
  return data === true;
}

export class OtpError extends Error {
  constructor(
    message: string,
    public wait?: number,
  ) {
    super(message);
  }
}

async function otpCall<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('otp-login', { body });
  if (error) {
    let msg = error.message;
    let wait: number | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = await (error as any).context?.json?.();
      if (b?.error) msg = b.error;
      if (typeof b?.wait === 'number') wait = b.wait;
    } catch {
      /* keep the first message */
    }
    if (/failed to send a request|network request failed|fetch/i.test(msg))
      msg = 'No internet connection. Please try again.';
    else if (/not found|404/i.test(msg))
      msg = 'Sign in with a code is not ready on the server yet. Sign in with email.';
    throw new OtpError(msg, wait);
  }
  return data as T;
}

/** Sends the code by SMS; gives the number with dots ("017•••••594") */
export async function sendLoginCode(phone: string, appHash: string): Promise<string> {
  const d = await otpCall<{ ok?: boolean; hint?: string }>({ action: 'send', phone, app_hash: appHash });
  return d?.hint ?? phone;
}

/** Checks the code and signs in (the app moves on by itself) */
export async function verifyLoginCode(phone: string, code: string): Promise<void> {
  const d = await otpCall<{ access_token?: string; refresh_token?: string }>({ action: 'verify', phone, code });
  if (!d?.access_token || !d.refresh_token) throw new Error('Could not sign in. Please try again.');
  const { error } = await supabase.auth.setSession({ access_token: d.access_token, refresh_token: d.refresh_token });
  if (error) throw new Error(friendlyAuthError(error.message));
}

/** 🔐 The signed-in user sets a new password of their own (also after an admin reset) */
export async function changeMyPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (/different from the old/i.test(error.message))
      throw new Error('Please choose a password different from the old one.');
    throw new Error(friendlyAuthError(error.message));
  }
  const { error: flagError } = await supabase.rpc('password_changed');
  if (flagError) throw new Error(friendlyAuthError(flagError.message));
}

export async function signOut() {
  // This phone stops getting this user's pushes (while still signed in)
  await unregisterPush();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(friendlyAuthError(error.message));
  // ⚡ nothing remembered from this person stays for the next one
  forgetAll();
}

// ---------------------------------------------------------------------
// The signed-in user's profile, with role
// ---------------------------------------------------------------------
export async function getMyProfile(userId: string): Promise<MyProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*, role:roles(key, name, permissions)')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(friendlyAuthError(error.message));
  return data as MyProfile | null;
}
