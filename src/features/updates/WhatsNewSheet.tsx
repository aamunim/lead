import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { WHATS_NEW, type WhatsNew } from '@/features/updates/whatsNew';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🆕 After an update: "What's new" once (phone). More → What's new
//   opens it again with every entry.
// =====================================================================

const SEEN_KEY = 'whats_new_seen';

/** Shows itself once when the newest entry hasn't been seen on this phone */
export function WhatsNewOnUpdate() {
  const [show, setShow] = useState(false);
  const latest = WHATS_NEW[0];
  useEffect(() => {
    if (isWeb || !latest) return;
    AsyncStorage.getItem(SEEN_KEY)
      .then((seen) => {
        if (seen !== latest.key) setShow(true);
      })
      .catch(() => undefined);
  }, [latest]);
  if (!show || !latest) return null;
  return (
    <WhatsNewSheet
      entries={[latest]}
      onClose={() => {
        setShow(false);
        AsyncStorage.setItem(SEEN_KEY, latest.key).catch(() => undefined);
      }}
    />
  );
}

export function WhatsNewSheet({ entries = WHATS_NEW, onClose }: { entries?: WhatsNew[]; onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.back}>
        <View style={styles.box}>
          <Text style={styles.head}>🆕 What’s new</Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
            {entries.map((e) => (
              <View key={e.key} style={styles.entry}>
                <Text style={styles.title}>{e.title}</Text>
                <Text style={styles.date}>{e.date}</Text>
                {e.items.map((it, i) => (
                  <Text key={i} style={styles.item}>
                    {it}
                  </Text>
                ))}
              </View>
            ))}
          </ScrollView>
          <Button title="Got it" onPress={onClose} fullWidth />
        </View>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: {
    flex: 1,
    backgroundColor: 'rgba(16,26,51,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  box: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '80%',
    padding: spacing.xl,
    gap: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    zIndex: 1,
  },
  head: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  scroll: { flexGrow: 0 },
  list: { gap: spacing.lg },
  entry: { gap: spacing.xs },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  date: { fontSize: fontSize.caption, color: colors.textMuted, marginBottom: spacing.xs },
  item: { fontSize: fontSize.small, color: colors.text, lineHeight: 21 },
});
