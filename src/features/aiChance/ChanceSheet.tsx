import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChanceCard } from '@/features/aiChance/ChanceCard';
import { ChanceChip } from '@/features/aiChance/ChanceChip';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🔮 From a list: the AI's chance, why, what to do and say, without
//   opening the lead. The answer is fetched only when the sheet opens,
//   so the lists stay as quick as before.
// =====================================================================

export function ChanceSheet({
  lead,
  onClose,
  onChanged,
}: {
  lead: { id: string; name: string };
  onClose: () => void;
  onChanged?: (message?: string) => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text style={styles.title} numberOfLines={1}>
              {lead.name}
            </Text>
            <Pressable
              onPress={() => {
                onClose();
                router.push(`/leads/${lead.id}` as Href);
              }}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={styles.open}>Open lead ›</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            <ChanceCard
              leadId={lead.id}
              stateKey="sheet"
              onChanged={(m) => {
                if (m) {
                  setToast(m);
                  setTimeout(() => setToast(null), 2000);
                }
                if (m && m !== 'Copied') onChanged?.(m);
              }}
            />
          </ScrollView>
          {!!toast && (
            <View style={styles.toast} pointerEvents="none">
              <Text style={styles.toastText}>{toast}</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** The 🔮 % chip on a card / table row: a tap opens the sheet */
export function ChanceChipButton({
  lead,
  chance,
  level,
  onChanged,
}: {
  lead: { id: string; name: string };
  chance: number;
  level: string | null;
  onChanged?: (message?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`AI chance ${chance} percent: why and what to say`}
      >
        <ChanceChip chance={chance} level={level} />
      </Pressable>
      {open && <ChanceSheet lead={lead} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '88%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  title: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  open: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  body: { paddingBottom: spacing.md },
  toast: {
    position: 'absolute',
    bottom: spacing.xl,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
  },
  toastText: { fontSize: fontSize.small, color: colors.background },
});
