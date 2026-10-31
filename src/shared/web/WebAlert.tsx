import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View, type AlertButton } from 'react-native';

import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 💬 Alert.alert on the website
//   In a browser React Native's Alert shows nothing, so every "Delete?"
//   and "Saved" would be lost. On the web, Alert.alert is pointed at this
//   small dialog instead (same title, message and buttons).
// =====================================================================

type Shown = { title: string; message?: string; buttons: AlertButton[] };

let queue: Shown[] = [];
const listeners = new Set<(q: Shown[]) => void>();
const emit = () => listeners.forEach((l) => l(queue));

/** Call once at start (web only) */
export function installWebAlert() {
  Alert.alert = (title, message, buttons) => {
    const list = (buttons ?? []) as AlertButton[];
    queue = [...queue, { title: title ?? '', message: message ?? undefined, buttons: list.length > 0 ? list : [{ text: 'OK' }] }];
    emit();
  };
}

export function WebAlertHost() {
  const [items, setItems] = useState<Shown[]>(queue);
  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  const current = items[0];
  if (!current) return null;

  const close = (b?: AlertButton) => {
    queue = queue.slice(1);
    emit();
    b?.onPress?.();
  };
  const cancel = current.buttons.find((b) => b.style === 'cancel');

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(cancel)}>
      <View style={styles.backdrop}>
        <View style={styles.box} accessibilityRole="alert">
          <Text style={styles.title}>{current.title}</Text>
          {!!current.message && <Text style={styles.message}>{current.message}</Text>}
          <View style={styles.buttons}>
            {current.buttons.map((b, i) => (
              <Pressable
                key={`${b.text}-${i}`}
                onPress={() => close(b)}
                style={(state) => [
                  styles.button,
                  b.style === 'cancel' && styles.cancel,
                  b.style === 'destructive' && styles.destructive,
                  (state.pressed || (state as { hovered?: boolean }).hovered) && styles.hover,
                ]}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.buttonText,
                    b.style === 'cancel' && styles.cancelText,
                    b.style === 'destructive' && styles.destructiveText,
                  ]}
                >
                  {b.text ?? 'OK'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  box: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  message: { fontSize: fontSize.body, color: colors.textMuted },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  cancel: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  destructive: { backgroundColor: colors.danger },
  hover: { opacity: 0.85 },
  buttonText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.textOnPrimary },
  cancelText: { color: colors.text },
  destructiveText: { color: colors.textOnPrimary },
});
