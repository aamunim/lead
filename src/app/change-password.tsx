import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signOut } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { ChangePasswordForm } from '@/features/auth/ChangePasswordForm';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🔐 An admin reset this user's password: they pick their own before the
//   app opens (the admin never knows it)
// =====================================================================
export default function MustChangePasswordScreen() {
  const { profile, refreshProfile } = useAuth();
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.icon}>🔐</Text>
        <Text style={styles.title}>Set your own password</Text>
        <Text style={styles.text}>
          {profile?.full_name ? `${profile.full_name}, an` : 'An'} admin reset your password. Please choose a new
          password that only you know.
        </Text>
        <ChangePasswordForm onDone={refreshProfile} />
        <Button title="Sign out" variant="ghost" onPress={() => signOut()} fullWidth />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md, maxWidth: 480, width: '100%', alignSelf: 'center' },
  icon: { fontSize: 44, textAlign: 'center' },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  text: { fontSize: fontSize.body, color: colors.textMuted, textAlign: 'center', marginBottom: spacing.sm },
});
