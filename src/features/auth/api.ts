import { supabase } from '@/shared/lib/supabase';
import type { Tables } from '@/shared/types/database';

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

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(friendlyAuthError(error.message));
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