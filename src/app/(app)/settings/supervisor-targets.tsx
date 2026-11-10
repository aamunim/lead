import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, md, Tap } from '@/features/home/md';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { getTargets, saveTargets } from '@/features/supervisor/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🎯 Settings → Supervisor → monthly admission targets, per course.
//   The Reports tab shows each course against its target (the pace, what
//   is needed each day). Empty = no target for that course.
// =====================================================================

function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const monthName = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export default function SupervisorTargetsScreen() {
  const { hasPermission } = useAuth();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [courses, setCourses] = useState<CourseWithDetails[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCourses()
      .then((c) => setCourses(c.filter((x) => (x as { is_active?: boolean }).is_active !== false)))
      .catch((e) => setError(e instanceof Error ? e.message : 'লোড করা যায়নি।'));
  }, []);

  const req = useRef(0);
  const load = useCallback(async () => {
    const id = ++req.current;
    setLoading(true);
    setError(null);
    try {
      const t = await getTargets(month);
      // another month asked meanwhile: this answer is not for the screen
      if (id !== req.current) return;
      setValues(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])));
      setDirty(false);
    } catch (e) {
      if (id === req.current) setError(e instanceof Error ? e.message : 'লোড করা যায়নি।');
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, [month]);
  useEffect(() => {
    load();
  }, [load]);

  const shift = (n: number) => {
    const go = () => {
      const [y, m] = month.split('-').map(Number);
      setMonth(monthKey(new Date(y, m - 1 + n, 1)));
    };
    if (!dirty || saving) return saving ? undefined : go();
    if (Platform.OS === 'web') {
      if (window.confirm('Save না করা পরিবর্তন হারাবে। চালিয়ে যাবেন?')) go();
      return;
    }
    Alert.alert('Save করা হয়নি', 'এই মাসের পরিবর্তন হারাবে। চালিয়ে যাবেন?', [
      { text: 'না', style: 'cancel' },
      { text: 'হ্যাঁ', style: 'destructive', onPress: go },
    ]);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const out: Record<string, number | null> = {};
      for (const c of courses ?? []) {
        const t = (values[c.id] ?? '').trim();
        if (t === '') out[c.id] = null;
        else {
          const n = parseInt(t, 10);
          if (!Number.isFinite(n) || n < 0 || n > 100000)
            throw new Error(`${c.name}: ০ থেকে ১০০০০০ এর মধ্যে সংখ্যা দিন।`);
          out[c.id] = n;
        }
      }
      await saveTargets(month, out);
      setDirty(false);
      say('Saved', `${monthName(month)}-এর লক্ষ্য রাখা হয়েছে।`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save করা যায়নি।');
    } finally {
      setSaving(false);
    }
  };

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Admission targets' }} />
        <Text style={ui.muted}>শুধু admin এটা বদলাতে পারেন।</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Admission targets' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.monthRow}>
          <Tap onPress={() => shift(-1)} label="আগের মাস" style={styles.arrow}>
            <MIcon name="chevron-left" />
          </Tap>
          <Text style={styles.month}>{monthName(month)}</Text>
          <Tap onPress={() => shift(1)} label="পরের মাস" style={styles.arrow}>
            <MIcon name="chevron-right" />
          </Tap>
        </View>
        <Text style={ui.muted}>প্রতিটা course-এ এই মাসে কতজন ভর্তি চান। খালি রাখলে লক্ষ্য নেই।</Text>
        {courses === null || loading ? (
          <ActivityIndicator color={colors.primary} />
        ) : courses.length === 0 ? (
          <Text style={ui.muted}>কোনো course নেই।</Text>
        ) : (
          <View style={styles.card}>
            {courses.map((c) => (
              <View key={c.id} style={styles.row}>
                <Text style={[styles.name, styles.flex]} numberOfLines={2}>
                  {c.name}
                </Text>
                <TextInput
                  value={values[c.id] ?? ''}
                  onChangeText={(t) => {
                    setValues((v) => ({ ...v, [c.id]: t.replace(/[^0-9]/g, '') }));
                    setDirty(true);
                  }}
                  placeholder="—"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={6}
                  style={styles.input}
                  accessibilityLabel={`${c.name} target`}
                />
              </View>
            ))}
          </View>
        )}
        {error && <Text style={ui.error}>{error}</Text>}
        <Button
          title={dirty ? 'Save' : 'Saved'}
          onPress={save}
          loading={saving}
          disabled={!dirty || loading}
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
    maxWidth: 640,
    alignSelf: 'center',
  },
  flex: { flex: 1 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  arrow: { padding: 6, borderRadius: 18, overflow: 'hidden' },
  month: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    minWidth: 180,
    textAlign: 'center',
  },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, backgroundColor: md.surface1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { fontSize: fontSize.body, color: colors.text },
  input: {
    width: 88,
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
