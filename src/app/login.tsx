import { router } from 'expo-router';
import { useRef, useState } from 'react';
import {
    StyleSheet,
    Text,
    View,
    type TextInput,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signIn } from '@/features/auth/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

type Errors = { email?: string; password?: string };

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  const validate = (): Errors => {
    const found: Errors = {};
    if (!email.trim()) {
      found.email = 'Please enter your email.';
    } else if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      found.email = 'Please enter a valid email address.';
    }
    if (!password) found.password = 'Please enter your password.';
    return found;
  };

  const handleLogin = async () => {
    const found = validate();
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    try {
      await signIn({ email, password });
      // Nothing else to do: the auth status changes and the app moves on.
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.flex}>
        <KeyboardAwareScrollView
          bottomOffset={spacing.xl}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <View style={styles.logo}>
              <Text style={styles.logoText}>LM</Text>
            </View>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in to continue to Lead Management.</Text>
          </View>

          <View style={styles.card}>
            <TextField
              label="Email"
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
              }}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />

            <TextField
              ref={passwordRef}
              label="Password"
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
              }}
              error={errors.password}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />

            {formError && (
              <View style={styles.formError}>
                <Text style={styles.formErrorText}>{formError}</Text>
              </View>
            )}

            <Button title="Sign in" onPress={handleLogin} loading={loading} fullWidth />

            <Text style={styles.forgot}>
              Forgot your password? Ask your admin to reset it.
            </Text>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>New to the team?</Text>
            <Button
              title="Create an account"
              variant="ghost"
              onPress={() => router.push('/sign-up')}
            />
          </View>
        </KeyboardAwareScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.xl,
  },
  header: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  logoText: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.textOnPrimary,
  },
  title: {
    fontSize: fontSize.heading,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSize.small,
    color: colors.textMuted,
    textAlign: 'center',
  },
  card: {
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  formError: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  formErrorText: {
    fontSize: fontSize.small,
    color: colors.danger,
  },
  forgot: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  footer: {
    alignItems: 'center',
  },
  footerText: {
    fontSize: fontSize.small,
    color: colors.textMuted,
  },
});