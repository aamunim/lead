import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { completeFirstRunSetup, signIn, signUp } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

type Form = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  institutionName: string;
};

type Errors = Partial<Record<keyof Form, string>>;

const EMPTY_FORM: Form = {
  fullName: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
  institutionName: '',
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

  if (!form.institutionName.trim()) {
    errors.institutionName = 'Please enter the institution name.';
  }

  return errors;
}

export default function SetupScreen() {
  const { session, refreshProfile, refreshSetupStatus } = useAuth();

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Refs so the keyboard's "Next" button moves to the next field
  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const institutionRef = useRef<TextInput>(null);

  const update = (key: keyof Form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const handleSubmit = async () => {
    const found = validate(form);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      // 1. Create the account (or sign in, if a previous attempt already created it)
      if (!session) {
        try {
          await signUp({
            email: form.email,
            password: form.password,
            fullName: form.fullName,
            phone: form.phone,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message.includes('already exists')) {
            await signIn({ email: form.email, password: form.password });
          } else {
            throw error;
          }
        }
      }

      // 2. Become Super Admin and save the institution name
      await completeFirstRunSetup({
        fullName: form.fullName,
        institutionName: form.institutionName,
      });

      // 3. Reload profile first, then setup status (avoids a flash of the
      //    "waiting for approval" screen). The app then opens Home by itself.
      await refreshProfile();
      await refreshSetupStatus();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.eyebrow}>FIRST-TIME SETUP</Text>
            <Text style={styles.title}>Welcome to Lead Management</Text>
            <Text style={styles.subtitle}>
              Create the first account. You will be the Super Admin and can add your team later.
            </Text>
          </View>

          {/* Your account */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your account</Text>

            <TextField
              label="Full name"
              required
              value={form.fullName}
              onChangeText={update('fullName')}
              error={errors.fullName}
              autoCapitalize="words"
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
              hint="Optional, for contact only"
              value={form.phone}
              onChangeText={update('phone')}
              keyboardType="phone-pad"
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
              returnKeyType="next"
              onSubmitEditing={() => institutionRef.current?.focus()}
            />
          </View>

          {/* Institution */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Institution</Text>

            <TextField
              ref={institutionRef}
              label="Institution name"
              required
              value={form.institutionName}
              onChangeText={update('institutionName')}
              error={errors.institutionName}
              hint="Shown in the app and on money receipts"
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
          </View>

          {formError && (
            <View style={styles.formError}>
              <Text style={styles.formErrorText}>{formError}</Text>
            </View>
          )}

          <Button
            title="Create Super Admin account"
            onPress={handleSubmit}
            loading={saving}
            fullWidth
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: {
    padding: spacing.xl,
    gap: spacing.xl,
  },
  header: { gap: spacing.sm },
  eyebrow: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.5,
    color: colors.accent,
  },
  title: {
    fontSize: fontSize.heading,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  subtitle: {
    fontSize: fontSize.small,
    lineHeight: 20,
    color: colors.textMuted,
  },
  card: {
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.text,
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
});