import { router, type Href } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useActivityLookups } from '@/features/activity/useLookups';
import { FeeCard } from '@/features/fees/FeeCard';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 💰 The lead page's Fee & discount card, in a sheet
//   (from the lead list's marked-lead buttons and the board's menu)
// =====================================================================

export type FeeSheetLead = {
  id: string;
  name: string;
  stageKind: string;
  courseIds: string[];
};

type Props = {
  lead: FeeSheetLead | null;
  onClose: () => void;
  /** Something changed (reload the list), with a short message */
  onChanged: (message?: string) => void;
};

export function FeeSheet({ lead, onClose, onChanged }: Props) {
  const { userNames } = useActivityLookups();
  const nameOf = (id: string | null | undefined) => (id ? userNames.get(id) ?? null : null);

  return (
    <Modal visible={!!lead} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {lead?.name}
            </Text>
            <Pressable
              onPress={() => {
                if (!lead) return;
                onClose();
                router.push(`/leads/${lead.id}` as Href);
              }}
              hitSlop={10}
              accessibilityRole="link"
            >
              <Text style={styles.link}>Open lead ›</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {lead && (
              <FeeCard
                leadId={lead.id}
                stageKind={lead.stageKind}
                leadCourseIds={lead.courseIds}
                stateKey={lead.id}
                nameOf={nameOf}
                showEmpty
                onChanged={onChanged}
              />
            )}
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
    maxHeight: '90%',
    backgroundColor: colors.background,
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { flex: 1, fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
});
