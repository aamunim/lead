import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

type Props = {
  /** Button text */
  title?: string;
  /** Date the picker opens on */
  initial?: Date;
  /** Earliest allowed date (default: now) */
  minimumDate?: Date;
  disabled?: boolean;
  /** Called with the chosen date and time */
  onPick: (date: Date) => void;
};

/** A next-hour default: e.g. 3:20 PM → 4:00 PM */
function nextHour(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

/**
 * A small button that asks for a date, then a time.
 *   - Android: the phone's own date dialog, then the time dialog
 *   - iPhone: one sheet with a date + time picker
 *
 * Uses onValueChange (a value was chosen) instead of the old onChange.
 * Closing a dialog without choosing simply does nothing.
 */
export function DateTimePickerButton({
  title = '📅 Pick date & time',
  initial,
  minimumDate,
  disabled,
  onPick,
}: Props) {
  const [iosOpen, setIosOpen] = useState(false);
  const [iosValue, setIosValue] = useState<Date>(initial ?? nextHour());

  const min = minimumDate ?? new Date();

  const openAndroid = () => {
    const start = initial ?? nextHour();

    // 1) date
    DateTimePickerAndroid.open({
      value: start,
      mode: 'date',
      minimumDate: min,
      onValueChange: (_event, date) => {
        if (!date) return;

        // 2) time
        DateTimePickerAndroid.open({
          value: start,
          mode: 'time',
          is24Hour: false,
          onValueChange: (_timeEvent, time) => {
            if (!time) return;
            const picked = new Date(date);
            picked.setHours(time.getHours(), time.getMinutes(), 0, 0);
            onPick(picked < min ? min : picked);
          },
        });
      },
    });
  };

  const handlePress = () => {
    if (Platform.OS === 'android') {
      openAndroid();
    } else {
      setIosValue(initial ?? nextHour());
      setIosOpen(true);
    }
  };

  return (
    <>
      <Pressable
        onPress={handlePress}
        disabled={disabled}
        style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="Pick a date and time"
      >
        <Text style={styles.buttonText}>{title}</Text>
      </Pressable>

      {/* iPhone only */}
      {Platform.OS === 'ios' && (
        <Modal visible={iosOpen} transparent animationType="slide" onRequestClose={() => setIosOpen(false)}>
          <View style={styles.backdrop}>
            <Pressable style={styles.flex} onPress={() => setIosOpen(false)} accessibilityLabel="Close" />
            <View style={styles.sheet}>
              <View style={styles.sheetHeader}>
                <Pressable onPress={() => setIosOpen(false)} hitSlop={10} accessibilityRole="button">
                  <Text style={styles.cancel}>Cancel</Text>
                </Pressable>
                <Text style={styles.sheetTitle}>Pick date & time</Text>
                <Pressable
                  onPress={() => {
                    setIosOpen(false);
                    onPick(iosValue < min ? min : iosValue);
                  }}
                  hitSlop={10}
                  accessibilityRole="button"
                >
                  <Text style={styles.done}>Done</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={iosValue}
                mode="datetime"
                display="inline"
                minimumDate={min}
                onValueChange={(_event, d) => d && setIosValue(d)}
              />
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignSelf: 'flex-start',
  },
  buttonText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xxl,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  cancel: { fontSize: fontSize.body, color: colors.textMuted },
  done: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
});