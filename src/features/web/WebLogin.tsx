import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { signIn } from '@/features/auth/api';
import { COLLEGE } from '@/features/web/brand';
import { loadPref, savePref } from '@/features/web/prefs';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';
import { installWebCss } from '@/shared/web/webCss';

// =====================================================================
// 🌐 The website's sign-in page (computer screens)
//   Left: the college. Right: the sign-in card. Show / hide the password,
//   a Caps Lock warning, "remember my email" (never the password).
// =====================================================================

installWebCss();

const LOGO = require('../../../assets/web/ittc-logo-512.png');
const EMAIL_KEY = 'web_login_email';

export function WebLogin() {
  const [email, setEmail] = useState(() => loadPref<string>(EMAIL_KEY, ''));
  const [remember, setRemember] = useState(() => !!loadPref<string>(EMAIL_KEY, ''));
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<{ focus: () => void } | null>(null);
  const emailRef = useRef<{ focus: () => void } | null>(null);

  useEffect(() => {
    document.title = 'Sign in · ITTC Admission Management System';
    // Start where there is something to type
    setTimeout(() => (email ? passwordRef.current?.focus() : emailRef.current?.focus()), 50);
    // ⚠ Caps Lock (the browser tells it on every key)
    const onKey = (e: KeyboardEvent) => {
      if (typeof e.getModifierState === 'function') setCaps(e.getModifierState('CapsLock'));
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Please enter a valid email address.');
    if (!password) return setError('Please enter your password.');
    setLoading(true);
    try {
      await signIn({ email, password });
      savePref(EMAIL_KEY, remember ? email.trim() : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.page}>
      {/* ── The college ─────────────────────────────── */}
      <View style={styles.brand}>
        <View style={styles.glowA} />
        <View style={styles.glowB} />
        <View style={styles.brandInner}>
          <Image source={LOGO} style={styles.bigLogo} accessibilityLabel="ITTC logo" />
          <Text style={styles.college}>{COLLEGE}</Text>
          <View style={styles.rule} />
          <Text style={styles.system}>Admission Management System</Text>
          <View style={styles.points}>
            {[
              ['🎓', 'Students and admissions in one place'],
              ['✅', 'Admission approval, College ID and NU ID'],
              ['💰', 'Fees, discounts, payments and papers'],
            ].map(([icon, text]) => (
              <View key={text} style={styles.point}>
                <Text style={styles.pointIcon}>{icon}</Text>
                <Text style={styles.pointText}>{text}</Text>
              </View>
            ))}
          </View>
        </View>
        <Text style={styles.copy}>
          © {new Date().getFullYear()} {COLLEGE}
        </Text>
      </View>

      {/* ── Sign in ─────────────────────────────────── */}
      <View style={styles.side}>
        <View style={styles.card}>
          <Text style={styles.hello}>Welcome back 👋</Text>
          <Text style={styles.sub}>Sign in to the ITTC Admission Management System.</Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            ref={emailRef as never}
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setError(null);
            }}
            onSubmitEditing={() => passwordRef.current?.focus()}
            placeholder="you@ittc.edu.bd"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            style={styles.input}
            accessibilityLabel="Email"
          />

          <Text style={styles.label}>Password</Text>
          <View style={styles.passRow}>
            <TextInput
              ref={passwordRef as never}
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                setError(null);
              }}
              onSubmitEditing={submit}
              secureTextEntry={!show}
              autoCapitalize="none"
              autoComplete="current-password"
              placeholder="Your password"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.passInput]}
              accessibilityLabel="Password"
            />
            <Pressable
              onPress={() => setShow(!show)}
              style={styles.eye}
              accessibilityRole="button"
              accessibilityLabel={show ? 'Hide password' : 'Show password'}
            >
              <Text style={styles.eyeText}>{show ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>
          {caps && <Text style={styles.caps}>⚠ Caps Lock is on</Text>}

          <Pressable
            onPress={() => setRemember(!remember)}
            style={styles.remember}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: remember }}
          >
            <View style={[styles.box, remember && styles.boxOn]}>{remember && <Text style={styles.tick}>✓</Text>}</View>
            <Text style={styles.rememberText}>Remember my email on this computer</Text>
          </Pressable>

          {error && (
            <View style={styles.error}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            onPress={loading ? undefined : submit}
            style={(state) => [styles.button, (state as { hovered?: boolean }).hovered && styles.buttonHover]}
            accessibilityRole="button"
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
          </Pressable>

          <Text style={styles.forgot}>Forgot your password? Ask an admin to reset it.</Text>
          <View style={styles.newRow}>
            <Text style={styles.forgot}>New to the team?</Text>
            <Pressable onPress={() => router.push('/sign-up')} accessibilityRole="link">
              <Text style={styles.link}>Create an account</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const BLUE = '#0F75BD';

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },

  brand: {
    flex: 1.1,
    overflow: 'hidden',
    backgroundColor: isDark ? '#08101F' : '#0B2A4A',
    padding: 56,
    justifyContent: 'space-between',
  },
  glowA: {
    position: 'absolute',
    width: 520,
    height: 520,
    borderRadius: 260,
    top: -160,
    right: -140,
    backgroundColor: BLUE,
    opacity: 0.35,
  },
  glowB: {
    position: 'absolute',
    width: 380,
    height: 380,
    borderRadius: 190,
    bottom: -140,
    left: -120,
    backgroundColor: '#EC202B',
    opacity: 0.18,
  },
  brandInner: { flex: 1, justifyContent: 'center', maxWidth: 520 },
  bigLogo: { width: 112, height: 112, marginBottom: spacing.xl },
  college: { fontSize: 40, lineHeight: 48, fontWeight: fontWeight.bold, color: '#fff' },
  rule: { width: 64, height: 4, borderRadius: 2, backgroundColor: '#EC202B', marginVertical: spacing.lg },
  system: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: '#BFD3EA' },
  points: { marginTop: spacing.xxl, gap: spacing.md },
  point: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pointIcon: { fontSize: fontSize.title },
  pointText: { fontSize: fontSize.body, color: '#D6E2F0' },
  copy: { fontSize: fontSize.caption, color: '#7F95B2' },

  side: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: {
    width: '100%',
    maxWidth: 420,
    gap: spacing.sm,
    padding: 40,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: isDark ? 0.4 : 0.08,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
  },
  hello: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted, marginBottom: spacing.md },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text, marginTop: spacing.sm },
  input: {
    height: 46,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    fontSize: fontSize.body,
    color: colors.text,
  },
  passRow: { flexDirection: 'row', alignItems: 'center' },
  passInput: { flex: 1, paddingRight: 48 },
  eye: { position: 'absolute', right: 6, width: 48, height: 38, alignItems: 'center', justifyContent: 'center' },
  eyeText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  caps: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.warning },
  remember: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  box: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: '#fff', fontSize: 12, fontWeight: fontWeight.bold, lineHeight: 14 },
  rememberText: { fontSize: fontSize.small, color: colors.text },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  button: {
    height: 48,
    marginTop: spacing.md,
    borderRadius: radius.md,
    backgroundColor: BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonHover: { backgroundColor: '#0C639F' },
  buttonText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: '#fff' },
  forgot: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
  newRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'baseline', gap: 6 },
  link: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
});
