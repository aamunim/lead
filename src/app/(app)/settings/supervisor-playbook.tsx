import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { OBJECTION_LABEL } from '@/features/aiChance/api';
import { s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { md } from '@/features/home/md';
import { getPlaybook, savePlaybook, type PlaybookItem } from '@/features/supervisor/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 📚 Settings → Supervisor → answers to objections (the playbook).
//   The college's own words for each objection (fee, family, distance…).
//   Shown under that objection in the Reports tab, for everyone to use.
// =====================================================================

function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

const KINDS = Object.keys(OBJECTION_LABEL);
const HINT: Record<string, string> = {
  fee: 'যেমন: কিস্তিতে দেওয়া যায়, কোন কোন সুবিধা ফি-র মধ্যে আছে…',
  family: 'যেমন: পরিবারের কাউকে নিয়ে ক্যাম্পাসে আসার আমন্ত্রণ…',
  distance: 'যেমন: ক্লাস কোন দিন, অনলাইন সুবিধা আছে কিনা…',
  time: 'যেমন: শুক্র-শনির ব্যাচ, চাকরির পাশে করা যায়…',
  other_college: 'যেমন: আমাদের ফলাফল, শিক্ষক, সনদের মান…',
  job: 'যেমন: এই কোর্স চাকরিতে কীভাবে কাজে লাগে…',
  doubt: 'যেমন: কোর্সের সুবিধা, প্রাক্তন ছাত্রদের অভিজ্ঞতা…',
  documents: 'যেমন: কোন কাগজ লাগবে, না থাকলে কী করা যায়…',
  other: '',
};

export default function SupervisorPlaybookScreen() {
  const { hasPermission } = useAuth();
  const [items, setItems] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPlaybook()
      .then((p) => setItems(Object.fromEntries(p.map((x) => [x.kind, x.answer]))))
      // (left empty: saving now would wipe the stored answers)
      .catch((e) => setError(e instanceof Error ? e.message : 'লোড করা যায়নি।'));
  }, []);

  const save = async () => {
    if (!items) return;
    setSaving(true);
    setError(null);
    try {
      const list: PlaybookItem[] = KINDS.map((k) => ({ kind: k, answer: items[k] ?? '' }));
      await savePlaybook(list);
      setDirty(false);
      say('Saved', 'উত্তরগুলো রাখা হয়েছে। Supervisor → রিপোর্ট-এ আপত্তির নিচে দেখা যাবে।');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save করা যায়নি।');
    } finally {
      setSaving(false);
    }
  };

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Objection answers' }} />
        <Text style={ui.muted}>শুধু admin এটা বদলাতে পারেন।</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Objection answers' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={ui.muted}>
          প্রতিটা আপত্তির জন্য আপনাদের নিজের উত্তর লিখুন। টিম এগুলো রিপোর্টে আপত্তির নিচে দেখবে। ভুল তথ্য দেবেন না।
        </Text>
        {items === null ? (
          error ? null : (
            <ActivityIndicator color={colors.primary} />
          )
        ) : (
          KINDS.map((k) => (
            <View key={k} style={styles.card}>
              <Text style={styles.title}>{OBJECTION_LABEL[k]}</Text>
              <TextInput
                value={items[k] ?? ''}
                onChangeText={(t) => {
                  setItems((v) => ({ ...(v ?? {}), [k]: t }));
                  setDirty(true);
                }}
                placeholder={HINT[k] || 'আপনাদের উত্তর…'}
                placeholderTextColor={colors.textMuted}
                multiline
                maxLength={1500}
                style={styles.input}
                accessibilityLabel={OBJECTION_LABEL[k]}
              />
            </View>
          ))
        )}
        {error && <Text style={ui.error}>{error}</Text>}
        <Button
          title={dirty ? 'Save' : 'Saved'}
          onPress={save}
          loading={saving}
          disabled={!dirty || !items}
          fullWidth
        />
      </ScrollView>
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
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, backgroundColor: md.surface1 },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    minHeight: 72,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
    textAlignVertical: 'top',
    backgroundColor: colors.background,
  },
});
