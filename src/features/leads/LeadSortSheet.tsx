import AsyncStorage from '@react-native-async-storage/async-storage';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_SORT, SORT_OPTIONS, type LeadSort } from '@/features/leads/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// ⇅ Sort for the leads list
//   The choice is kept on this phone only (not in saved filters).
// =====================================================================

const SORT_KEY = 'leads.sort';

/** The sort last chosen on this phone (or the default) */
export async function loadLeadSort(): Promise<LeadSort> {
  try {
    const saved = await AsyncStorage.getItem(SORT_KEY);
    return SORT_OPTIONS.some((o) => o.value === saved) ? (saved as LeadSort) : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveLeadSort(sort: LeadSort): void {
  AsyncStorage.setItem(SORT_KEY, sort).catch(() => undefined);
}

export const sortLabel = (sort: LeadSort) => SORT_OPTIONS.find((o) => o.value === sort)?.label ?? 'Next call';

type Props = {
  visible: boolean;
  value: LeadSort;
  onClose: () => void;
  onPick: (sort: LeadSort) => void;
};

export function LeadSortSheet({ visible, value, onClose, onPick }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>Sort leads</Text>
          <ScrollView contentContainerStyle={styles.list}>
            {SORT_OPTIONS.map((o) => {
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
  tick: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
});
