import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { createElement, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { activityRange, type ActivityPeriod } from '@/features/activity/api';
import { useActivityLookups } from '@/features/activity/useLookups';
import {
  WORK_PARTS,
  fetchWork,
  periodText,
  safeName,
  shareFile,
  toCsv,
  toText,
  toWorkbook,
  type WorkData,
  type WorkFormat,
  type WorkPart,
} from '@/features/activity/workExport';
import { MIcon, md } from '@/features/home/md';
import { colors, fontWeight } from '@/shared/theme';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 📤 Export someone's work (or several people's): period, what, which file
// =====================================================================

type Period = ActivityPeriod | 'last_month' | 'custom';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
];

const FORMATS: { value: WorkFormat | 'pdf'; label: string; soon?: boolean }[] = [
  { value: 'xlsx', label: '📗 Excel' },
  { value: 'txt', label: '📄 Text' },
  { value: 'csv', label: '🧾 CSV (calls)' },
  { value: 'pdf', label: '📕 PDF', soon: true },
];

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function rangeOf(p: Period, from: string, to: string) {
  if (p === 'custom') return from <= to ? { from, to } : { from: to, to: from };
  if (p === 'last_month') {
    const now = new Date();
    return {
      from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  return activityRange(p);
}

export function ExportWorkSheet({
  people,
  onClose,
}: {
  /** One person (their own page / More) or several (Team activity) */
  people: { id: string; name: string }[];
  onClose: () => void;
}) {
  const lk = useActivityLookups();
  const [period, setPeriod] = useState<Period>('month');
  const today = ymd(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [parts, setParts] = useState<Set<WorkPart>>(new Set(WORK_PARTS.map((p) => p.key)));
  const [format, setFormat] = useState<WorkFormat>('xlsx');
  const [picked, setPicked] = useState<Set<string>>(new Set(people.map((p) => p.id)));
  const [together, setTogether] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const many = people.length > 1;
  const range = useMemo(() => rangeOf(period, from, to), [period, from, to]);

  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };

  const run = async () => {
    const chosen = people.filter((p) => picked.has(p.id));
    if (chosen.length === 0) return Alert.alert('Choose someone', 'Tick at least one person.');
    if (format !== 'csv' && parts.size === 0) return Alert.alert('Choose what', 'Tick at least one part.');
    try {
      const list: WorkData[] = [];
      for (let i = 0; i < chosen.length; i++) {
        setBusy(`Loading ${chosen[i].name}${chosen.length > 1 ? ` (${i + 1}/${chosen.length})` : ''}…`);
        list.push(await fetchWork(chosen[i].id, range.from, range.to));
      }
      setBusy('Making the file…');
      const span = range.from === range.to ? range.from : `${range.from}_${range.to}`;
      const make = async (group: WorkData[], label: string) => {
        const name = `work-${safeName(label)}-${span}.${format}`;
        const body =
          format === 'xlsx' ? toWorkbook(group, parts, lk) : format === 'csv' ? toCsv(group) : toText(group, parts, lk);
        await shareFile(name, body, format);
      };
      if (!many || together) await make(list, many ? 'team' : (list[0].person.name ?? 'user'));
      else for (const w of list) await make([w], w.person.name ?? 'user');
      onClose();
    } catch (e) {
      Alert.alert('Could not export', e instanceof Error ? e.message : '');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={s.flex} onPress={busy ? undefined : onClose} accessibilityLabel="Close" />
        <View style={s.sheet}>
          <View style={s.handle} />
          <View style={s.head}>
            <Text style={s.title}>📤 Export work</Text>
            <Pressable onPress={onClose} disabled={!!busy} hitSlop={10} accessibilityLabel="Close">
              <MIcon name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          <Text style={s.sub}>{many ? `${picked.size} of ${people.length} people` : people[0]?.name}</Text>

          <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
            <Text style={s.label}>PERIOD</Text>
            <View style={s.chips}>
              {PERIODS.map((p) => (
                <Chip key={p.value} label={p.label} on={period === p.value} onPress={() => setPeriod(p.value)} />
              ))}
            </View>
            {period === 'custom' && (
              <View style={s.dates}>
                <DateField label="From" value={from} onChange={setFrom} />
                <DateField label="To" value={to} onChange={setTo} />
              </View>
            )}
            <Text style={s.range}>{periodText(range.from, range.to)}</Text>

            <Text style={s.label}>WHAT</Text>
            <View style={s.chips}>
              {WORK_PARTS.map((p) => (
                <Chip
                  key={p.key}
                  label={p.label}
                  on={parts.has(p.key)}
                  check
                  disabled={format === 'csv'}
                  onPress={() => toggle(parts, p.key, setParts)}
                />
              ))}
            </View>
            {format === 'csv' && <Text style={s.hint}>A CSV file holds one table: the call log.</Text>}

            <Text style={s.label}>FILE</Text>
            <View style={s.chips}>
              {FORMATS.map((f) => (
                <Chip
                  key={f.value}
                  label={f.soon ? `${f.label} · soon` : f.label}
                  on={format === f.value}
                  disabled={f.soon}
                  onPress={() => !f.soon && setFormat(f.value as WorkFormat)}
                />
              ))}
            </View>

            {many && (
              <>
                <Text style={s.label}>PEOPLE</Text>
                <View style={s.chips}>
                  <Chip label="One file, everyone" on={together} onPress={() => setTogether(true)} />
                  <Chip label="A file for each person" on={!together} onPress={() => setTogether(false)} />
                </View>
                <View style={s.peopleHead}>
                  <Text style={s.hint}>{picked.size} ticked</Text>
                  <Pressable
                    onPress={() =>
                      setPicked(picked.size === people.length ? new Set() : new Set(people.map((p) => p.id)))
                    }
                    hitSlop={8}
                  >
                    <Text style={s.link}>{picked.size === people.length ? 'Untick all' : 'Tick all'}</Text>
                  </Pressable>
                </View>
                <View style={s.chips}>
                  {people.map((p) => (
                    <Chip
                      key={p.id}
                      label={p.name}
                      on={picked.has(p.id)}
                      check
                      onPress={() => toggle(picked, p.id, setPicked)}
                    />
                  ))}
                </View>
              </>
            )}
          </ScrollView>

          <Pressable
            onPress={run}
            disabled={!!busy}
            android_ripple={{ color: 'rgba(255,255,255,0.2)', foreground: true }}
            style={[s.go, !!busy && s.goBusy]}
            accessibilityRole="button"
          >
            {busy ? (
              <>
                <ActivityIndicator color="#FFFFFF" />
                <Text style={s.goText}>{busy}</Text>
              </>
            ) : (
              <>
                <MIcon name="file-download" size={20} color="#FFFFFF" />
                <Text style={s.goText}>Export{many && !together ? ` ${picked.size} files` : ''}</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Chip({
  label,
  on,
  onPress,
  check,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  check?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[s.chip, on && s.chipOn, disabled && s.chipOff]}
      accessibilityRole={check ? 'checkbox' : 'radio'}
      accessibilityState={check ? { checked: on } : { selected: on }}
    >
      {on && <MIcon name="check" size={15} color={md.onPrimaryC} />}
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

/** A date: the phone's date picker, or the browser's on the website */
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  if (Platform.OS === 'web') {
    return (
      <View style={s.dateBox}>
        <Text style={s.dateLabel}>{label}</Text>
        {createElement('input', {
          type: 'date',
          value,
          onChange: (e: { target: { value: string } }) => e.target.value && onChange(e.target.value),
          style: { fontSize: 15, padding: 6, borderRadius: 8, border: `1px solid ${md.outline}` },
        })}
      </View>
    );
  }
  const [y, m, d] = value.split('-').map(Number);
  return (
    <Pressable
      style={s.dateBox}
      onPress={() =>
        DateTimePickerAndroid.open({
          value: new Date(y, m - 1, d),
          mode: 'date',
          maximumDate: new Date(),
          onValueChange: (_e: unknown, date?: Date) => date && onChange(ymd(date)),
        })
      }
      accessibilityRole="button"
    >
      <Text style={s.dateLabel}>{label}</Text>
      <Text style={s.dateValue}>📅 {periodText(value, value)}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    paddingTop: 8,
    paddingBottom: 12,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: colors.surface,
  },
  handle: { alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: md.outline },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 10 },
  title: { flex: 1, fontSize: 18, fontWeight: fontWeight.bold, color: colors.text },
  sub: { paddingHorizontal: 18, marginTop: 2, fontSize: 13, color: colors.textMuted },
  body: { paddingHorizontal: 18, paddingBottom: 12 },
  label: {
    fontSize: 11.5,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
    color: colors.textMuted,
    marginTop: 16,
    marginBottom: 8,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: md.primaryC, borderColor: md.primaryC },
  chipOff: { opacity: 0.45 },
  chipText: { fontSize: 13, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: md.onPrimaryC },
  range: { marginTop: 8, fontSize: 13, fontWeight: fontWeight.semibold, color: colors.primary },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 6 },
  link: { fontSize: 13, fontWeight: fontWeight.semibold, color: colors.primary },
  peopleHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 6,
  },
  dates: { flexDirection: 'row', gap: 10, marginTop: 10 },
  dateBox: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: md.surface1, gap: 4 },
  dateLabel: { fontSize: 11.5, color: colors.textMuted },
  dateValue: { fontSize: 14, fontWeight: fontWeight.semibold, color: colors.text },
  go: {
    marginHorizontal: 18,
    marginTop: 8,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    overflow: 'hidden',
  },
  goBusy: { opacity: 0.85 },
  goText: { fontSize: 15, fontWeight: fontWeight.semibold, color: '#FFFFFF' },
});
