import { StyleSheet, Text, View } from 'react-native';

import type { ChanceOnRow } from '@/features/aiChance/api';
import { colors, fontSize, fontWeight, radius } from '@/shared/theme';

// =====================================================================
// 🔮 The small AI chance chip on lead cards / the web table. Where the AI
//   has looked at a lead, it takes the place of the rule-based score.
// =====================================================================

/** The AI chance to show on this row (open leads only), or null */
export function aiChanceOf(lead: {
  lead_chances?: ChanceOnRow;
  stage?: { kind?: string | null } | null;
}): { chance: number; level: string | null } | null {
  const c = lead.lead_chances;
  if (!c || c.chance == null) return null;
  if ((lead.stage?.kind ?? 'open') !== 'open') return null;
  return { chance: c.chance, level: c.level };
}

export function ChanceChip({ chance, level }: { chance: number; level: string | null }) {
  const color = level === 'hot' ? colors.success : level === 'warm' ? colors.warning : colors.textMuted;
  return (
    <View style={[styles.chip, { borderColor: color }]} accessibilityLabel={`AI chance of admission ${chance} percent`}>
      <Text style={[styles.text, { color }]}>🔮 {chance}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, borderWidth: 1 },
  text: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
});
