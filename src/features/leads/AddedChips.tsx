import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  ADDED_DAYS,
  dayText,
  rangeText,
  type AddedChoice,
  type AddedDay,
  type LeadCreator,
} from '@/features/leads/added';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ➕ Leads tab chips: 👤 who added the leads, and when
//   (Today / Yesterday / This week / This month / 📅 Custom)
//   The person chip shows only when there is someone else to pick.
// =====================================================================

type Props = {
  choice: AddedChoice;
  onChange: (next: AddedChoice) => void;
  /** The people this user may pick (myself first) */
  creators: LeadCreator[];
  myId: string | null;
};

const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function AddedChips({ choice, onChange, creators, myId }: Props) {
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);

  const showPeople = creators.length > 1;
  const person = creators.find((c) => c.id === choice.userId);
  const personLabel = person ? (person.id === myId ? 'Me' : (person.name ?? 'No name')) : 'All users';

  const pickDay = (day: AddedDay) => {
    if (day === 'custom') {
      setRangeOpen(true);
      return;
    }
    onChange({ ...choice, day: choice.day === day ? null : day, from: undefined, to: undefined });
  };

  return (
    <>
      {showPeople && (
        <Pressable
          onPress={() => setPeopleOpen(true)}
          style={[styles.chip, !!choice.userId && styles.chipOn]}
          accessibilityRole="button"
          accessibilityLabel={`Added by: ${personLabel}. Change`}
        >
          <Ionicons name="person" size={12} color={choice.userId ? colors.surface : colors.textMuted} />
          <Text style={[styles.chipText, !!choice.userId && styles.chipTextOn]} numberOfLines={1}>
            {personLabel}
          </Text>
          <Ionicons name="chevron-down" size={12} color={choice.userId ? colors.surface : colors.textMuted} />
        </Pressable>
      )}

      {ADDED_DAYS.map((d) => {
        const on = choice.day === d.value;
        return (
          <Pressable
            key={d.value}
            onPress={() => pickDay(d.value)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityHint="Leads added in this period"
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{d.label}</Text>
          </Pressable>
        );
      })}

      <Pressable
        onPress={() => pickDay('custom')}
        style={[styles.chip, choice.day === 'custom' && styles.chipOn]}
        accessibilityRole="button"
        accessibilityState={{ selected: choice.day === 'custom' }}
      >
        <Text style={[styles.chipText, choice.day === 'custom' && styles.chipTextOn]}>
          📅 {choice.day === 'custom' && choice.from && choice.to ? rangeText(choice.from, choice.to) : 'Custom'}
        </Text>
      </Pressable>

      {/* 👤 Who added them */}
      <Modal visible={peopleOpen} transparent animationType="slide" onRequestClose={() => setPeopleOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={styles.flex} onPress={() => setPeopleOpen(false)} accessibilityLabel="Close" />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Leads added by</Text>
            <ScrollView contentContainerStyle={styles.list}>
              {[{ id: null, label: 'All users' }, ...creators.map((c) => ({
                id: c.id as string | null,
                label: `${c.id === myId ? 'Me' : (c.name ?? 'No name')}${c.is_active ? '' : ' (inactive)'}`,
              }))].map((row) => {
                const on = choice.userId === row.id;
                return (
                  <Pressable
                    key={row.id ?? 'all'}
                    onPress={() => {
                      setPeopleOpen(false);
                      onChange({ ...choice, userId: row.id });
                    }}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.rowText, on && styles.rowTextOn]}>{row.label}</Text>
                    {on && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {rangeOpen && (
        <RangeSheet
          from={choice.day === 'custom' ? choice.from : undefined}
          to={choice.day === 'custom' ? choice.to : undefined}
          onClose={() => setRangeOpen(false)}
          onPick={(from, to) => {
            setRangeOpen(false);
            onChange({ ...choice, day: 'custom', from, to });
          }}
        />
      )}
    </>
  );
}

// 📅 From – To (days only)
function RangeSheet({
  from: initialFrom,
  to: initialTo,
  onClose,
  onPick,
}: {
  from?: string;
  to?: string;
  onClose: () => void;
  onPick: (from: string, to: string) => void;
}) {
  const today = dayText(new Date());
  const [from, setFrom] = useState(initialFrom ?? today);
  const [to, setTo] = useState(initialTo ?? today);

  const set = (which: 'from' | 'to', d: Date) => {
    const v = dayText(d);
    if (which === 'from') {
      setFrom(v);
      if (v > to) setTo(v);
    } else {
      setTo(v);
      if (v < from) setFrom(v);
    }
  };

  const openAndroid = (which: 'from' | 'to') =>
    DateTimePickerAndroid.open({
      value: parse(which === 'from' ? from : to),
      mode: 'date',
      maximumDate: new Date(),
      onValueChange: (_e, d) => d && set(which, d),
    });

  const field = (which: 'from' | 'to', label: string) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {Platform.OS === 'android' ? (
        <Pressable onPress={() => openAndroid(which)} style={styles.dateBtn} accessibilityRole="button">
          <Text style={styles.dateText}>{rangeText(which === 'from' ? from : to, which === 'from' ? from : to)}</Text>
          <Ionicons name="calendar" size={16} color={colors.primary} />
        </Pressable>
      ) : (
        <DateTimePicker
          value={parse(which === 'from' ? from : to)}
          mode="date"
          display="compact"
          maximumDate={new Date()}
          onValueChange={(_e, d) => d && set(which, d)}
        />
      )}
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, styles.sheetPad]}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>Leads added between</Text>
          {field('from', 'From')}
          {field('to', 'To')}
          <Button title="Show" onPress={() => onPick(from, to)} fullWidth />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chip: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 180,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted, flexShrink: 1 },
  chipTextOn: { color: colors.surface },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '75%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xl,
  },
  sheetPad: { paddingHorizontal: spacing.lg, gap: spacing.md },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  sheetTitle: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  list: { paddingBottom: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  pressed: { opacity: 0.7 },
  rowText: { fontSize: fontSize.body, color: colors.text },
  rowTextOn: { fontWeight: fontWeight.bold, color: colors.primary },
  field: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  dateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateText: { fontSize: fontSize.body, color: colors.text },
});
