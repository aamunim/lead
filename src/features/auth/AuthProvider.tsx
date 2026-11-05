import type { Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { clearPhoneCallData } from '@/features/call-sync/api';
import { useAutoCallSync } from '@/features/call-sync/useAutoCallSync';
import {
  DEFAULT_ASSIGNMENT,
  canAssignManually,
  getAssignmentSettings,
  isSharedMode,
  type AssignmentSettings,
} from '@/features/settings/assignment';
import { supabase } from '@/shared/lib/supabase';

import { getMyProfile, isSetupComplete, type MyProfile } from './api';

// ---------------------------------------------------------------------
// Which screen the app should show
// ---------------------------------------------------------------------
export type AuthStatus =
  | 'loading'           // still checking
  | 'error'             // could not reach the server
  | 'needs_setup'       // no Super Admin yet → first-run setup
  | 'signed_out'        // → login screen
  | 'pending_approval'  // signed in, but an admin has not activated the account
  | 'must_change_password' // an admin reset the password: pick your own first
  | 'active';           // → the app

type AuthContextValue = {
  status: AuthStatus;
  session: Session | null;
  profile: MyProfile | null;
  errorMessage: string | null;
  hasPermission: (permission: string) => boolean;
  refreshProfile: () => Promise<void>;
  refreshSetupStatus: () => Promise<void>;
  retry: () => Promise<void>;

  // Lead assignment (from Settings → Lead assignment)
  assignment: AssignmentSettings;
  /** Assignment switch is on */
  assignmentOn: boolean;
  /** Everyone sees and works on every lead (switch off, or "Everyone") */
  sharedMode: boolean;
  /** This user can pick an assignee by hand */
  canAssign: boolean;
  refreshAssignment: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// ⚡ Kept on the phone for a fast start (checked again with the server each time)
const SETUP_KEY = 'auth:setup_done';
const PROFILE_KEY = 'auth:profile:';

// ---------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const [assignment, setAssignment] = useState<AssignmentSettings>(DEFAULT_ASSIGNMENT);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const userId = session?.user.id ?? null;
  const isActive = !!profile?.is_active;

  // --- setup status -------------------------------------------------
  const refreshSetupStatus = useCallback(async () => {
    try {
      setErrorMessage(null);
      const done = await isSetupComplete();
      setSetupComplete(done);
      if (done) AsyncStorage.setItem(SETUP_KEY, '1').catch(() => undefined);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }, []);

  // --- profile ------------------------------------------------------
  const refreshProfile = useCallback(async () => {
    if (!userId) {
      setProfile(null);
      return;
    }
    try {
      setProfileLoading(true);
      setErrorMessage(null);
      const fresh = await getMyProfile(userId);
      setProfile(fresh);
      // ⚡ kept on the phone: the next start opens at once with it (then checks again)
      if (fresh) AsyncStorage.setItem(PROFILE_KEY + userId, JSON.stringify(fresh)).catch(() => undefined);
      else AsyncStorage.removeItem(PROFILE_KEY + userId).catch(() => undefined);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setProfileLoading(false);
    }
  }, [userId]);

  // --- assignment setting -------------------------------------------
  // Never blocks the app: if it can't be read, the defaults are used.
  const refreshAssignment = useCallback(async () => {
    if (!isActive) return;
    setAssignment(await getAssignmentSettings());
  }, [isActive]);

  // --- session: read once, then listen for login / logout ----------
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoaded(true);
    });

    // Note: only update state here; never await Supabase calls inside
    // this callback (it can block the auth client).
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);

      // Logged out: remove lead names from the phone and stop call capture,
      // so the next person on this phone never sees them (no Supabase call here)
      if (event === 'SIGNED_OUT') {
        clearPhoneCallData().catch(() => undefined);
        AsyncStorage.getAllKeys()
          .then((keys) => AsyncStorage.multiRemove(keys.filter((k) => k.startsWith(PROFILE_KEY))))
          .catch(() => undefined);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // --- check setup once when the app opens -------------------------
  //   ⚡ a phone that saw it done once starts at once (it is checked again)
  useEffect(() => {
    AsyncStorage.getItem(SETUP_KEY)
      .then((v) => v === '1' && setSetupComplete((now) => (now === null ? true : now)))
      .catch(() => undefined);
    refreshSetupStatus();
  }, [refreshSetupStatus]);

  // ⚡ last time's profile at once, so the app opens without waiting for the server
  useEffect(() => {
    if (!userId) return;
    let live = true;
    AsyncStorage.getItem(PROFILE_KEY + userId)
      .then((raw) => {
        if (!live || !raw) return;
        const saved = JSON.parse(raw) as MyProfile;
        setProfile((now) => now ?? saved);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId]);

  // --- load the profile whenever the signed-in user changes --------
  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  // --- load the assignment setting once the user is active ---------
  useEffect(() => {
    refreshAssignment();
  }, [refreshAssignment]);

  // --- and again whenever the app comes back to the front ----------
  // (so a change an admin made shows up without restarting the app)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshAssignment();
    });
    return () => sub.remove();
  }, [refreshAssignment]);

  // --- phone call log → server (Android dev build / APK only) ------
  useAutoCallSync(isActive && !!session);

  // --- retry everything (used by the error screen) -----------------
  const retry = useCallback(async () => {
    await refreshSetupStatus();
    await refreshProfile();
  }, [refreshSetupStatus, refreshProfile]);

  // --- permissions --------------------------------------------------
  const hasPermission = useCallback(
    (permission: string) => {
      if (!profile?.is_active) return false;
      const permissions = profile.role?.permissions ?? [];
      return permissions.includes('*') || permissions.includes(permission);
    },
    [profile],
  );

  const assignmentOn = assignment.enabled;
  const sharedMode = isSharedMode(assignment);
  const canAssign = canAssignManually(assignment, hasPermission);

  // --- decide the status -------------------------------------------
  const status: AuthStatus = useMemo(() => {
    if (errorMessage && setupComplete === null) return 'error';
    if (!sessionLoaded || setupComplete === null) return 'loading';
    if (!setupComplete) return 'needs_setup';
    if (!session) return 'signed_out';
    if (profileLoading && !profile) return 'loading';
    if (errorMessage && !profile) return 'error';
    if (!profile || !profile.is_active) return 'pending_approval';
    if (profile.must_change_password) return 'must_change_password';
    return 'active';
  }, [errorMessage, sessionLoaded, setupComplete, session, profileLoading, profile]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      profile,
      errorMessage,
      hasPermission,
      refreshProfile,
      refreshSetupStatus,
      retry,
      assignment,
      assignmentOn,
      sharedMode,
      canAssign,
      refreshAssignment,
    }),
    [
      status,
      session,
      profile,
      errorMessage,
      hasPermission,
      refreshProfile,
      refreshSetupStatus,
      retry,
      assignment,
      assignmentOn,
      sharedMode,
      canAssign,
      refreshAssignment,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}