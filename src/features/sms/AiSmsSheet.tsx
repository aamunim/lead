import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import { aiSmsDrafts, smsLength, type SmsGroup } from './api';

// =====================================================================
// 🤖 Ask the AI for an SMS: what it is for, tone, language, length →
//   three drafts; tap one to use it (and change it as you like)
// =====================================================================

const GOALS: Record<SmsGroup | 'alumni', string[]> = {
  active: [
    'ভর্তির শেষ তারিখ মনে করিয়ে দেওয়া',
    'ক্যাম্পাসে আসার আমন্ত্রণ',
    'নতুন ব্যাচ শুরুর খবর',
    'অনেকদিন কথা হয়নি — খোঁজ নেওয়া',
  ],
  not_now: ['আবার আগ্রহী করা (নতুন সেশন)', 'নতুন সুযোগ জানানো', 'শুভেচ্ছা ও খোঁজ নেওয়া'],
  admitted: ['ফি বাকি মনে করিয়ে দেওয়া', 'ক্লাস / পরীক্ষার নোটিশ', 'কাগজপত্র জমা দেওয়ার কথা', 'ঈদ / উৎসবের শুভেচ্ছা'],
  alumni: ['পরিচিত কাউকে ভর্তির জন্য রেফার করতে বলা', 'শুভেচ্ছা ও খোঁজ নেওয়া', 'অনুষ্ঠানের দাওয়াত'],
};
const TONES = [
  { key: 'friendly', label: 'Friendly' },
  { key: 'formal', label: 'Formal' },
  { key: 'urgent', label: 'Urgent' },
];

export function AiSmsSheet({
  group,
  count,
  filter,
  current,
  onPick,
  onClose,
}: {
  group: SmsGroup | 'alumni';
  count?: number;
  filter?: string;
  /** what is written now (to make it better) */
  current?: string;
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState('');
  const [hint, setHint] = useState('');
  const [tone, setTone] = useState('friendly');
  const [lang, setLang] = useState<'bn' | 'en'>('bn');
  const [len, setLen] = useState(1);
  const [improve, setImprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<string[]>([]);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setOptions(
        await aiSmsDrafts({
          group,
          goal: goal.trim(),
          hint: hint.trim() || undefined,
          tone,
          language: lang,
          length: len,
          current: improve ? current : undefined,
          audience: { count, filter },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="🤖 SMS with AI" onClose={onClose}>
      <Text style={ui.label}>WHAT IS IT FOR?</Text>
      <View style={ui.chips}>
        {GOALS[group].map((g) => (
          <Chip key={g} text={g} on={goal === g} onPress={() => setGoal(goal === g ? '' : g)} />
        ))}
      </View>
      <TextInput
        value={goal}
        onChangeText={setGoal}
        placeholder="Or write it, e.g. ভর্তির শেষ তারিখ ৩০ নভেম্বর"
        placeholderTextColor={colors.textMuted}
        maxLength={300}
        style={styles.input}
      />
      <TextInput
        value={hint}
        onChangeText={setHint}
        placeholder="Anything it must say (date, amount, phone)? (optional)"
        placeholderTextColor={colors.textMuted}
        maxLength={400}
        multiline
        style={[styles.input, styles.multi]}
      />
      {!!current?.trim() && (
        <View style={ui.chips}>
          <Chip text="✏️ Make my message better" on={improve} onPress={() => setImprove(!improve)} />
        </View>
      )}

      <Text style={ui.label}>TONE · LANGUAGE · LENGTH</Text>
      <View style={ui.chips}>
        {TONES.map((t) => (
          <Chip key={t.key} text={t.label} on={tone === t.key} onPress={() => setTone(t.key)} />
        ))}
      </View>
      <View style={ui.chips}>
        <Chip text="বাংলা" on={lang === 'bn'} onPress={() => setLang('bn')} />
        <Chip text="English" on={lang === 'en'} onPress={() => setLang('en')} />
        <Chip text="1 SMS" on={len === 1} onPress={() => setLen(1)} />
        <Chip text="Up to 2 SMS" on={len === 2} onPress={() => setLen(2)} />
      </View>
      <Text style={ui.muted}>The AI sees only what this send is about, never names or numbers.</Text>

      {error && <Text style={ui.error}>{error}</Text>}
      <Button
        title={options.length ? '↻ Write 3 more' : '✨ Write 3 drafts'}
        onPress={ask}
        loading={busy}
        disabled={!goal.trim() && !(improve && current?.trim())}
      />
      {busy && <ActivityIndicator color={colors.primary} />}

      {options.map((o, i) => {
        const l = smsLength(o);
        return (
          <Pressable
            key={i}
            onPress={() => onPick(o)}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Use draft ${i + 1}`}
          >
            <Text style={styles.text}>{o}</Text>
            <View style={styles.optionFoot}>
              <Text style={ui.muted}>
                {l.chars} letters · {l.parts} SMS
              </Text>
              <Text style={styles.use}>Use this →</Text>
            </View>
          </Pressable>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
  },
  multi: { minHeight: 64, maxHeight: 160, textAlignVertical: 'top' },
  text: { fontSize: fontSize.body, color: colors.text },
  option: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  optionFoot: { flexDirection: 'row', justifyContent: 'space-between' },
  use: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  pressed: { opacity: 0.7 },
});
