import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LeadListItem } from '@/features/leads/api';
import { contactLabel } from '@/features/leads/contact';
import type { PipelineStage } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// Long press on a board card: move to a stage, admit / lost, call, …
// =====================================================================

export type BoardAction =
  | { type: 'move'; stage: PipelineStage }
  | { type: 'admit' | 'lost' | 'call' | 'followup' | 'note' | 'open' | 'handover' };

type Props = {
  lead: LeadListItem | null;
  /** Open stages, in board order */
  stages: PipelineStage[];
  /** May change this lead (move, admit, lost, next call) */
  canEdit: boolean;
  canAdmit: boolean;
  /** May give the lead to someone (hand over) */
  canHandOver: boolean;
  onClose: () => void;
  onPick: (action: BoardAction) => void;
};

export function BoardActionSheet({ lead, stages, canEdit, canAdmit, canHandOver, onClose, onPick }: Props) {
  const isOpen = (lead?.stage?.kind ?? 'open') === 'open';

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
            <Text style={styles.subtitle}>
              {lead ? contactLabel(lead) : ''}
              {lead?.stage ? ` · ${lead.stage.name}` : ''}
            </Text>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {/* Move to another stage */}
            {canEdit && isOpen && (
              <>
                <Text style={styles.label}>🚩 MOVE TO</Text>
                <View style={styles.chips}>
                  {stages.map((s) => {
                    const current = s.id === lead?.stage_id;
                    const marks = `${s.askDate ? ' 📅' : ''}${s.noteRequired ? ' ✎' : ''}`;
                    return (
                      <Pressable
                        key={s.id}
                        onPress={() => onPick({ type: 'move', stage: s })}
                        disabled={current}
                        style={({ pressed }) => [
                          styles.chip,
                          { borderColor: s.color },
                          current && { backgroundColor: s.color },
                          pressed && styles.pressed,
                        ]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: current, disabled: current }}
                        accessibilityLabel={`${current ? 'Now in' : 'Move to'} ${s.name}`}
                      >
                        <Text style={[styles.chipText, { color: current ? colors.textOnPrimary : s.color }]}>
                          {current ? '✓ ' : ''}
                          {s.name}
                          {marks}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.hint}>📅 = asks for a date · ✎ = needs a note</Text>
              </>
            )}

            <View style={styles.rows}>
              {canEdit && isOpen && canAdmit && (
                <Row icon="🎓" label="Mark admitted" onPress={() => onPick({ type: 'admit' })} />
              )}
              {canEdit && isOpen && (
                <Row icon="✕" label="Mark lost" color={colors.danger} onPress={() => onPick({ type: 'lost' })} />
              )}
              {!!lead?.phone && <Row icon="📞" label="Call" onPress={() => onPick({ type: 'call' })} />}
              {canEdit && <Row icon="⏰" label="Next call" onPress={() => onPick({ type: 'followup' })} />}
              {canEdit && canHandOver && (
                <Row icon="👥" label="Give to someone (hand over)" onPress={() => onPick({ type: 'handover' })} />
              )}
              <Row icon="📝" label="Add a note" onPress={() => onPick({ type: 'note' })} />
              <Row icon="👁" label="Open lead" onPress={() => onPick({ type: 'open' })} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Row({ icon, label, color, onPress }: { icon: string; label: string; color?: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Text style={styles.rowIcon}>{icon}</Text>
      <Text style={[styles.rowText, color && { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '85%',
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
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1.2, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  rows: { gap: spacing.xs, marginTop: spacing.sm },
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
  rowIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  rowText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  pressed: { opacity: 0.7 },
});
