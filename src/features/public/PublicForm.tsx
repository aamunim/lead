import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { COLLEGE } from '@/features/web/brand';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🔗 Public forms (no sign-in), on the website:
//   /refer/<code>  an alumnus's link: a friend → the Referral inbox
//   /apply         anyone interested → a new lead (?ref=<code> → referral)
//   One small request to open (courses + whose link), one to send.
//   Visitors are people interested in admission: the words are Bangla.
// =====================================================================

const LOGO = require('../../../assets/web/ittc-logo-192.png');

type Info = {
  refer_on: boolean;
  apply_on: boolean;
  referrer: string | null;
  courses: { id: string; name: string }[];
};

/** 01XXXXXXXXX (11 digits), +8801… or 8801… */
function phoneOk(p: string): boolean {
  const d = p.replace(/\D/g, '').replace(/^88/, '');
  return /^01[3-9]\d{8}$/.test(d);
}

function friendly(e: { message?: string; hint?: string } | null | undefined): string {
  if (!e) return 'পাঠানো যায়নি। আবার চেষ্টা করুন।';
  if (e.hint === 'again') return 'এই নম্বরটি আগেই পাঠানো হয়েছে। আমরা শীঘ্রই আপনাকে কল করব।';
  if (e.hint === 'busy') return 'এই মুহূর্তে অনেক ফর্ম আসছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।';
  const m = e.message ?? '';
  if (/network|fetch/i.test(m)) return 'ইন্টারনেট সংযোগ নেই। আবার চেষ্টা করুন।';
  if (/switched off|not valid/i.test(m)) return 'এই লিংকটি এখন চালু নেই।';
  if (/mobile number|phone/i.test(m)) return 'সঠিক মোবাইল নম্বর লিখুন।';
  if (/course/i.test(m)) return 'একটি কোর্স বেছে নিন।';
  if (/name/i.test(m)) return 'নাম লিখুন।';
  return 'পাঠানো যায়নি। আবার চেষ্টা করুন।';
}

export function PublicForm({ mode, code }: { mode: 'refer' | 'apply'; code?: string | null }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [courseId, setCourseId] = useState<string | null>(null);
  const [area, setArea] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // 🔗 An alumnus's link was opened: counted once per visit (the funnel: opened → referred → admitted)
  useEffect(() => {
    if (!code) return;
    const key = `refer-open:${code.toUpperCase()}`;
    try {
      if (typeof sessionStorage !== 'undefined') {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
      }
    } catch {
      // no storage (private window): still counted
    }
    supabase.rpc('public_refer_open' as never, { p_code: code } as never).then(
      () => undefined,
      () => undefined,
    );
  }, [code]);

  useEffect(() => {
    supabase.rpc('public_form_info' as never, { p_code: code ?? null } as never).then(({ data, error: e }) => {
      if (e || !data) setLoadError(true);
      else {
        const d = data as unknown as Info;
        setInfo(d);
        if (d.courses.length === 1) setCourseId(d.courses[0].id);
      }
    });
  }, [code]);

  const asReferral = !!code && !!info?.referrer;
  const off = info ? (asReferral ? !info.refer_on : mode === 'refer' ? true : !info.apply_on) : false;
  const badLink = mode === 'refer' && !!info && !info.referrer;

  const send = async () => {
    setError(null);
    if (!name.trim()) return setError('নাম লিখুন।');
    if (!phoneOk(phone)) return setError('সঠিক মোবাইল নম্বর লিখুন (যেমন 017XXXXXXXX)।');
    if (!asReferral && (info?.courses.length ?? 0) > 0 && !courseId) return setError('একটি কোর্স বেছে নিন।');
    setSending(true);
    const args = {
      p_name: name.trim(),
      p_phone: phone.trim(),
      p_course_id: courseId,
      p_area: area.trim() || null,
      p_note: note.trim() || null,
    };
    const { error: e } = asReferral
      ? await supabase.rpc('public_refer' as never, { p_code: code, ...args } as never)
      : await supabase.rpc('public_apply' as never, { ...args, p_ref: code ?? null } as never);
    setSending(false);
    if (e) return setError(friendly(e));
    setDone(true);
  };

  const title = asReferral ? 'বন্ধুর পরামর্শে ভর্তি তথ্য' : 'ভর্তি সংক্রান্ত তথ্য জানতে চাই';

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: COLLEGE, headerShown: false }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <Image source={LOGO} style={styles.logo} accessibilityIgnoresInvertColors />
          <Text style={styles.college}>{COLLEGE}</Text>
        </View>

        <View style={styles.card}>
          {!info && !loadError ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : loadError ? (
            <Text style={styles.muted}>পেজটি খোলা যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।</Text>
          ) : badLink || off ? (
            <>
              <Text style={styles.title}>এই লিংকটি এখন চালু নেই</Text>
              <Text style={styles.muted}>ভর্তি সংক্রান্ত তথ্যের জন্য কলেজে যোগাযোগ করুন।</Text>
            </>
          ) : done ? (
            <View style={styles.done}>
              <Text style={styles.doneIcon}>✅</Text>
              <Text style={styles.title}>ধন্যবাদ!</Text>
              <Text style={styles.text}>আপনার তথ্য আমরা পেয়েছি। শীঘ্রই আমাদের একজন প্রতিনিধি আপনাকে কল করবেন।</Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>{title}</Text>
              {asReferral && (
                <View style={styles.refBadge}>
                  <Text style={styles.refText}>🎓 {info!.referrer} আপনার কথা জানিয়েছেন</Text>
                </View>
              )}
              <Text style={styles.muted}>নিচের তথ্যগুলো দিন, আমরা আপনাকে কল করব।</Text>

              <Field label="নাম *" value={name} onChange={setName} placeholder="আপনার নাম" autoComplete="name" />
              <Field
                label="মোবাইল নম্বর *"
                value={phone}
                onChange={setPhone}
                placeholder="017XXXXXXXX"
                keyboardType="phone-pad"
                autoComplete="tel"
              />

              {(info?.courses.length ?? 0) > 0 && (
                <View style={styles.field}>
                  <Text style={styles.label}>কোন কোর্সে আগ্রহী{asReferral ? '' : ' *'}</Text>
                  <View style={styles.chips}>
                    {info!.courses.map((c) => {
                      const on = courseId === c.id;
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => setCourseId(on ? null : c.id)}
                          style={[styles.chip, on && styles.chipOn]}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: on }}
                        >
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.name}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              )}

              <Field label="এলাকা" value={area} onChange={setArea} placeholder="যেমন: মিরপুর, ঢাকা" />
              <Field
                label="কিছু জানাতে চাইলে"
                value={note}
                onChange={setNote}
                placeholder="প্রশ্ন বা মন্তব্য"
                multiline
              />

              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable
                onPress={send}
                disabled={sending}
                style={({ pressed }) => [styles.submit, (pressed || sending) && styles.submitPressed]}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator color={colors.textOnPrimary} />
                ) : (
                  <Text style={styles.submitText}>পাঠান</Text>
                )}
              </Pressable>
              <Text style={styles.small}>আপনার নম্বর শুধু ভর্তি সংক্রান্ত যোগাযোগের জন্য ব্যবহার হবে।</Text>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// =====================================================================
// ✍️ /update/<token>: an alumnus updates their own details (the office approves)
// =====================================================================
type UpdateInfo = {
  first_name: string;
  phone_hint: string | null;
  whatsapp_hint: string | null;
  email: string | null;
  workplace: string | null;
  designation: string | null;
  district: string | null;
  upazila: string | null;
  address: string | null;
  institute: string | null;
  pending: boolean;
};

const UPDATE_FIELDS: { key: keyof UpdateInfo; label: string; placeholder: string; kind?: 'phone' | 'email' }[] = [
  { key: 'workplace', label: 'কর্মস্থল (স্কুল / প্রতিষ্ঠান)', placeholder: 'যেমন: মিরপুর আইডিয়াল স্কুল' },
  { key: 'designation', label: 'পদবি', placeholder: 'যেমন: সহকারী শিক্ষক' },
  { key: 'district', label: 'জেলা', placeholder: 'যেমন: ঢাকা' },
  { key: 'upazila', label: 'উপজেলা / থানা', placeholder: '' },
  { key: 'address', label: 'ঠিকানা', placeholder: '' },
  { key: 'email', label: 'ইমেইল', placeholder: 'you@example.com', kind: 'email' },
];

export function PublicUpdateForm({ token }: { token: string | null }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError(true);
      return;
    }
    supabase.rpc('public_alumni_update_info' as never, { p_token: token } as never).then(({ data, error: e }) => {
      if (e) return setLoadError(true);
      const d = data as unknown as UpdateInfo | null;
      if (!d) return setLoadError(true);
      setInfo(d);
      const v: Record<string, string> = {};
      for (const f of UPDATE_FIELDS) v[f.key] = (d[f.key] as string | null) ?? '';
      setValues(v);
    });
  }, [token]);

  const send = async () => {
    if (!info) return;
    setError(null);
    if (phone.trim() && !phoneOk(phone)) return setError('সঠিক মোবাইল নম্বর লিখুন (যেমন 017XXXXXXXX)।');
    if (whatsapp.trim() && !phoneOk(whatsapp)) return setError('সঠিক হোয়াটসঅ্যাপ নম্বর লিখুন।');
    const data: Record<string, string> = {};
    for (const f of UPDATE_FIELDS) {
      const now = (values[f.key] ?? '').trim();
      if (now && now !== ((info[f.key] as string | null) ?? '')) data[f.key] = now;
    }
    if (phone.trim()) data.phone = phone.trim();
    if (whatsapp.trim()) data.whatsapp_number = whatsapp.trim();
    if (Object.keys(data).length === 0) return setError('কোনো পরিবর্তন করা হয়নি।');
    setSending(true);
    const { error: e } = await supabase.rpc(
      'public_alumni_update_submit' as never,
      { p_token: token, p_data: data } as never,
    );
    setSending(false);
    if (e) {
      if (e.hint === 'again') return setError('কিছুক্ষণ আগেই পাঠানো হয়েছে। এক ঘণ্টা পরে আবার চেষ্টা করুন।');
      return setError(friendly(e));
    }
    setDone(true);
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: COLLEGE, headerShown: false }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <Image source={LOGO} style={styles.logo} accessibilityIgnoresInvertColors />
          <Text style={styles.college}>{COLLEGE}</Text>
        </View>
        <View style={styles.card}>
          {!info && !loadError ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : loadError || !info ? (
            <>
              <Text style={styles.title}>এই লিংকটি এখন চালু নেই</Text>
              <Text style={styles.muted}>নতুন লিংকের জন্য কলেজে যোগাযোগ করুন।</Text>
            </>
          ) : done ? (
            <View style={styles.done}>
              <Text style={styles.doneIcon}>✅</Text>
              <Text style={styles.title}>ধন্যবাদ!</Text>
              <Text style={styles.text}>আপনার তথ্য আমরা পেয়েছি। যাচাই করে আপডেট করা হবে।</Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>আসসালামু আলাইকুম, {info.first_name}!</Text>
              <Text style={styles.muted}>আপনার তথ্য হালনাগাদ করুন। যা বদলেছে শুধু সেটাই লিখুন।</Text>
              {info.pending && (
                <View style={styles.refBadge}>
                  <Text style={styles.refText}>আগের পাঠানো তথ্য যাচাইয়ের অপেক্ষায় আছে</Text>
                </View>
              )}
              <Field
                label={`নতুন মোবাইল নম্বর${info.phone_hint ? ` (এখন ${info.phone_hint})` : ''}`}
                value={phone}
                onChange={setPhone}
                placeholder="বদলে থাকলে লিখুন"
                keyboardType="phone-pad"
                autoComplete="tel"
              />
              <Field
                label={`হোয়াটসঅ্যাপ নম্বর${info.whatsapp_hint ? ` (এখন ${info.whatsapp_hint})` : ''}`}
                value={whatsapp}
                onChange={setWhatsapp}
                placeholder="বদলে থাকলে লিখুন"
                keyboardType="phone-pad"
              />
              {UPDATE_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  value={values[f.key] ?? ''}
                  onChange={(v) => setValues((o) => ({ ...o, [f.key]: v }))}
                  placeholder={f.placeholder}
                  keyboardType={f.kind === 'email' ? 'email-address' : undefined}
                  autoComplete={f.kind === 'email' ? 'email' : undefined}
                  multiline={f.key === 'address'}
                />
              ))}
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable
                onPress={send}
                disabled={sending}
                style={({ pressed }) => [styles.submit, (pressed || sending) && styles.submitPressed]}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator color={colors.textOnPrimary} />
                ) : (
                  <Text style={styles.submitText}>পাঠান</Text>
                )}
              </Pressable>
              <Text style={styles.small}>এই লিংকটি শুধু আপনার জন্য। অন্য কাউকে দেবেন না।</Text>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  keyboardType,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: 'phone-pad' | 'email-address';
  autoComplete?: 'name' | 'tel' | 'email';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, multiline && styles.inputMulti]}
        multiline={multiline}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        maxLength={multiline ? 1000 : 120}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, width: '100%', maxWidth: 520, alignSelf: 'center' },
  brand: { alignItems: 'center', gap: spacing.sm, marginVertical: spacing.lg },
  logo: { width: 72, height: 72, borderRadius: 36 },
  college: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  loader: { marginVertical: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.body, color: colors.text, textAlign: 'center', lineHeight: 24 },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center' },
  refBadge: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  refText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  field: { gap: 6 },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  inputMulti: { minHeight: 88, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { fontSize: fontSize.small, color: colors.text },
  chipTextOn: { color: colors.primary, fontWeight: fontWeight.bold },
  error: { fontSize: fontSize.small, color: colors.danger },
  submit: {
    marginTop: spacing.sm,
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  submitPressed: { opacity: 0.85 },
  submitText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  done: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  doneIcon: { fontSize: 48 },
});
