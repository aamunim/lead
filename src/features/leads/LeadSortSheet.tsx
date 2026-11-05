import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Modal } from '@/shared/ui/Modal';

import {
  DEFAULT_SORT,
  DEFAULT_STUDENT_SORT,
  SORT_OPTIONS,
  STUDENT_SORT_OPTIONS,
  type LeadSort,
} from '@/features/leads/api';
import { md } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// ⇅ Sort for the leads list
//   The choice is kept on this phone only (not in saved filters).
// =====================================================================

const SORT_KEY = 'leads.sort';
const STUDENT_SORT_KEY = 'students.sort';

const optionsFor = (students: boolean) => (students ? STUDENT_SORT_OPTIONS : SORT_OPTIONS);
export const defaultSortFor = (students: boolean) => (students ? DEFAULT_STUDENT_SORT : DEFAULT_SORT);

/** The sort last chosen on this phone (or the default); the Students list keeps its own */
export async function loadLeadSort(students = false): Promise<LeadSort> {
  try {
    const saved = await AsyncStorage.getItem(students ? STUDENT_SORT_KEY : SORT_KEY);
    return optionsFor(students).some((o) => o.value === saved) ? (saved as LeadSort) : defaultSortFor(students);
  } catch {
    return defaultSortFor(students);
  }
}

export function saveLeadSort(sort: LeadSort, students = false): void {
  AsyncStorage.setItem(students ? STUDENT_SORT_KEY : SORT_KEY, sort).catch(() => undefined);
}

// 📌 Keep in place: after a call, note or change a lead stays where it is
//   (on for everyone at first; each phone remembers its own choice)
const KEEP_KEY = 'leads.keepInPlace';

export async function loadKeepInPlace(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEEP_KEY)) !== 'off';
  } catch {
    return true;
  }
}

export function saveKeepInPlace(on: boolean): void {
  AsyncStorage.setItem(KEEP_KEY, on ? 'on' : 'off').catch(() => undefined);
}

export const sortLabel = (sort: LeadSort, students = false) =>
  optionsFor(students).find((o) => o.value === sort)?.label ?? 'Next call';

type Props = {
  visible: boolean;
  value: LeadSort;
  onClose: () => void;
  onPick: (sort: LeadSort) => void;
  /** The Students list: its own sorts */
  students?: boolean;
  /** 📌 Keep in place (left out = no switch) */
  keep?: boolean;
  onKeep?: (on: boolean) => void;
};

export function LeadSortSheet({ visible, value, onClose, onPick, students = false, keep, onKeep }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>{students ? 'Sort students' : 'Sort leads'}</Text>
          <ScrollView contentContainerStyle={styles.list}>
            {onKeep && (
              <Pressable
                onPress={() => onKeep(!keep)}
                style={[styles.row, styles.keep, keep && styles.keepOn]}
                accessibilityRole="switch"
                accessibilityState={{ checked: !!keep }}
              >
                <Text style={styles.icon}>📌</Text>
                <View style={styles.flex}>
                  <Text style={styles.label}>Keep in place</Text>
                  <Text style={styles.text}>
                    After a call, note or stage change the {students ? 'student' : 'lead'} stays where it is. Pull down
                    or tap ↻ Re-sort to sort again.
                  </Text>
                </View>
                <Switch value={!!keep} onValueChange={onKeep} />
              </Pressable>
            )}
            {optionsFor(students).map((o) => {
              const on = o.value === value;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => onPick(o.value)}
                  style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.pressed]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={styles.icon}>{o.icon}</Text>
                  <View style={styles.flex}>
                    <Text style={[styles.label, on && styles.labelOn]}>{o.label}</Text>
                    <Text style={styles.text}>{o.text}</Text>
                  </View>
                  {on && <Text style={styles.tick}>✓</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '80%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  pressed: { opacity: 0.7 },
  icon: { fontSize: 18 },
  label: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  labelOn: { color: colors.primary },
  text: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  keep: { marginBottom: spacing.sm },
  keepOn: { borderColor: md.gold, backgroundColor: md.goldC },
  tick: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
});
