import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signOut } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

const AUTO_CHECK_MS = 30_000; // check again every 30 seconds

export default function PendingScreen() {
  const { profile, session, refreshProfile } = useAuth();
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  // A user who was active before and then switched off
  const wasDeactivated = !!profile?.deactivated_at;

  const name = profile?.full_name ?? 'there';
  const email = profile?.email ?? session?.user.email ?? '';

  const checkAgain = async () => {
    setChecking(true);
    try {
      await refreshProfile();
      setLastChecked(new Date());
    } finally {
      setChecking(false);
    }
  };

  // Quietly check every 30 seconds while this screen is open
  useEffect(() => {
    const timer = setInterval(() => {
      refreshProfile().then(() => setLastChecked(new Date()));
    }, AUTO_CHECK_MS);
    return () => clearInterval(timer);
  }, [refreshProfile]);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, wasDeactivated && styles.iconCircleDanger]}>
          <Text style={[styles.icon, wasDeactivated && styles.iconDanger]}>
            {wasDeactivated ? '!' : '⏳'}
          </Text>
        </View>

        <Text style={styles.title}>
          {wasDeactivated ? 'Your account is switched off' : `Hi ${name}, you’re almost in`}
        </Text>

        <Text style={styles.message}>
          {wasDeactivated
            ? 'An admin has deactivated this account. Please contact your admin if you think this is a mistake.'
            : 'Your account has been created. An admin needs to approve it and set your role before you can start. This page checks automatically.'}
        </Text>

        {email !== '' && (
          <View style={styles.emailBox}>
            <Text style={styles.emailLabel}>Signed in as</Text>
            <Text style={styles.email}>{email}</Text>
          </View>
        )}

        <View style={styles.actions}>
          <Button title="Check again" onPress={checkAgain} loading={checking} fullWidth />
          <Button
            title="Sign out"
            variant="secondary"
            onPress={handleSignOut}
            loading={signingOut}
            fullWidth
          />
        </View>

        {lastChecked && (
          <Text style={styles.lastChecked}>
            Last checked at{' '}
            {lastChecked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: radius.pill,
    backgroundColor: colors.warningSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleDanger: {
    backgroundColor: colors.dangerSoft,
  },
  icon: {
    fontSize: fontSize.display,
    color: colors.warning,
  },
  iconDanger: {
    fontWeight: fontWeight.bold,
    color: colors.danger,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    textAlign: 'center',
  },
  message: {
    fontSize: fontSize.small,
    lineHeight: 20,
    color: colors.textMuted,
    textAlign: 'center',
  },
  emailBox: {
    alignSelf: 'stretch',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emailLabel: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
  },
  email: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  actions: {
    alignSelf: 'stretch',
    gap: spacing.md,
  },
  lastChecked: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
  },
});