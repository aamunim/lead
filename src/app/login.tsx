import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type TextInput,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { otpLoginReady, signIn } from '@/features/auth/api';
import { OtpLogin } from '@/features/auth/OtpLogin';
import { isWeb } from '@/features/web/api';
import { APP_COLLEGE, APP_PRODUCT } from '@/features/web/brand';
import { WebLogin } from '@/features/web/WebLogin';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🔐 Sign in (phone): the ITTC blue top with the logo, a white card that
//   rises over it, remember-my-email, a little shake on a wrong password.
//   Only React Native's own animation (works with an EAS update).
// =====================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LOGO = require('../../assets/web/ittc-logo-192.png');
const EMAIL_KEY = 'login_email';
const MODE_KEY = 'login_mode';
const VERSION = Constants.expoConfig?.version ?? '';

type Errors = { email?: string; password?: string };

export default function LoginScreen() {
  const { width } = useWindowDimensions();
  // 🌐 Website on a computer screen: the ITTC sign-in page
  if (isWeb && width >= 900) return <WebLogin />;
  return <PhoneLogin />;
}

function PhoneLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  // 📱 Mobile + SMS code, when an admin has it on (the choice from last time is kept;
  //    it never switches by itself once you have started typing)
  const [otpOn, setOtpOn] = useState(false);
  const [mode, setMode] = useState<'otp' | 'email'>('email');
  const typed = useRef(false);
  useEffect(() => {
    let live = true;
    Promise.all([otpLoginReady(), AsyncStorage.getItem(MODE_KEY).catch(() => null)]).then(([on, saved]) => {
      if (!live) return;
      setOtpOn(on);
      if (on && saved !== 'email' && !typed.current) setMode('otp');
    });
    return () => {
      live = false;
    };
  }, []);
  const pickMode = (m: 'otp' | 'email') => {
    setMode(m);
    setFormError(null);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => undefined);
  };

  // The email from last time
  useEffect(() => {
    AsyncStorage.getItem(EMAIL_KEY)
      .then((saved) => {
        if (saved) setEmail((now) => now || saved);
      })
      .catch(() => undefined);
  }, []);

  // ── Animation: in from below, the circles drift, a shake on an error ──
  const enter = useRef(new Animated.Value(0)).current;
  const drift = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 6000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 6000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [enter, drift]);

  const doShake = () => {
    shake.setValue(0);
    Animated.sequence(
      [10, -10, 7, -7, 3, 0].map((v) =>
        Animated.timing(shake, { toValue: v, duration: 55, easing: Easing.linear, useNativeDriver: true }),
      ),
    ).start();
  };

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
    if (Object.keys(found).length > 0) {
      doShake();
      return;
    }

    setLoading(true);
    try {
      if (remember) await AsyncStorage.setItem(EMAIL_KEY, email.trim()).catch(() => undefined);
      else await AsyncStorage.removeItem(EMAIL_KEY).catch(() => undefined);
      await signIn({ email, password });
      // Nothing else to do: the auth status changes and the app moves on.
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not sign in. Please try again.');
      doShake();
    } finally {
      setLoading(false);
    }
  };

  const rise = (from: number) => ({
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }],
  });
  const float = (dx: number, dy: number) => ({
    transform: [
      { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
      { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
    ],
  });

  return (
    <View style={styles.screen}>
      <KeyboardAwareScrollView
        bottomOffset={spacing.xl}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* ── Blue top ─────────────────────────────── */}
        <View style={styles.hero}>
          <Animated.View style={[styles.blob, styles.blobA, float(18, 12)]} />
          <Animated.View style={[styles.blob, styles.blobB, float(-14, 16)]} />
          <Animated.View style={[styles.blob, styles.blobC, float(10, -10)]} />
          <SafeAreaView edges={['top']} style={styles.heroInner}>
            <Animated.View style={[styles.brand, rise(-16)]}>
              <View style={styles.logoRing}>
                <Image source={LOGO} style={styles.logo} accessibilityLabel="ITTC logo" />
              </View>
              <Text style={styles.college}>{APP_COLLEGE}</Text>
              <View style={styles.productPill}>
                <Text style={styles.product}>🎓 {APP_PRODUCT}</Text>
              </View>
            </Animated.View>
          </SafeAreaView>
        </View>

        {/* ── White card ───────────────────────────── */}
        <Animated.View style={[styles.cardWrap, rise(40)]}>
          <Animated.View style={[styles.card, { transform: [{ translateX: shake }] }]}>
            <View style={styles.cardHead}>
              <Text style={styles.title}>Welcome back 👋</Text>
              <Text style={styles.subtitle}>
                {mode === 'otp' ? 'Sign in with your mobile number.' : 'Sign in with your work email.'}
              </Text>
            </View>

            {otpOn && (
              <View style={styles.modes} accessibilityRole="tablist">
                {(
                  [
                    ['otp', '📱 Mobile + code'],
                    ['email', '✉️ Email + password'],
                  ] as const
                ).map(([m, label]) => (
                  <Pressable
                    key={m}
                    onPress={() => pickMode(m)}
                    style={[styles.mode, mode === m && styles.modeOn]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: mode === m }}
                  >
                    <Text style={[styles.modeText, mode === m && styles.modeTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {mode === 'otp' ? (
              <OtpLogin onFail={doShake} />
            ) : (
              <>
                <TextField
                  label="Email"
                  value={email}
                  onChangeText={(v) => {
                    typed.current = true;
                    setEmail(v);
                    if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
                  }}
                  error={errors.email}
                  placeholder="you@example.com"
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
                    typed.current = true;
                    setPassword(v);
                    if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
                  }}
                  error={errors.password}
                  placeholder="••••••••"
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />

                <Pressable
                  onPress={() => setRemember(!remember)}
                  style={styles.remember}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: remember }}
                  hitSlop={8}
                >
                  <View style={[styles.box, remember && styles.boxOn]}>
                    {remember && <Text style={styles.tick}>✓</Text>}
                  </View>
                  <Text style={styles.rememberText}>Remember my email</Text>
                </Pressable>

                {formError && (
                  <View style={styles.formError}>
                    <Text style={styles.formErrorText}>⚠ {formError}</Text>
                  </View>
                )}

                <Button title="Sign in" onPress={handleLogin} loading={loading} fullWidth />

                <Text style={styles.forgot}>Forgot your password? Ask your admin to reset it.</Text>
              </>
            )}
          </Animated.View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>New to the team?</Text>
            <Button title="Create an account" variant="ghost" onPress={() => router.push('/sign-up')} />
          </View>
          <Text style={styles.forgot} onPress={() => router.push('/delete-account' as Href)}>
            Delete an account
          </Text>
          <Text style={styles.forgot} onPress={() => router.push('/privacy' as Href)}>
            Privacy policy
          </Text>
          <SafeAreaView edges={['bottom']}>
            {!!VERSION && <Text style={styles.version}>Version {VERSION}</Text>}
          </SafeAreaView>
        </Animated.View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const HERO_BG = '#1D3FA8';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1 },
  hero: {
    backgroundColor: HERO_BG,
    paddingBottom: 72,
    borderBottomLeftRadius: 36,
    borderBottomRightRadius: 36,
    overflow: 'hidden',
  },
  heroInner: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  blob: { position: 'absolute', borderRadius: 999 },
  blobA: { width: 260, height: 260, top: -90, right: -70, backgroundColor: 'rgba(255,255,255,0.10)' },
  blobB: { width: 200, height: 200, bottom: -70, left: -60, backgroundColor: 'rgba(110,160,255,0.28)' },
  blobC: { width: 90, height: 90, top: 70, left: 30, backgroundColor: 'rgba(255,200,80,0.18)' },
  brand: { alignItems: 'center', gap: spacing.sm },
  logoRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  logo: { width: 70, height: 70, resizeMode: 'contain' },
  college: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 26,
  },
  productPill: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  product: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: '#FFFFFF', letterSpacing: 0.3 },
  cardWrap: { marginTop: -52, paddingHorizontal: spacing.lg, gap: spacing.md },
  card: {
    gap: spacing.lg,
    padding: spacing.xl,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    shadowColor: '#0B1A4A',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  cardHead: { gap: 2 },
  title: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.small, color: colors.textMuted },
  remember: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'flex-start', marginTop: -4 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { fontSize: 13, lineHeight: 15, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  rememberText: { fontSize: fontSize.small, color: colors.text },
  formError: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  formErrorText: { fontSize: fontSize.small, color: colors.danger },
  modes: { flexDirection: 'row', padding: 4, gap: 4, borderRadius: radius.pill, backgroundColor: colors.background },
  mode: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.pill, alignItems: 'center' },
  modeOn: { backgroundColor: colors.surface, elevation: 2, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 4 },
  modeText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  modeTextOn: { color: colors.primary },
  forgot: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center' },
  footer: { alignItems: 'center' },
  footerText: { fontSize: fontSize.small, color: colors.textMuted },
  version: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center', paddingBottom: spacing.md },
});
