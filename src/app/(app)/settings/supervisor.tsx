import { router, Stack, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { md } from '@/features/home/md';
import {
  checkNow,
  getSupervisorSettings,
  RULES,
  saveSupervisorSettings,
  type RuleKey,
  type SupervisorSettings,
} from '@/features/supervisor/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Supervisor: on/off, working hours and days, the morning
//   brief and the evening summary, and each rule with its numbers.
// =====================================================================

function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

const DAYS = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
const WHO: Record<'own' | 'managers' | 'admins', string> = {
  own: 'নিজে + Team Lead + admin',
  managers: 'শুধু Team Lead + admin',
  admins: 'admin (+ Team Lead নিজের টিমের)',
};

export default function SupervisorSettingsScreen() {
  const { hasPermission } = useAuth();
  const [s, setS] = useState<SupervisorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupervisorSettings()
      .then(setS)
      .catch((e) => setError(e instanceof Error ? e.message : 'লোড করা যায়নি।'));
  }, []);

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Supervisor' }} />
        <Text style={ui.muted}>শুধু admin এটা বদলাতে পারেন।</Text>
      </View>
    );
  }
  if (!s) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Supervisor' }} />
        {error ? <Text style={ui.error}>{error}</Text> : <ActivityIndicator color={colors.primary} />}
      </View>
    );
  }

  const set = (next: Partial<SupervisorSettings>) => {
    setS({ ...s, ...next });
    setDirty(true);
  };
  const setRule = (key: RuleKey, patch: Record<string, number | boolean>) =>
    set({ rules: { ...s.rules, [key]: { ...s.rules[key], ...patch } } });

  const save = async () => {
    if (s.end_hour <= s.start_hour) return setError('কাজ শেষের সময় শুরুর পরে হতে হবে।');
    setSaving(true);
    setError(null);
    try {
      await saveSupervisorSettings(s);
      setDirty(false);
      say('Saved', 'পরের ১৫ মিনিটের মধ্যে নতুন নিয়মে দেখা হবে।');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save করা যায়নি।');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setChecking(true);
    try {
      const r = await checkNow();
      say('দেখা হয়েছে', `${r.open}টা খোলা · ${r.new}টা নতুন · ${r.fixed}টা বন্ধ হয়েছে (মিটে গেছে বা মেয়াদ শেষ)`);
    } catch (e) {
      say('করা যায়নি', e instanceof Error ? e.message : 'আবার চেষ্টা করুন।');
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Supervisor' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Row
            title="🧑‍💼 সুপারভাইজার চালু"
            text="প্রতি ১৫ মিনিটে টিমের কাজ দেখে কী নজর দরকার তা জানায়। কিছু বদলায় না, শুধু পরামর্শ দেয়।"
            value={s.enabled}
            onChange={(v) => set({ enabled: v })}
          />
        </View>

        <Text style={ui.label}>কাজের সময় (ঢাকা)</Text>
        <View style={styles.card}>
          <View style={styles.hours}>
            <Num label="শুরু" value={s.start_hour} min={0} max={22} onChange={(v) => set({ start_hour: v })} />
            <Num label="শেষ" value={s.end_hour} min={1} max={23} onChange={(v) => set({ end_hour: v })} />
            <Text style={[ui.muted, styles.flex]}>(২৪ ঘণ্টা, যেমন ৯ থেকে ২১)</Text>
          </View>
          <Text style={ui.muted}>ছুটির দিন (এদিন ব্রিফ, সারাংশ বা “আজ কল নেই” যাবে না)</Text>
          <View style={ui.chips}>
            {DAYS.map((d, i) => (
              <Chip
                key={d}
                text={d}
                on={s.off_days.includes(i)}
                onPress={() =>
                  set({ off_days: s.off_days.includes(i) ? s.off_days.filter((x) => x !== i) : [...s.off_days, i] })
                }
              />
            ))}
          </View>
        </View>

        <Text style={ui.label}>যা পাঠানো হবে</Text>
        <View style={styles.card}>
          <Row
            title="🌅 সকালের ব্রিফ"
            text="কাজ শুরুর সময় প্রত্যেককে: আজ কত follow-up, নতুন lead, আর আগে কাকে কল করবেন"
            value={s.brief}
            onChange={(v) => set({ brief: v })}
          />
          <Row
            title="🌙 রাতের সারাংশ"
            text="কাজ শেষের সময়: কল, ভর্তি, কার কতটা follow-up মিস, কে আজ কল করেননি"
            value={s.day_end}
            onChange={(v) => set({ day_end: v })}
          />
          {s.day_end && (
            <>
              <Row
                title="Team Lead পাবেন (নিজের টিমের)"
                value={s.day_end_team_lead}
                onChange={(v) => set({ day_end_team_lead: v })}
              />
              <Row
                title="Admin ও Super Admin পাবেন (সবার)"
                value={s.day_end_admins}
                onChange={(v) => set({ day_end_admins: v })}
              />
            </>
          )}
          <Text style={ui.muted}>
            নতুন lead-এ কল না হলে caller → Team Lead → admin সতর্কতা আগে থেকেই যায় (Settings → Notifications)।
          </Text>
        </View>

        <Text style={ui.label}>🤖 AI (Settings → AI-এর AI ও budget)</Text>
        <View style={styles.card}>
          <Row
            title="AI চালু"
            text="Note পড়ে প্রতিশ্রুতি, আপত্তি, আগ্রহ ধরা; দিনের ও সপ্তাহের রিপোর্ট; পরামর্শ; প্রশ্নোত্তর। কিছু বদলায় না।"
            value={s.ai.enabled}
            onChange={(v) => set({ ai: { ...s.ai, enabled: v } })}
          />
          {s.ai.enabled && (
            <>
              <View style={styles.hours}>
                <Num
                  label="টা note দিনে (সর্বোচ্চ)"
                  value={s.ai.notes_daily}
                  min={0}
                  max={2000}
                  onChange={(v) => set({ ai: { ...s.ai, notes_daily: v } })}
                />
              </View>
              <Text style={ui.muted}>একবারে ২০টা note পড়ে, তাই খরচ কম। ০ দিলে note পড়া বন্ধ।</Text>
              <Row
                title="📊 দিনের রিপোর্ট (আর সপ্তাহের)"
                text="কাজ শেষের পর admin (সবার) ও Team Lead (নিজের টিমের) জন্য"
                value={s.ai.reports}
                onChange={(v) => set({ ai: { ...s.ai, reports: v } })}
              />
              {s.ai.reports && (
                <>
                  <Text style={ui.muted}>সপ্তাহের রিপোর্টের দিন</Text>
                  <View style={ui.chips}>
                    {DAYS.map((d, i) => (
                      <Chip
                        key={d}
                        text={d}
                        on={s.ai.weekly_day === i}
                        onPress={() => set({ ai: { ...s.ai, weekly_day: i } })}
                      />
                    ))}
                  </View>
                </>
              )}
              <Row
                title="🧑‍🏫 আলোচনার পাতা"
                text="টিমে কারো পাশে “আলোচনা”: one-to-one কথার জন্য AI-এর প্রস্তুতি"
                value={s.ai.coach}
                onChange={(v) => set({ ai: { ...s.ai, coach: v } })}
              />
              <Row
                title="💬 প্রশ্নোত্তর"
                text="সুপারভাইজারকে প্রশ্ন (দিনে প্রতিজন ২০টা)"
                value={s.ai.ask}
                onChange={(v) => set({ ai: { ...s.ai, ask: v } })}
              />
            </>
          )}
          <View style={styles.links}>
            <Button
              title="🎯 মাসিক ভর্তির লক্ষ্য"
              variant="secondary"
              onPress={() => router.push('/settings/supervisor-targets' as Href)}
            />
            <Button
              title="📚 আপত্তির উত্তর"
              variant="secondary"
              onPress={() => router.push('/settings/supervisor-playbook' as Href)}
            />
          </View>
        </View>

        <Text style={ui.label}>সম্ভাবনাময় lead</Text>
        <View style={styles.card}>
          <View style={styles.hours}>
            <Num
              label="Score থেকে"
              value={s.golden_score}
              min={30}
              max={95}
              onChange={(v) => set({ golden_score: v })}
            />
            <Text style={[ui.muted, styles.flex]}>এই score বা বেশি হলে “🎯 সম্ভাবনা বেশি” ধরা হবে</Text>
          </View>
        </View>

        <Text style={ui.label}>নিয়মগুলো</Text>
        {RULES.map((r) => {
          const rule = s.rules[r.key];
          return (
            <View key={r.key} style={styles.card}>
              <Row
                title={`${r.icon} ${r.title}`}
                text={`${r.text}\n👁 দেখবেন: ${WHO[r.who]}`}
                value={!!rule?.on}
                onChange={(v) => setRule(r.key, { on: v })}
              />
              {rule?.on && (
                <View style={styles.hours}>
                  {r.nums.map((n) => (
                    <Num
                      key={n.key}
                      label={n.label}
                      value={Number(rule[n.key] ?? n.min)}
                      min={n.min}
                      max={n.max}
                      decimal={n.min % 1 !== 0}
                      onChange={(v) => setRule(r.key, { [n.key]: v })}
                    />
                  ))}
                </View>
              )}
            </View>
          );
        })}

        {error && <Text style={ui.error}>{error}</Text>}
        <Button title={dirty ? 'Save' : 'Saved'} onPress={save} loading={saving} disabled={!dirty} fullWidth />
        <Button
          title="🔍 এখনই দেখুন"
          variant="secondary"
          onPress={runNow}
          loading={checking}
          disabled={dirty}
          fullWidth
        />
      </ScrollView>
    </View>
  );
}

function Row({
  title,
  text,
  value,
  onChange,
}: {
  title: string;
  text?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.title}>{title}</Text>
        {text ? <Text style={ui.muted}>{text}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} />
    </View>
  );
}

/** A small number box; keeps what is typed until it leaves the box */
function Num({
  label,
  value,
  min,
  max,
  decimal,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  decimal?: boolean;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const typed = (t: string) => {
    setText(t);
    const n = decimal ? parseFloat(t.replace(',', '.')) : parseInt(t, 10);
    // within the limits: it counts now (Save may be tapped without leaving the box)
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onChange(n);
  };
  const done = () => {
    const n = decimal ? parseFloat(text.replace(',', '.')) : parseInt(text, 10);
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <View style={styles.num}>
      <TextInput
        value={text}
        onChangeText={typed}
        onBlur={done}
        onSubmitEditing={done}
        keyboardType={decimal ? 'decimal-pad' : 'number-pad'}
        style={styles.numInput}
        accessibilityLabel={label}
        maxLength={5}
      />
      <Text style={ui.muted}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 60,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  flex: { flex: 1 },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, backgroundColor: md.surface1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  hours: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  num: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  numInput: {
    width: 64,
    height: 40,
    textAlign: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
    backgroundColor: colors.background,
  },
});
