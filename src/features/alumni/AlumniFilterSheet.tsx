import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  alumniFilterValues,
  countAlumniFilters,
  saveAlumniFilter,
  type AlumniField,
  type AlumniFilterKey,
  type AlumniFilters,
  type AlumniFilterValues,
  type AlumniSort,
} from '@/features/alumni/api';
import { Chip, s as ui } from '@/features/alumni/ui';
import { md } from '@/features/home/md';
import type { AssignableUser } from '@/features/leads/api';
import type { CourseWithDetails } from '@/features/settings/api';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🔍 Alumni: every filter in one sheet (the order and which ones show:
//   Settings → Alumni → Filters). "Save" keeps the filter for later
//   (managers can share it with everyone).
// =====================================================================

type Props = {
  value: AlumniFilters;
  sort: AlumniSort;
  order: AlumniFilterKey[];
  courses: CourseWithDetails[];
  people: AssignableUser[];
  fields: AlumniField[];
  manage: boolean;
  onApply: (f: AlumniFilters) => void;
  onSaved: () => void;
  onClose: () => void;
};

const NEXT: { key: NonNullable<AlumniFilters['next']>; label: string }[] = [
  { key: 'late', label: '⚠ Late' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'This week' },
  { key: 'set', label: 'Any set' },
  { key: 'none', label: 'None set' },
];
const CONTACT: { key: NonNullable<AlumniFilters['contact']>; label: string }[] = [
  { key: 'week', label: 'In the last 7 days' },
  { key: 'never', label: 'Never' },
  { key: '30', label: 'Over 30 days ago' },
  { key: '90', label: 'Over 3 months ago' },
  { key: '180', label: 'Over 6 months ago' },
];
const REFERRALS: { key: NonNullable<AlumniFilters['referrals']>; label: string }[] = [
  { key: 'any', label: 'Referred someone' },
  { key: '3', label: '3 or more' },
  { key: 'admitted', label: 'Got someone admitted' },
  { key: 'waiting', label: 'Waiting in the inbox' },
  { key: 'none', label: 'Never referred' },
];

export function AlumniFilterSheet(p: Props) {
  const [f, setF] = useState<AlumniFilters>(p.value);
  const [values, setValues] = useState<AlumniFilterValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    alumniFilterValues()
      .then(setValues)
      .catch(() =>
        setValues({ districts: [], upazilas: [], workplaces: [], designations: [], sessions: [], years: [], tags: [] }),
      );
  }, []);

  const set = (patch: Partial<AlumniFilters>) => setF((now) => ({ ...now, ...patch }));
  const toggle = <K extends keyof AlumniFilters>(key: K, v: AlumniFilters[K]) =>
    setF((now) => ({ ...now, [key]: now[key] === v ? null : v }));
  const n = countAlumniFilters(f);
  const batches = p.courses.find((c) => c.id === f.courseId)?.batches ?? [];
  const pickFields = useMemo(
    () => p.fields.filter((x) => x.is_active && (x.type === 'select' || x.type === 'yes_no')),
    [p.fields],
  );

  const save = async () => {
    if (!saveName.trim()) return setError('Give the filter a name.');
    setError(null);
    try {
      await saveAlumniFilter(saveName, f, p.sort, share && p.manage);
      setSaving(false);
      setSaveName('');
      p.onSaved();
      p.onApply(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  const section = (key: AlumniFilterKey) => {
    switch (key) {
      case 'next':
        return (
          <Block key={key} title="⏰ NEXT CONTACT">
            {NEXT.map((o) => (
              <Chip key={o.key} text={o.label} on={f.next === o.key} onPress={() => toggle('next', o.key)} />
            ))}
          </Block>
        );
      case 'contact':
        return (
          <Block key={key} title="📞 LAST CONTACT">
            {CONTACT.map((o) => (
              <Chip key={o.key} text={o.label} on={f.contact === o.key} onPress={() => toggle('contact', o.key)} />
            ))}
          </Block>
        );
      case 'course':
        return p.courses.length === 0 ? null : (
          <Block key={key} title="🎓 COURSE & BATCH">
            <Chip
              text="⚠ No course"
              on={f.courseId === 'none'}
              onPress={() => set({ courseId: f.courseId === 'none' ? null : 'none', batchId: null })}
            />
            <Chip
              text="⚠ No batch"
              on={f.batchId === 'none' && f.courseId !== 'none'}
              onPress={() => set({ batchId: f.batchId === 'none' ? null : 'none' })}
            />
            <Chip
              text="📵 No number"
              on={f.noPhone === true}
              onPress={() => set({ noPhone: f.noPhone ? null : true })}
            />
            <View style={styles.break} />
            {p.courses.map((c) => (
              <Chip
                key={c.id}
                text={c.name}
                on={f.courseId === c.id}
                onPress={() => set({ courseId: f.courseId === c.id ? null : c.id, batchId: null })}
              />
            ))}
            {batches.length > 0 && <View style={styles.break} />}
            {batches.map((b) => (
              <Chip key={b.id} text={b.name} on={f.batchId === b.id} onPress={() => toggle('batchId', b.id)} />
            ))}
          </Block>
        );
      case 'year': {
        const years = values?.years ?? [];
        if (years.length === 0) return null;
        return (
          <Block key={key} title="📅 PASSING YEAR (FROM – TO)">
            {years.map((y) => {
              const on = (f.yearFrom ?? -1) <= y && y <= (f.yearTo ?? -1);
              return (
                <Chip
                  key={y}
                  text={String(y)}
                  on={on}
                  onPress={() => {
                    // first tap: that year; second tap on another: a range; tap inside the range: that year only
                    if (!f.yearFrom || f.yearFrom !== f.yearTo) set({ yearFrom: y, yearTo: y });
                    else if (y === f.yearFrom) set({ yearFrom: null, yearTo: null });
                    else set({ yearFrom: Math.min(y, f.yearFrom), yearTo: Math.max(y, f.yearFrom) });
                  }}
                />
              );
            })}
          </Block>
        );
      }
      case 'session':
        return (values?.sessions.length ?? 0) === 0 ? null : (
          <Block key={key} title="SESSION">
            {values!.sessions.map((v) => (
              <Chip key={v} text={v} on={f.session === v} onPress={() => toggle('session', v)} />
            ))}
          </Block>
        );
      case 'district':
        return (values?.districts.length ?? 0) === 0 ? null : (
          <Block key={key} title="📍 DISTRICT">
            {values!.districts.map((v) => (
              <Chip key={v} text={v} on={f.district === v} onPress={() => toggle('district', v)} />
            ))}
          </Block>
        );
      case 'upazila':
        return (values?.upazilas.length ?? 0) === 0 ? null : (
          <Block key={key} title="UPAZILA">
            {values!.upazilas.map((v) => (
              <Chip key={v} text={v} on={f.upazila === v} onPress={() => toggle('upazila', v)} />
            ))}
          </Block>
        );
      case 'workplace':
        return (
          <Block key={key} title="🏫 WORKPLACE">
            <Chip text="Has a workplace" on={f.hasWorkplace === true} onPress={() => toggle('hasWorkplace', true)} />
            <Chip text="No workplace" on={f.hasWorkplace === false} onPress={() => toggle('hasWorkplace', false)} />
            <Typed
              value={f.workplace ?? ''}
              onChange={(v) => set({ workplace: v || null })}
              placeholder="Name has… (e.g. Ideal School)"
              suggestions={values?.workplaces ?? []}
            />
          </Block>
        );
      case 'designation':
        return (
          <Block key={key} title="DESIGNATION">
            <Typed
              value={f.designation ?? ''}
              onChange={(v) => set({ designation: v || null })}
              placeholder="e.g. Head teacher"
              suggestions={values?.designations ?? []}
            />
          </Block>
        );
      case 'tags':
        return (values?.tags.length ?? 0) === 0 ? null : (
          <Block key={key} title="🏷 TAGS (ALL OF)">
            {values!.tags.map((t) => {
              const on = (f.tags ?? []).includes(t);
              return (
                <Chip
                  key={t}
                  text={t}
                  on={on}
                  onPress={() => set({ tags: on ? (f.tags ?? []).filter((x) => x !== t) : [...(f.tags ?? []), t] })}
                />
              );
            })}
          </Block>
        );
      case 'owner':
        return (
          <Block key={key} title="👤 LOOKED AFTER BY">
            <Chip text="Nobody" on={f.ownerId === 'none'} onPress={() => toggle('ownerId', 'none')} />
            {p.people.map((u) => (
              <Chip
                key={u.id}
                text={u.full_name ?? 'No name'}
                on={f.ownerId === u.id}
                onPress={() => toggle('ownerId', u.id)}
              />
            ))}
          </Block>
        );
      case 'referrals':
        return (
          <Block key={key} title="📨 REFERRALS">
            {REFERRALS.map((o) => (
              <Chip key={o.key} text={o.label} on={f.referrals === o.key} onPress={() => toggle('referrals', o.key)} />
            ))}
          </Block>
        );
      case 'reward':
        return !p.manage ? null : (
          <Block key={key} title="🎁 REWARD">
            <Chip text="Still to be paid" on={!!f.rewardDue} onPress={() => set({ rewardDue: !f.rewardDue })} />
          </Block>
        );
      case 'birthday':
        return (
          <Block key={key} title="🎂 BIRTHDAY">
            <Chip text="In the next 7 days" on={f.birthday === 'week'} onPress={() => toggle('birthday', 'week')} />
            <Chip text="This month" on={f.birthday === 'month'} onPress={() => toggle('birthday', 'month')} />
          </Block>
        );
      case 'dnc':
        return (
          <Block key={key} title="🚫 DO NOT CONTACT">
            <Chip text="Hide them" on={f.dnc === 'hide'} onPress={() => toggle('dnc', 'hide')} />
            <Chip text="Only them" on={f.dnc === 'only'} onPress={() => toggle('dnc', 'only')} />
          </Block>
        );
      case 'custom':
        return pickFields.length === 0 ? null : (
          <View key={key} style={styles.custom}>
            {pickFields.map((fd) => {
              const opts = fd.type === 'yes_no' ? ['yes', 'no'] : (fd.options ?? []);
              const cur = f.custom?.[fd.key] ?? null;
              return (
                <Block key={fd.id} title={fd.label.toUpperCase()}>
                  {opts.map((o) => (
                    <Chip
                      key={o}
                      text={fd.type === 'yes_no' ? (o === 'yes' ? 'Yes' : 'No') : o}
                      on={cur === o}
                      onPress={() => {
                        const next = { ...(f.custom ?? {}) };
                        if (cur === o) delete next[fd.key];
                        else next[fd.key] = o;
                        set({ custom: next });
                      }}
                    />
                  ))}
                </Block>
              );
            })}
          </View>
        );
    }
  };

  return (
    <Modal visible transparent keyboard animationType="slide" onRequestClose={p.onClose}>
      <Pressable style={styles.backdrop} onPress={p.onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.titleRow}>
          <Text style={styles.title}>Filter alumni{n ? ` · ${n}` : ''}</Text>
          {n > 0 && (
            <Pressable onPress={() => setF({})} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>Clear all</Text>
            </Pressable>
          )}
        </View>
        {!values ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {p.order.map(section)}
          </ScrollView>
        )}

        {saving ? (
          <View style={styles.saveBox}>
            <TextInput
              value={saveName}
              onChangeText={setSaveName}
              placeholder="Name, e.g. Active referrers in Dhaka"
              placeholderTextColor={colors.textMuted}
              maxLength={40}
              style={styles.input}
              autoFocus
            />
            {p.manage && (
              <View style={styles.shareRow}>
                <Text style={styles.shareText}>Share with everyone who sees alumni</Text>
                <Switch value={share} onValueChange={setShare} />
              </View>
            )}
            {error && <Text style={ui.error}>{error}</Text>}
            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button title="Back" variant="ghost" onPress={() => setSaving(false)} fullWidth />
              </View>
              <View style={styles.flex}>
                <Button title="Save & show" onPress={save} fullWidth />
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button
                title="Save filter"
                variant="ghost"
                onPress={() => setSaving(true)}
                disabled={n === 0}
                fullWidth
              />
            </View>
            <View style={styles.flex}>
              <Button title="Show" onPress={() => p.onApply(f)} fullWidth />
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text style={ui.label}>{title}</Text>
      <View style={ui.chips}>{children}</View>
    </View>
  );
}

/** A text box with the matching values in use below it */
function Typed({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  suggestions: string[];
}) {
  const [text, setText] = useState(value);
  const q = text.trim().toLowerCase();
  const list = q ? suggestions.filter((x) => x.toLowerCase().includes(q) && x !== text).slice(0, 6) : [];
  return (
    <View style={styles.typed}>
      <TextInput
        value={text}
        onChangeText={(v) => {
          setText(v);
          onChange(v.trim());
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        autoCorrect={false}
      />
      {list.length > 0 && (
        <View style={ui.chips}>
          {list.map((x) => (
            <Chip
              key={x}
              text={x}
              on={false}
              onPress={() => {
                setText(x);
                onChange(x);
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '88%',
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    ...(isWeb ? { width: '100%', maxWidth: 560, alignSelf: 'center' } : {}),
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: md.outline,
    marginTop: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  loader: { margin: spacing.xl },
  body: { paddingHorizontal: spacing.lg, gap: spacing.lg, paddingBottom: spacing.md },
  block: { gap: spacing.sm },
  custom: { gap: spacing.lg },
  break: { width: '100%', height: 0 },
  typed: { width: '100%', gap: spacing.sm },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
  saveBox: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  shareText: { flex: 1, fontSize: fontSize.small, color: colors.text },
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
});
