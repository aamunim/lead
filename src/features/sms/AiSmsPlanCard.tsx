import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { s as ui } from '@/features/alumni/ui';
import { card, MIcon, md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

import { aiSegmentIds, aiSmsPlan, GROUP_LABEL, smsLength, type SmsSuggestion } from './api';

// =====================================================================
// 🤖 AI suggestions: a banner that opens into "ask the AI" — it picks
//   groups of your leads (next call today, fee due, visit tomorrow,
//   quiet 2 weeks…) and writes each SMS. "Use" puts those leads and the
//   SMS into SMS Center, ready to check and send.
// =====================================================================

const QUESTIONS = [
  'আজকে কোন কোন লিডকে কী SMS দেওয়া যায়?',
  'ভর্তি বাড়াতে আজ কাদের SMS দেওয়া উচিত?',
  'ভর্তি হওয়া ছাত্রদের আজ কী জানানো দরকার?',
];

export function AiSmsPlanCard({ onUse }: { onUse: (s: SmsSuggestion) => void }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(QUESTIONS[0]);
  const [lang, setLang] = useState<'bn' | 'en'>('bn');
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<{ suggestions: SmsSuggestion[]; others: SmsSuggestion[]; note?: string } | null>(null);
  const [used, setUsed] = useState<string | null>(null);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await aiSmsPlan({ question, language: lang, skipDays: skip ? 3 : 0 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not answer.');
    } finally {
      setBusy(false);
    }
  };
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  // the group's leads are fetched now (the AI answer has only counts)
  const use = async (s: SmsSuggestion) => {
    if (loadingKey) return;
    setLoadingKey(s.key);
    setError(null);
    try {
      const ids = s.lead_ids?.length ? s.lead_ids : await aiSegmentIds(s.key, skip ? 3 : 0);
      if (ids.length === 0) return setError('Nobody is left in this group now.');
      setUsed(s.key);
      onUse({ ...s, lead_ids: ids, count: ids.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this group.');
    } finally {
      setLoadingKey(null);
    }
  };

  if (!open) {
    return (
      <Tap onPress={() => setOpen(true)} style={styles.banner} label="AI suggestions">
        <View style={styles.bannerIcon}>
          <MIcon name="auto-awesome" size={22} color={md.onPurpleC} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.bannerTitle}>What should we SMS today?</Text>
          <Text style={styles.bannerSub}>AI picks the leads and writes the SMS</Text>
        </View>
        <MIcon name="chevron-right" size={24} color={md.onPurpleC} />
      </Tap>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.bannerIcon}>
          <MIcon name="auto-awesome" size={20} color={md.onPurpleC} />
        </View>
        <Text style={[styles.title, styles.flex]}>AI suggestions</Text>
        <Tap onPress={() => setOpen(false)} borderless label="Close">
          <MIcon name="expand-less" size={24} color={colors.textMuted} />
        </Tap>
      </View>

      <View style={styles.askBox}>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          multiline
          maxLength={400}
          placeholderTextColor={colors.textMuted}
          style={styles.askInput}
        />
        <Pressable
          onPress={ask}
          disabled={busy || !question.trim()}
          style={[styles.askBtn, (busy || !question.trim()) && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Ask AI"
        >
          {busy ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <MIcon name="arrow-upward" size={22} color="#fff" />
          )}
        </Pressable>
      </View>
      <View style={styles.row}>
        {QUESTIONS.filter((q) => q !== question).map((q) => (
          <Pressable key={q} onPress={() => setQuestion(q)} style={styles.suggestQ}>
            <Text style={styles.suggestQText} numberOfLines={1}>
              {q}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.row}>
        <Toggle text="বাংলা" on={lang === 'bn'} onPress={() => setLang('bn')} />
        <Toggle text="English" on={lang === 'en'} onPress={() => setLang('en')} />
        <Toggle text="Skip SMS'd in 3 days" on={skip} onPress={() => setSkip(!skip)} />
      </View>
      <Text style={styles.privacy}>🔒 The AI sees only group names and counts — no names, no numbers.</Text>
      {error && <Text style={ui.error}>{error}</Text>}
      {busy && !res && <Text style={ui.muted}>Looking at your leads…</Text>}

      {res?.note && <Text style={ui.muted}>{res.note}</Text>}
      {res?.suggestions.map((s, i) => {
        const l = smsLength(s.message ?? '');
        const isUsed = used === s.key;
        return (
          <View key={s.key} style={[styles.sug, isUsed && styles.sugUsed]}>
            <View style={styles.sugHead}>
              <View style={styles.rank}>
                <Text style={styles.rankText}>{i + 1}</Text>
              </View>
              <View style={styles.flex}>
                <Text style={styles.sugTitle}>{s.title}</Text>
                <Text style={ui.muted}>
                  {s.count} {GROUP_LABEL[s.group]} · {l.parts} SMS each
                </Text>
              </View>
            </View>
            {!!s.why && <Text style={styles.why}>{s.why}</Text>}
            <View style={styles.bubble}>
              <Text style={styles.bubbleText}>{s.message}</Text>
            </View>
            <Pressable
              onPress={() => use(s)}
              disabled={!!loadingKey}
              style={[styles.useBtn, isUsed && styles.useBtnDone]}
              accessibilityRole="button"
            >
              {loadingKey === s.key ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MIcon name={isUsed ? 'check' : 'arrow-downward'} size={18} color={isUsed ? md.onOkC : '#fff'} />
              )}
              <Text style={[styles.useText, isUsed && styles.useTextDone]}>
                {isUsed ? 'In use below' : `Use for ${s.count} leads`}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {res && res.others.length > 0 && (
        <>
          <Text style={styles.othersLabel}>Other groups — write your own SMS</Text>
          <View style={styles.row}>
            {res.others.map((o) => (
              <Pressable key={o.key} onPress={() => use(o)} style={styles.other}>
                <Text style={styles.otherText} numberOfLines={1}>
                  {o.title}
                </Text>
                <Text style={styles.otherCount}>{o.count}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function Toggle({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && styles.toggleOn]} accessibilityState={{ selected: on }}>
      {on && <MIcon name="check" size={14} color={md.onPurpleC} />}
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: 20,
    backgroundColor: md.purpleC,
    overflow: 'hidden',
  },
  bannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  bannerTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: md.onPurpleC },
  bannerSub: { fontSize: fontSize.small, color: md.onPurpleC, opacity: 0.8 },
  card: { ...card, padding: spacing.lg, gap: spacing.md, overflow: 'visible', borderWidth: 1, borderColor: md.purpleC },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  askBox: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.sm,
    paddingLeft: spacing.md,
    borderRadius: 22,
    backgroundColor: md.surface1,
  },
  askInput: { flex: 1, minHeight: 40, maxHeight: 120, fontSize: fontSize.body, color: colors.text, paddingVertical: 8 },
  askBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.onPurpleC,
  },
  off: { opacity: 0.4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  suggestQ: {
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: md.outline,
  },
  suggestQText: { fontSize: fontSize.small, color: colors.text },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: md.surface1,
  },
  toggleOn: { backgroundColor: md.purpleC },
  toggleText: { fontSize: fontSize.small, color: colors.textMuted },
  toggleTextOn: { color: md.onPurpleC, fontWeight: fontWeight.semibold },
  privacy: { fontSize: fontSize.caption, color: colors.textMuted },
  sug: { gap: spacing.sm, padding: spacing.md, borderRadius: 16, backgroundColor: md.surface1 },
  sugUsed: { backgroundColor: md.okC },
  sugHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rank: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.purpleC,
  },
  rankText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: md.onPurpleC },
  sugTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  why: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  bubble: {
    alignSelf: 'flex-start',
    maxWidth: '96%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
    borderTopLeftRadius: 4,
    backgroundColor: colors.surface,
  },
  bubbleText: { fontSize: fontSize.body, color: colors.text, lineHeight: 22 },
  useBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
  },
  useBtnDone: { backgroundColor: colors.surface },
  useText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: '#fff' },
  useTextDone: { color: md.onOkC },
  othersLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  other: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: md.outline,
  },
  otherText: { flexShrink: 1, fontSize: fontSize.small, color: colors.text },
  otherCount: {
    minWidth: 24,
    textAlign: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: md.onPrimaryC,
    backgroundColor: md.primaryC,
  },
});
