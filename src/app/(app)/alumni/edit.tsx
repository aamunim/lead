import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import {
  getAlumnus,
  hintId,
  listAlumniFields,
  saveAlumnus,
  type AlumniField,
  type AlumnusInput,
} from '@/features/alumni/api';
import { alumniChanged, Chip, s as ui, useAlumniAccess } from '@/features/alumni/ui';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { isWeb } from '@/features/web/api';
import type { Json } from '@/shared/types/database';
import { colors, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// ✍️ Add / change an alumnus (+ the custom fields from Settings → Alumni)
// =====================================================================

type Form = {
  name: string;
  phone: string;
  whatsapp_number: string;
  email: string;
  course_id: string | null;
  batch_id: string | null;
  session: string;
  passing_year: string;
  student_ref: string;
  workplace: string;
  designation: string;
  district: string;
  upazila: string;
  address: string;
  tags: string;
  notes: string;
  owner_id: string | null;
  do_not_contact: boolean;
  custom: Record<string, Json>;
  /** 🎂 as typed: 25/5/1990 (or 1990-05-25) */
  birth: string;
};

/** "25/5/1990" or "1990-05-25" → "1990-05-25"; "" → null; anything else → undefined (wrong) */
function birthIso(text: string): string | null | undefined {
  const t = text.trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  const dmy = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  const ymd = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1930 || date > new Date()) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const EMPTY: Form = {
  name: '',
  phone: '',
  whatsapp_number: '',
  email: '',
  course_id: null,
  batch_id: null,
  session: '',
  passing_year: '',
  student_ref: '',
  workplace: '',
  designation: '',
  district: '',
  upazila: '',
  address: '',
  tags: '',
  notes: '',
  owner_id: null,
  do_not_contact: false,
  custom: {},
  birth: '',
};

export default function AlumnusEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const access = useAlumniAccess();
  const [form, setForm] = useState<Form>(EMPTY);
  const [fields, setFields] = useState<AlumniField[]>([]);
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [people, setPeople] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dupId, setDupId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      id ? getAlumnus(id) : Promise.resolve(null),
      listAlumniFields(),
      listCourses().catch(() => []),
      listAssignableUsers().catch(() => []),
    ])
      .then(([a, f, c, p]) => {
        setFields(f);
        setCourses(c);
        setPeople(p);
        if (a) {
          setForm({
            name: a.name,
            phone: a.phone ?? '',
            whatsapp_number: a.whatsapp_number ?? '',
            email: a.email ?? '',
            course_id: a.course_id,
            batch_id: a.batch_id,
            session: a.session ?? '',
            passing_year: a.passing_year ? String(a.passing_year) : '',
            student_ref: a.student_ref ?? '',
            workplace: a.workplace ?? '',
            designation: a.designation ?? '',
            district: a.district ?? '',
            upazila: a.upazila ?? '',
            address: a.address ?? '',
            tags: a.tags.join(', '),
            notes: a.notes ?? '',
            owner_id: a.owner_id,
            do_not_contact: a.do_not_contact,
            custom: a.custom ?? {},
            birth: a.birth_date
              ? (() => {
                  const [y, m, d] = a.birth_date.split('-');
                  return `${Number(d)}/${Number(m)}/${y}`;
                })()
              : '',
          });
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
      .finally(() => setLoading(false));
  }, [id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setCustom = (k: string, v: Json) => setForm((f) => ({ ...f, custom: { ...f.custom, [k]: v } }));
  const batches = useMemo(() => courses.find((c) => c.id === form.course_id)?.batches ?? [], [courses, form.course_id]);

  const save = async () => {
    if (!form.name.trim()) return setError('Please type the name.');
    if (form.passing_year && !/^\d{4}$/.test(form.passing_year.trim()))
      return setError('Passing year: 4 digits, like 2024.');
    const birth = birthIso(form.birth);
    if (birth === undefined) return setError('Birthday: day/month/year, like 25/5/1990.');
    for (const f of fields) {
      const v = form.custom[f.key];
      if (f.required && (v === undefined || v === null || String(v).trim() === ''))
        return setError(`Please fill in "${f.label}".`);
    }
    setSaving(true);
    setError(null);
    setDupId(null);
    const { birth: _typed, ...rest } = form;
    const row: AlumnusInput = {
      ...rest,
      birth_date: birth,
      passing_year: form.passing_year.trim() || null,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
    try {
      const newId = await saveAlumnus(id ?? null, row);
      alumniChanged();
      if (id) router.back();
      else router.replace(`/alumni/${newId}` as Href);
    } catch (e) {
      setDupId(hintId(e, 'alumni_duplicate'));
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!access.manage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumnus' }} />
        <Text style={ui.muted}>Only people who manage alumni can add or change them.</Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: id ? 'Change alumnus' : 'Add alumnus' }} />
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: id ? 'Change alumnus' : 'Add alumnus' }} />

      <View style={ui.card}>
        <Text style={ui.label}>CONTACT</Text>
        <TextField label="Name *" value={form.name} onChangeText={(v) => set('name', v)} autoCapitalize="words" />
        <TextField label="Phone" value={form.phone} onChangeText={(v) => set('phone', v)} keyboardType="phone-pad" />
        <TextField
          label="WhatsApp (if different)"
          value={form.whatsapp_number}
          onChangeText={(v) => set('whatsapp_number', v)}
          keyboardType="phone-pad"
        />
        <TextField
          label="E-mail"
          value={form.email}
          onChangeText={(v) => set('email', v)}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </View>

      <View style={ui.card}>
        <Text style={ui.label}>STUDY</Text>
        {courses.length > 0 && (
          <View style={ui.chips}>
            {courses.map((c) => (
              <Chip
                key={c.id}
                text={c.name}
                on={form.course_id === c.id}
                onPress={() =>
                  setForm((f) => ({ ...f, course_id: f.course_id === c.id ? null : c.id, batch_id: null }))
                }
              />
            ))}
          </View>
        )}
        {batches.length > 0 && (
          <View style={ui.chips}>
            {batches.map((b) => (
              <Chip
                key={b.id}
                text={b.name}
                on={form.batch_id === b.id}
                onPress={() => set('batch_id', form.batch_id === b.id ? null : b.id)}
              />
            ))}
          </View>
        )}
        <View style={styles.two}>
          <View style={styles.flex}>
            <TextField
              label="Session"
              value={form.session}
              onChangeText={(v) => set('session', v)}
              placeholder="2022-23"
            />
          </View>
          <View style={styles.flex}>
            <TextField
              label="Passing year"
              value={form.passing_year}
              onChangeText={(v) => set('passing_year', v.replace(/\D/g, '').slice(0, 4))}
              keyboardType="number-pad"
            />
          </View>
        </View>
        <TextField label="Roll / Student ID" value={form.student_ref} onChangeText={(v) => set('student_ref', v)} />
        <TextField
          label="🎂 Birthday (for a wish on the day)"
          value={form.birth}
          onChangeText={(v) => set('birth', v)}
          placeholder="25/5/1990"
          keyboardType="numbers-and-punctuation"
        />
      </View>

      <View style={ui.card}>
        <Text style={ui.label}>WORK & PLACE</Text>
        <TextField
          label="Workplace (school / office)"
          value={form.workplace}
          onChangeText={(v) => set('workplace', v)}
        />
        <TextField label="Designation" value={form.designation} onChangeText={(v) => set('designation', v)} />
        <View style={styles.two}>
          <View style={styles.flex}>
            <TextField label="District" value={form.district} onChangeText={(v) => set('district', v)} />
          </View>
          <View style={styles.flex}>
            <TextField label="Upazila" value={form.upazila} onChangeText={(v) => set('upazila', v)} />
          </View>
        </View>
        <TextField label="Address" value={form.address} onChangeText={(v) => set('address', v)} multiline />
      </View>

      {fields.length > 0 && (
        <View style={ui.card}>
          <Text style={ui.label}>MORE</Text>
          {fields.map((f) => (
            <CustomInput key={f.id} field={f} value={form.custom[f.key]} onChange={(v) => setCustom(f.key, v)} />
          ))}
        </View>
      )}

      <View style={ui.card}>
        <Text style={ui.label}>FOR THE TEAM</Text>
        {people.length > 0 && (
          <>
            <Text style={ui.muted}>Looked after by (optional)</Text>
            <View style={ui.chips}>
              {people.map((p) => (
                <Chip
                  key={p.id}
                  text={p.full_name ?? 'No name'}
                  on={form.owner_id === p.id}
                  onPress={() => set('owner_id', form.owner_id === p.id ? null : p.id)}
                />
              ))}
            </View>
          </>
        )}
        <TextField
          label="Tags (comma between)"
          value={form.tags}
          onChangeText={(v) => set('tags', v)}
          placeholder="active, teacher"
        />
        <TextField label="Notes" value={form.notes} onChangeText={(v) => set('notes', v)} multiline />
        <View style={styles.switchRow}>
          <Text style={[styles.flex, styles.switchText]}>⛔ Do not contact</Text>
          <Switch value={form.do_not_contact} onValueChange={(v) => set('do_not_contact', v)} />
        </View>
      </View>

      {error && <Text style={ui.error}>{error}</Text>}
      {dupId && (
        <Pressable onPress={() => router.replace(`/alumni/${dupId}` as Href)} accessibilityRole="link">
          <Text style={styles.link}>Open the one who has this number ›</Text>
        </Pressable>
      )}
      <Button title={id ? 'Save' : 'Add'} onPress={save} loading={saving} fullWidth />
    </KeyboardAwareScrollView>
  );
}

function CustomInput({
  field,
  value,
  onChange,
}: {
  field: AlumniField;
  value: Json | undefined;
  onChange: (v: Json) => void;
}) {
  const label = field.label + (field.required ? ' *' : '');
  const text = value === undefined || value === null ? '' : String(value);
  switch (field.type) {
    case 'select':
      return (
        <View style={styles.custom}>
          <Text style={ui.muted}>{label}</Text>
          <View style={ui.chips}>
            {field.options.map((o) => (
              <Chip key={o} text={o} on={text === o} onPress={() => onChange(text === o ? null : o)} />
            ))}
          </View>
        </View>
      );
    case 'yes_no':
      return (
        <View style={styles.switchRow}>
          <Text style={[styles.flex, styles.switchText]}>{label}</Text>
          <Switch value={value === true || value === 'true'} onValueChange={onChange} />
        </View>
      );
    case 'number':
      return (
        <TextField
          label={label}
          value={text}
          onChangeText={(v) => onChange(v.replace(/[^0-9.-]/g, ''))}
          keyboardType="numeric"
        />
      );
    case 'date':
      return <TextField label={label} value={text} onChangeText={onChange} placeholder="2024-12-31" />;
    case 'phone':
      return <TextField label={label} value={text} onChangeText={onChange} keyboardType="phone-pad" />;
    case 'email':
      return (
        <TextField
          label={label}
          value={text}
          onChangeText={onChange}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      );
    case 'url':
      return <TextField label={label} value={text} onChangeText={onChange} keyboardType="url" autoCapitalize="none" />;
    case 'long_text':
      return <TextField label={label} value={text} onChangeText={onChange} multiline />;
    default:
      return <TextField label={label} value={text} onChangeText={onChange} />;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 680, width: '100%', alignSelf: 'center' } : {}),
  },
  two: { flexDirection: 'row', gap: spacing.sm },
  custom: { gap: spacing.xs },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  switchText: { color: colors.text },
  link: { color: colors.primary, fontWeight: '700' },
});
