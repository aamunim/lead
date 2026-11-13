import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OtpError, sendLoginCode, verifyLoginCode } from '@/features/auth/api';
import { bdMobile, toEnglishDigits } from '@/shared/lib/phone';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

import { canReadSmsCode, smsAppHash, stopSmsCode, waitForSmsCode } from '../../../modules/sms-code';

// =====================================================================
// 📱 Sign in with your mobile number and the 6-digit code from the SMS.
//   · The number must be on your profile (Phone). The SMS comes from the
//     SMS company's non-masking number.
//   · Android (app 2.8.6+): the phone reads the code by itself and signs
//     in. Before that, and on iPhone, the keyboard offers the code from
//     the SMS: one tap.
//   · Six digits typed → it signs in (no button needed).
// =====================================================================

const PHONE_KEY = 'login_phone';
const RESEND_AFTER = 30;

export function OtpLogin({ onFail }: { onFail: () => void }) {
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [code, setCode] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [reading, setReading] = useState(false);

  const codeRef = useRef<ComponentRef<typeof TextField>>(null);
  const focusCode = () => (codeRef.current as unknown as { focus?: () => void } | null)?.focus?.();
  const checking = useRef(false);
  const alive = useRef(true);
  // which send the SMS reader belongs to (a new send or leaving the page ends it)
  const round = useRef(0);

  // the number from last time
  useEffect(() => {
    AsyncStorage.getItem(PHONE_KEY)
      .then((saved) => {
        if (saved) setPhone((now) => now || saved);
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
      round.current += 1;
      stopSmsCode();
    };
  }, []);

  // "Send again" in 30 seconds
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const check = async (value: string) => {
    if (checking.current || value.length !== 6) return;
    checking.current = true;
    setBusy(true);
    setError(null);
    try {
      await verifyLoginCode(phone, value);
      round.current += 1;
      stopSmsCode();
      // signed in: the app moves on by itself
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : 'Could not sign in. Please try again.');
      setCode('');
      onFail();
      focusCode();
    } finally {
      checking.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const send = async () => {
    const mobile = bdMobile(phone);
    if (!mobile) {
      setError('Write your mobile number, like 01711-000000.');
      onFail();
      return;
    }
    setBusy(true);
    setError(null);

    // start listening before the SMS is sent (Android reads only after this)
    const mine = ++round.current;
    stopSmsCode();
    if (canReadSmsCode) {
      setReading(true);
      waitForSmsCode().then((found) => {
        if (round.current !== mine || !alive.current) return;
        setReading(false);
        if (found) {
          setCode(found);
          check(found);
        }
      });
    }

    try {
      const h = await sendLoginCode(phone, smsAppHash());
      if (!alive.current) return;
      AsyncStorage.setItem(PHONE_KEY, phone.trim()).catch(() => undefined);
      setHint(h);
      setCode('');
      setStep('code');
      setWait(RESEND_AFTER);
      setTimeout(() => focusCode(), 300);
    } catch (e) {
      if (!alive.current) return;
      round.current += 1;
      stopSmsCode();
      setReading(false);
      setError(e instanceof Error ? e.message : 'Could not send the code. Please try again.');
      if (e instanceof OtpError && e.wait) setWait(e.wait);
      onFail();
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const changeNumber = () => {
    round.current += 1;
    stopSmsCode();
    setReading(false);
    setStep('phone');
    setCode('');
    setError(null);
  };

  return (
    <View style={styles.box}>
      {step === 'phone' ? (
        <>
          <TextField
            label="Mobile number"
            value={phone}
            onChangeText={(v) => {
              setPhone(v);
              if (error) setError(null);
            }}
            placeholder="01711-000000"
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            maxLength={20}
            returnKeyType="done"
            onSubmitEditing={send}
          />
          <Text style={styles.note}>The number on your profile. A 6-digit code comes by SMS.</Text>
          {error && <ErrorBox text={error} />}
          <Button
            title={wait > 0 ? `Send the code (${wait}s)` : 'Send the code'}
            onPress={send}
            loading={busy}
            disabled={wait > 0}
            fullWidth
          />
        </>
      ) : (
        <>
          <Text style={styles.sent}>
            We sent a code to <Text style={styles.bold}>{hint}</Text>.
          </Text>
          <TextField
            ref={codeRef}
            label="Code from the SMS"
            value={code}
            onChangeText={(v) => {
              const digits = toEnglishDigits(v).replace(/\D/g, '').slice(0, 6);
              setCode(digits);
              if (error) setError(null);
              if (digits.length === 6) check(digits);
            }}
            placeholder="••••••"
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            maxLength={6}
            style={styles.code}
          />
          {reading && !busy && <Text style={styles.note}>📲 Waiting for the SMS — the code fills in by itself.</Text>}
          {error && <ErrorBox text={error} />}
          <Button title="Sign in" onPress={() => check(code)} loading={busy} disabled={code.length !== 6} fullWidth />
          <View style={styles.row}>
            <Pressable onPress={changeNumber} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>Change number</Text>
            </Pressable>
            <Pressable onPress={send} disabled={wait > 0 || busy} hitSlop={8} accessibilityRole="button">
              <Text style={[styles.link, (wait > 0 || busy) && styles.linkOff]}>
                {wait > 0 ? `Send again in ${wait}s` : 'Send again'}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <View style={styles.error}>
      <Text style={styles.errorText}>⚠ {text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.lg },
  note: { fontSize: fontSize.small, color: colors.textMuted, marginTop: -spacing.sm },
  sent: { fontSize: fontSize.body, color: colors.text },
  bold: { fontWeight: fontWeight.bold },
  code: { fontSize: 24, letterSpacing: 8, fontWeight: fontWeight.bold },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  linkOff: { color: colors.textMuted },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
