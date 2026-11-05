import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { dayTime } from '@/features/feedback/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Modal } from '@/shared/ui/Modal';

// ℹ️ The developer's look at a person's phone and app (from their newest topic)
const LABELS: Record<string, string> = {
  app: '📱 App',
  update: '⬇ Update',
  update_at: '🕘 Update made',
  phone: '📞 Phone',
  android: '🤖 Android',
  screen: '🖥 Screen',
};

export function PersonInfo({ chatUser, name, onClose }: { chatUser: string; name: string; onClose: () => void }) {
  const [rows, setRows] = useState<{ at: Date; info: Record<string, string> } | null | undefined>(undefined);

  useEffect(() => {
    supabase
      .from('feedback')
      .select('info, created_at')
      .eq('user_id', chatUser)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) =>
        setRows(data ? { at: new Date(data.created_at), info: (data.info ?? {}) as Record<string, string> } : null),
      );
  }, [chatUser]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.back} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.box} onPress={() => undefined}>
          <Text style={styles.title}>ℹ️ {name}</Text>
          {rows === undefined ? (
            <ActivityIndicator color={colors.primary} />
          ) : rows === null ? (
            <Text style={styles.muted}>No topic yet, so no phone details.</Text>
          ) : (
            <>
              <Text style={styles.muted}>From the newest topic · {dayTime(rows.at)}</Text>
              {Object.entries(rows.info).map(([k, v]) => (
                <View key={k} style={styles.row}>
                  <Text style={styles.key}>{LABELS[k] ?? k}</Text>
                  <Text style={styles.value} selectable>
                    {k === 'update_at' ? dayTime(new Date(v)) : v}
                  </Text>
                </View>
              ))}
            </>
          )}
          <Pressable onPress={onClose} style={styles.close} accessibilityRole="button">
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  box: {
    width: '100%',
    maxWidth: 420,
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.caption, color: colors.textMuted },
  row: { flexDirection: 'row', gap: spacing.md },
  key: { width: 120, fontSize: fontSize.small, color: colors.textMuted },
  value: { flex: 1, fontSize: fontSize.small, color: colors.text, fontWeight: fontWeight.semibold },
  close: { alignSelf: 'flex-end', paddingVertical: 6, paddingHorizontal: spacing.md },
  closeText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
});
