import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon } from '@/features/home/md';
import { getLead, type LeadDetail } from '@/features/leads/api';
import { mergeLeads, type MergeFields } from '@/features/leads/merge';
import { MergePickSheet } from '@/features/leads/MergePickSheet';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🔗 Merge leads: the same person with two (or more) numbers.
//   Pick the main lead and, where the leads differ, which value stays.
//   Calls, notes, next calls, visits, files, papers and fees all move to
//   the main lead; every number and course is kept.
// =====================================================================

type Choice = { key: keyof MergeFields; label: string; get: (l: LeadDetail) => { value: string | null; text: string } };

const CHOICES: Choice[] = [
  { key: 'name', label: 'Name', get: (l) => ({ value: l.name, text: l.name }) },
  {
    key: 'stage_id',
    label: 'Stage',
    get: (l) => ({ value: l.stage?.kind === 'open' ? l.stage_id : null, text: l.stage?.name ?? '—' }),
  },
  {
    key: 'assigned_to',
    label: 'Assigned to',
    get: (l) => ({ value: l.assigned_to ?? '', text: l.assignee?.full_name ?? 'Unassigned' }),
  },
  { key: 'source_id', label: 'Source', get: (l) => ({ value: l.source_id, text: l.source?.name ?? '—' }) },
  {
    key: 'rating',
    label: 'Rating',
    get: (l) => ({ value: l.rating, text: l.rating ? l.rating[0].toUpperCase() + l.rating.slice(1) : '—' }),
  },
  { key: 'email', label: 'Email', get: (l) => ({ value: l.email, text: l.email ?? '—' }) },
  { key: 'area', label: 'Area', get: (l) => ({ value: l.area, text: l.area ?? '—' }) },
  { key: 'guardian_name', label: 'Guardian', get: (l) => ({ value: l.guardian_name, text: l.guardian_name ?? '—' }) },
  {
    key: 'guardian_phone',
    label: 'Guardian phone',
    get: (l) => ({ value: l.guardian_phone, text: l.guardian_phone ?? '—' }),
  },
  {
    key: 'guardian_relation',
    label: 'Relation',
    get: (l) => ({ value: l.guardian_relation, text: l.guardian_relation ?? '—' }),
  },
  { key: 'referred_by', label: 'Referred by', get: (l) => ({ value: l.referred_by, text: l.referred_by ?? '—' }) },
  { key: 'lead_type_id', label: 'Lead type', get: (l) => ({ value: l.lead_type_id, text: l.lead_type?.name ?? '—' }) },
  { key: 'campaign_id', label: 'Campaign', get: (l) => ({ value: l.campaign_id, text: l.campaign?.name ?? '—' }) },
];

const won = (l: LeadDetail) => l.stage?.kind === 'won';
const hasFee = (l: LeadDetail) => !!l.fee_status || Number(l.fee_paid ?? 0) > 0;
const numbersOf = (l: LeadDetail) =>
  [l.phone, l.alt_phone, l.whatsapp_number, ...((l.extra_phones as string[] | null) ?? [])].filter(Boolean) as string[];

export default function MergeScreen() {
  const { ids: idsParam } = useLocalSearchParams<{ ids?: string }>();
  const { hasPermission } = useAuth();
  const insets = useSafeAreaInsets();

  const [ids, setIds] = useState<string[]>(() =>
    String(idsParam ?? '')
      .split(',')
      .filter(Boolean),
  );
  // The link's leads (they can arrive a moment after the first draw)
  useEffect(() => {
    const fromLink = String(idsParam ?? '')
      .split(',')
      .filter(Boolean);
    if (fromLink.length > 0) setIds((cur) => [...new Set([...fromLink, ...cur])]);
  }, [idsParam]);
  const [leads, setLeads] = useState<LeadDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mainId, setMainId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Partial<Record<keyof MergeFields, string | null>>>({});
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all(ids.map((id) => getLead(id)))
      .then((rows) => {
        if (!live) return;
        const found = rows.filter(Boolean) as LeadDetail[];
        setLeads(found);
        // The admitted one, else the oldest, is the main lead
        setMainId((cur) =>
          cur && found.some((l) => l.id === cur)
            ? cur
            : ((found.find(won) ?? [...found].sort((a, b) => a.created_at.localeCompare(b.created_at))[0])?.id ?? null),
        );
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the leads.'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [ids]);

  const main = leads.find((l) => l.id === mainId) ?? null;
  const others = useMemo(() => leads.filter((l) => l.id !== mainId), [leads, mainId]);

  // Where the leads differ: the choices (the main lead's value first)
  const rows = useMemo(() => {
    if (!main) return [];
    return CHOICES.map((c) => {
      const seen = new Map<string, { text: string; from: string }>();
      for (const l of [main, ...others]) {
        const v = c.get(l);
        if (v.value == null || (v.value === '' && c.key !== 'assigned_to')) continue;
        if (c.key === 'stage_id' && main.stage?.kind !== 'open') continue;
        if (!seen.has(v.value)) seen.set(v.value, { text: v.text, from: l.name });
      }
      return { choice: c, options: [...seen.entries()].map(([value, o]) => ({ value, ...o })) };
    }).filter((r) => r.options.length > 1);
  }, [main, others]);

  // Default: the main lead's value
  useEffect(() => {
    const next: typeof picked = {};
    for (const r of rows) next[r.choice.key] = r.options[0].value;
    setPicked(next);
  }, [rows]);

  const numbers = useMemo(() => [...new Set(leads.flatMap(numbersOf))], [leads]);
  const courses = useMemo(
    () => [...new Set(leads.flatMap((l) => l.lead_courses.map((c) => c.course?.name).filter(Boolean) as string[]))],
    [leads],
  );

  const problem =
    leads.filter(won).length > 1
      ? 'More than one of these leads is admitted. They can’t be merged.'
      : leads.filter(hasFee).length > 1
        ? 'More than one of these leads has fee talk or payments. They can’t be merged.'
        : main && leads.some(won) && !won(main)
          ? 'Keep the admitted lead as the main one.'
          : null;

  const doMerge = async () => {
    if (!main || others.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const fields: MergeFields = {};
      for (const r of rows) {
        const v = picked[r.choice.key];
        (fields as Record<string, string | null>)[r.choice.key] = v === '' ? null : (v ?? null);
      }
      await mergeLeads(
        main.id,
        others.map((o) => o.id),
        fields,
      );
      router.replace(`/leads/${main.id}` as Href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge.');
    } finally {
      setSaving(false);
    }
  };

  const confirm = () => {
    const text = `${others.length + 1} leads become one: “${picked.name ?? main?.name}”. Everything moves to it.`;
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (window.confirm(text)) doMerge();
      return;
    }
    Alert.alert('Merge these leads?', text, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Merge', onPress: doMerge },
    ]);
  };

  if (!hasPermission('leads.merge')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Merge leads' }} />
        <Text style={styles.muted}>You are not allowed to merge leads. Ask an admin (Settings → Roles).</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Merge leads' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.intro}>
          <Text style={styles.introTitle}>🔗 One person, more than one lead</Text>
          <Text style={styles.muted}>
            Calls, notes, next calls, visits, files, papers and fees all move to the main lead. Every number and course
            is kept. An admin can undo it for 30 days.
          </Text>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.primary} size="large" style={styles.loader} />
        ) : (
          <>
            {/* 1. Main lead */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>1. Which lead stays?</Text>
              {leads.map((l) => {
                const on = l.id === mainId;
                return (
                  <Pressable
                    key={l.id}
                    onPress={() => setMainId(l.id)}
                    style={[styles.leadRow, on && styles.leadRowOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <MIcon
                      name={on ? 'radio-button-checked' : 'radio-button-unchecked'}
                      size={22}
                      color={on ? colors.primary : colors.textMuted}
                    />
                    <View style={styles.flex}>
                      <Text style={styles.leadName}>
                        {l.name}
                        {on && <Text style={styles.mainTag}> · main</Text>}
                      </Text>
                      <Text style={styles.meta}>
                        {[numbersOf(l).join(', '), l.stage?.name, l.assignee?.full_name ?? 'Unassigned']
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      <Text style={styles.meta}>Added {new Date(l.created_at).toLocaleDateString('en-GB')}</Text>
                    </View>
                    {leads.length > 2 && (
                      <Pressable
                        onPress={() => setIds((x) => x.filter((i) => i !== l.id))}
                        hitSlop={8}
                        accessibilityLabel={`Leave ${l.name} out`}
                      >
                        <MIcon name="close" size={20} color={colors.textMuted} />
                      </Pressable>
                    )}
                  </Pressable>
                );
              })}
              {leads.length < 10 && (
                <Button title="➕ Add another lead" variant="ghost" onPress={() => setAdding(true)} />
              )}
            </View>

            {/* 2. Different values */}
            {rows.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>2. Where they differ, keep…</Text>
                {rows.map((r) => (
                  <View key={r.choice.key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{r.choice.label}</Text>
                    <View style={styles.chips}>
                      {r.options.map((o) => {
                        const on = picked[r.choice.key] === o.value;
                        return (
                          <Pressable
                            key={o.value}
                            onPress={() => setPicked((p) => ({ ...p, [r.choice.key]: o.value }))}
                            style={[styles.chip, on && styles.chipOn]}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                          >
                            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.text}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* 3. Joined */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{rows.length > 0 ? '3.' : '2.'} Kept together</Text>
              <Text style={styles.line}>☎ Numbers: {numbers.join(', ') || '—'}</Text>
              <Text style={styles.line}>🎓 Courses: {courses.join(', ') || '—'}</Text>
              <Text style={styles.line}>📝 Notes: joined, each with the lead’s name</Text>
              <Text style={styles.line}>📞 Calls, notes, next calls, visits, files, papers, fees, ⭐ stars</Text>
            </View>

            {(problem || error) && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{problem ?? error}</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: spacing.md + (isWeb ? 0 : insets.bottom) }]}>
        <Button
          title={leads.length > 1 ? `🔗 Merge ${leads.length} leads` : 'Choose another lead'}
          onPress={leads.length > 1 ? confirm : () => setAdding(true)}
          loading={saving}
          disabled={saving || loading || !!problem}
          fullWidth
        />
      </View>

      <MergePickSheet
        visible={adding}
        exclude={ids}
        onClose={() => setAdding(false)}
        onPick={(l) => {
          setAdding(false);
          setIds((x) => (x.includes(l.id) ? x : [...x, l.id]));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : {}),
  },
  flex: { flex: 1 },
  loader: { marginTop: spacing.xl },
  intro: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.primarySoft },
  introTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  leadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  leadRowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  leadName: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  mainTag: { fontSize: fontSize.small, color: colors.primary, fontWeight: fontWeight.bold },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  field: { gap: spacing.xs, paddingTop: spacing.xs },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  line: { fontSize: fontSize.small, color: colors.text },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  footer: {
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
