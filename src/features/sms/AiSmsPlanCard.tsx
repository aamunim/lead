import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, s as ui } from '@/features/alumni/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import { aiSmsPlan, GROUP_LABEL, smsLength, type SmsSuggestion } from './api';

// =====================================================================
// 🤖 AI suggestions: ask "which leads should get which SMS today?" —
//   the AI picks groups of your leads (next call today, fee due, visit
//   tomorrow, quiet 2 weeks…) and writes the SMS for each. "Use this"
//   puts those leads and the SMS in SMS Center, ready to check and send.
// =====================================================================

const QUESTIONS = [
  'আজকে কোন কোন লিডকে কী SMS দেওয়া যায়?',
  'ভর্তি বাড়াতে আজ কাদের SMS দেওয়া উচিত?',
  'ভর্তি হওয়া ছাত্রদের আজ কী জানানো দরকার?',
];

export function AiSmsPlanCard({ onUse }: { onUse: (s: SmsSuggestion) => void }) {
  const [question, setQuestion] = useState(QUESTIONS[0]);
  const [lang, setLang] = useState<'bn' | 'en'>('bn');
  const [skip, setSkip] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<{ suggestions: SmsSuggestion[]; others: SmsSuggestion[]; note?: string } | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await aiSmsPlan({ question, language: lang, skipDays: skip }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[ui.card, styles.card]}>
      <Text style={styles.title}>🤖 AI suggestions</Text>
      <Text style={ui.muted}>Ask, and the AI picks which of your leads should get which SMS today.</Text>
      <TextInput
        value={question}
        onChangeText={setQuestion}
        multiline
        maxLength={400}
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      <View style={ui.chips}>
        {QUESTIONS.slice(1).map((q) => (
          <Chip key={q} text={q} on={question === q} onPress={() => setQuestion(q)} />
        ))}
      </View>
      <View style={ui.chips}>
        <Chip text="SMS in বাংলা" on={lang === 'bn'} onPress={() => setLang('bn')} />
        <Chip text="English" on={lang === 'en'} onPress={() => setLang('en')} />
        <Chip text="Skip who got SMS in 3 days" on={skip === 3} onPress={() => setSkip(skip === 3 ? 0 : 3)} />
      </View>
      <Text style={ui.muted}>The AI sees only group names and counts — never names or numbers.</Text>
      {error && <Text style={ui.error}>{error}</Text>}
      <Button title={res ? '↻ Ask again' : '✨ Ask AI'} onPress={ask} loading={busy} disabled={!question.trim()} />
      {busy && <ActivityIndicator color={colors.primary} />}

      {res?.note && <Text style={ui.muted}>{res.note}</Text>}
      {res?.suggestions.map((s, i) => {
        const l = smsLength(s.message ?? '');
        return (
          <View key={s.key} style={styles.sug}>
            <Text style={styles.sugTitle}>
              {i + 1}. {s.title}
            </Text>
            <Text style={ui.muted}>
              👥 {s.count} {GROUP_LABEL[s.group]} {s.count === 1 ? 'lead' : 'leads'}
              {s.skipped_recent_sms ? ` · ${s.skipped_recent_sms} left out (got SMS lately)` : ''}
            </Text>
            {!!s.why && <Text style={styles.why}>💡 {s.why}</Text>}
            <View style={styles.msg}>
              <Text style={styles.text}>{s.message}</Text>
              <Text style={ui.muted}>
                {l.chars} letters · {l.parts} SMS each
              </Text>
            </View>
            <Button title={`Use this → ${s.count} leads`} onPress={() => onUse(s)} />
          </View>
        );
      })}
      {res && res.others.length > 0 && (
        <>
          <Text style={ui.label}>OTHER GROUPS (WRITE YOUR OWN SMS)</Text>
          <View style={ui.chips}>
            {res.others.map((o) => (
              <Chip key={o.key} text={`${o.title} · ${o.count}`} on={false} onPress={() => onUse(o)} />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.primary },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.body, color: colors.text },
  input: {
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
    backgroundColor: colors.surface,
    textAlignVertical: 'top',
  },
  sug: { gap: spacing.xs, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  sugTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  why: { fontSize: fontSize.small, color: colors.text },
  msg: { gap: 2, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
});
