import { Stack, router } from 'expo-router';
import { Alert, StyleSheet, Text } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { ChangePasswordForm } from '@/features/auth/ChangePasswordForm';
import { colors, fontSize, spacing } from '@/shared/theme';

// 🔐 More → Change password
export default function ChangePasswordScreen() {
  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Change password' }} />
      <Text style={styles.text}>Your new password works on every phone and on the website from now on.</Text>
      <ChangePasswordForm
        onDone={() => {
          Alert.alert('Password changed', 'Use the new password next time you sign in.');
          router.back();
        }}
      />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, maxWidth: 560, width: '100%', alignSelf: 'center' },
  text: { fontSize: fontSize.small, color: colors.textMuted },
});
