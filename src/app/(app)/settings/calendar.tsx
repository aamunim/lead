import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    deleteHoliday,
    getSetting,
    listHolidays,
    saveHoliday,
    updateSetting,
    type Holiday,
} from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// ISO weekdays: 1 = Monday … 7 = Sunday
const WEEKDAYS = [
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type WorkingHours = { start: string; end: string };

function dayCount(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

export default function CalendarSettingsScreen() {
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const [hours, setHours] = useState<WorkingHours>({ start: '09:00', end: '18:00' });
  const [year, setYear] = useState(new Date().getFullYear());
  const [holidays, setHolidays] = useState<Holiday[]>([]);

  const [loading, setLoading] = useState(true);
  const [savingWeek, setSavingWeek] = useState(false);
  const [weekMessage, setWeekMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Holiday> | null>(null);

  // --- load working days & hours once ---------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [days, wh] = await Promise.all([
          getSetting<number[]>('working_days'),
          getSetting<WorkingHours>('working_hours'),
        ]);
        if (Array.isArray(days)) setWorkingDays(days);
        if (wh?.start && wh?.end) setHours(wh);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load settings.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // --- load holidays whenever the year changes -----------------------
  const loadHolidays = useCallback(async () => {
    try {
      setHolidays(await listHolidays(year));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load holidays.');
    }
  }, [year]);

  useEffect(() => {
    loadHolidays();
  }, [loadHolidays]);

  // --- working week ---------------------------------------------------
  const toggleDay = (day: number) => {
    setWeekMessage(null);
    setWorkingDays((list) =>
      list.includes(day) ? list.filter((d) => d !== day) : [...list, day].sort(),
    );
  };

  const saveWeek = async () => {
    if (workingDays.length === 0) {
      setError('Choose at least one working day.');
      return;
    }
    if (!TIME_RE.test(hours.start) || !TIME_RE.test(hours.end)) {
      setError('Office hours must look like 09:00 and 18:00.');
      return;
    }
    if (hours.end <= hours.start) {
      setError('Closing time must be after opening time.');
      return;
    }

    setSavingWeek(true);
    setError(null);
    try {
      await Promise.all([
        updateSetting('working_days', workingDays),
        updateSetting('working_hours', hours),
      ]);
      setWeekMessage('Saved ✓');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSavingWeek(false);
    }
  };

  // --- holidays -------------------------------------------------------
  const confirmDelete = (holiday: Holiday) => {
    Alert.alert('Delete this holiday?', holiday.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteHoliday(holiday.id);
            loadHolidays();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not delete.');
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Working days & holidays' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const offDays = WEEKDAYS.filter((d) => !workingDays.includes(d.value)).map((d) => d.label);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Working days & holidays' }} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Working week */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Working days</Text>
          <Text style={styles.muted}>
            Tap a day to switch it on or off. Follow-ups and reminders skip days off.
          </Text>

          <View style={styles.days}>
            {WEEKDAYS.map((d) => {
              const on = workingDays.includes(d.value);
              return (
                <Pressable
                  key={d.value}
                  onPress={() => toggleDay(d.value)}
                  style={[styles.day, on ? styles.dayOn : styles.dayOff]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${d.label}, ${on ? 'working day' : 'day off'}`}
                >
                  <Text style={[styles.dayText, on && styles.dayTextOn]}>{d.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.muted}>
            Days off: {offDays.length > 0 ? offDays.join(', ') : 'none'}
          </Text>

          <Text style={[styles.sectionTitle, styles.spaced]}>Office hours</Text>
          <View style={styles.hoursRow}>
            <TextField
              label="Opens"
              value={hours.start}
              onChangeText={(v) => {
                setWeekMessage(null);
                setHours((h) => ({ ...h, start: v }));
              }}
              placeholder="09:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              containerStyle={styles.flex}
            />
            <TextField
              label="Closes"
              value={hours.end}
              onChangeText={(v) => {
                setWeekMessage(null);
                setHours((h) => ({ ...h, end: v }));
              }}
              placeholder="18:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              containerStyle={styles.flex}
            />
          </View>
          <Text style={styles.muted}>24-hour time. Escalation and alerts count working hours only.</Text>

          <Button
            title={weekMessage ?? 'Save working days & hours'}
            onPress={saveWeek}
            loading={savingWeek}
            fullWidth
          />
        </View>

        {/* Holidays */}
        <View style={styles.card}>
          <View style={styles.yearRow}>
            <Text style={styles.sectionTitle}>Holidays</Text>
            <View style={styles.yearPicker}>
              <Pressable onPress={() => setYear((y) => y - 1)} hitSlop={8} accessibilityLabel="Previous year">
                <Text style={styles.yearArrow}>‹</Text>
              </Pressable>
              <Text style={styles.year}>{year}</Text>
              <Pressable onPress={() => setYear((y) => y + 1)} hitSlop={8} accessibilityLabel="Next year">
                <Text style={styles.yearArrow}>›</Text>
              </Pressable>
            </View>
          </View>

          {holidays.length === 0 ? (
            <Text style={styles.muted}>No holidays added for {year}.</Text>
          ) : (
            holidays.map((h) => {
              const days = dayCount(h.start_date, h.end_date);
              return (
                <Pressable
                  key={h.id}
                  onPress={() => setDraft(h)}
                  onLongPress={() => confirmDelete(h)}
                  style={({ pressed }) => [
                    styles.holiday,
                    !h.is_active && styles.holidayOff,
                    pressed && styles.holidayPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityHint="Tap to edit, long press to delete"
                >
                  <View style={styles.flex}>
                    <Text style={styles.holidayName}>{h.name}</Text>
                    <Text style={styles.holidayDates}>
                      {h.start_date === h.end_date ? h.start_date : `${h.start_date} → ${h.end_date}`}
                    </Text>
                  </View>
                  <Text style={styles.dayBadge}>
                    {days} {days === 1 ? 'day' : 'days'}
                  </Text>
                </Pressable>
              );
            })
          )}

          {holidays.length > 0 && (
            <Text style={styles.muted}>Tap a holiday to edit. Long press to delete.</Text>
          )}

          <Button
            title="+ Add holiday"
            variant="secondary"
            onPress={() => setDraft({ is_active: true })}
          />
        </View>
      </ScrollView>

      {draft && (
        <HolidayModal
          initial={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            loadHolidays();
          }}
        />
      )}
    </View>
  );
}

// =====================================================================
// Add / edit a holiday
// =====================================================================
function HolidayModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Partial<Holiday>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [start, setStart] = useState(initial.start_date ?? '');
  const [end, setEnd] = useState(initial.end_date ?? '');
  const [isActive, setIsActive] = useState(initial.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const endDate = end.trim() || start.trim(); // one-day holiday if no end date

    if (!name.trim()) return setError('Please enter a name, e.g. Eid-ul-Fitr.');
    if (!DATE_RE.test(start.trim())) return setError('Start date must look like 2026-03-30.');
    if (!DATE_RE.test(endDate)) return setError('End date must look like 2026-04-02.');
    if (endDate < start.trim()) return setError('End date cannot be before the start date.');

    setSaving(true);
    setError(null);
    try {
      await saveHoliday({
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        start_date: start.trim(),
        end_date: endDate,
        is_active: isActive,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the holiday.');
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior="padding"
          style={styles.sheetWrap}
        >
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{initial.id ? 'Edit holiday' : 'New holiday'}</Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
                <Text style={styles.close}>✕</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <TextField label="Name" required value={name} onChangeText={setName} placeholder="e.g. Eid-ul-Fitr" />
              <TextField
                label="Start date"
                required
                value={start}
                onChangeText={setStart}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
              <TextField
                label="End date"
                value={end}
                onChangeText={setEnd}
                placeholder="YYYY-MM-DD"
                hint="Leave empty for a one-day holiday"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />

              <View style={styles.switchRow}>
                <View style={styles.flex}>
                  <Text style={styles.switchLabel}>Active</Text>
                  <Text style={styles.muted}>Switched-off holidays are ignored.</Text>
                </View>
                <Switch
                  value={isActive}
                  onValueChange={setIsActive}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Button title="Save holiday" onPress={handleSave} loading={saving} fullWidth />
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  spaced: { marginTop: spacing.sm },
  muted: { fontSize: fontSize.caption, color: colors.textMuted },
  days: { flexDirection: 'row', gap: spacing.xs },
  day: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
  },
  dayOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayOff: { backgroundColor: colors.surface, borderColor: colors.border },
  dayText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  dayTextOn: { color: colors.textOnPrimary },
  hoursRow: { flexDirection: 'row', gap: spacing.md },
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  yearPicker: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  yearArrow: { fontSize: fontSize.heading, color: colors.primary, paddingHorizontal: spacing.xs },
  year: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  holiday: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  holidayOff: { opacity: 0.5 },
  holidayPressed: { backgroundColor: colors.background },
  holidayName: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  holidayDates: { fontSize: fontSize.caption, color: colors.textMuted },
  dayBadge: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  // sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(11,19,40,0.45)', justifyContent: 'flex-end' },
  sheetWrap: { maxHeight: '90%' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  close: { fontSize: fontSize.title, color: colors.textMuted },
  sheetContent: { padding: spacing.lg, gap: spacing.lg },
});