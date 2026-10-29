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

import { signUp } from '@/features/auth/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

type Form = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
};

type Errors = Partial<Record<keyof Form, string>>;

const EMPTY_FORM: Form = {
  fullName: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
};

function validate(form: Form): Errors {
  const errors: Errors = {};

  if (!form.fullName.trim()) errors.fullName = 'Please enter your name.';

  if (!form.email.trim()) {
    errors.email = 'Please enter your email.';
  } else if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) {
    errors.email = 'Please enter a valid email address.';
  }

  if (form.password.length < 8) {
    errors.password = 'Password must be at least 8 characters.';
  }
  if (form.confirmPassword !== form.password) {
    errors.confirmPassword = 'Passwords do not match.';
  }

  return errors;
}

export default function SignUpScreen() {
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const update = (key: keyof Form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const handleSignUp = async () => {
    const found = validate(form);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    try {
      await signUp({
        email: form.email,
        password: form.password,
        fullName: form.fullName,
        phone: form.phone,
      });
      // The user is now signed in but not yet active,
      // so the app moves to the "waiting for approval" screen by itself.
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not create the account. Please try again.');
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
            <Text style={styles.title}>Create your account</Text>
            <Text style={styles.subtitle}>
              Join your team on Lead Management.
            </Text>
          </View>

          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              After you sign up, an admin needs to approve your account and set your role before
              you can start.
            </Text>
          </View>

          <View style={styles.card}>
            <TextField
              label="Full name"
              required
              value={form.fullName}
              onChangeText={update('fullName')}
              error={errors.fullName}
              autoCapitalize="words"
              autoComplete="name"
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
            />
            <TextField
              ref={emailRef}
              label="Email"
              required
              value={form.email}
              onChangeText={update('email')}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              returnKeyType="next"
              onSubmitEditing={() => phoneRef.current?.focus()}
            />
            <TextField
              ref={phoneRef}
              label="Phone"
              hint="Optional, so your admin can reach you"
              value={form.phone}
              onChangeText={update('phone')}
              keyboardType="phone-pad"
              autoComplete="tel"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
            <TextField
              ref={passwordRef}
              label="Password"
              required
              value={form.password}
              onChangeText={update('password')}
              error={errors.password}
              hint="At least 8 characters"
              secureTextEntry
              autoCapitalize="none"
              autoComplete="new-password"
              returnKeyType="next"
              onSubmitEditing={() => confirmRef.current?.focus()}
            />
            <TextField
              ref={confirmRef}
              label="Confirm password"
              required
              value={form.confirmPassword}
              onChangeText={update('confirmPassword')}
              error={errors.confirmPassword}
              secureTextEntry
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={handleSignUp}
            />

            {formError && (
              <View style={styles.formError}>
                <Text style={styles.formErrorText}>{formError}</Text>
              </View>
            )}

            <Button title="Create account" onPress={handleSignUp} loading={loading} fullWidth />
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Already have an account?</Text>
            <Button title="Sign in" variant="ghost" onPress={() => router.back()} />
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
  header: { gap: spacing.sm },
  title: {
    fontSize: fontSize.heading,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSize.small,
    color: colors.textMuted,
  },
  notice: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.infoSoft,
  },
  noticeText: {
    fontSize: fontSize.small,
    lineHeight: 20,
    color: colors.info,
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
  footer: { alignItems: 'center' },
  footerText: {
    fontSize: fontSize.small,
    color: colors.textMuted,
  },
});