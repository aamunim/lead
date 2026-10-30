import { type ReactNode } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// A card that opens and closes; the one-line summary shows when closed
// =====================================================================

type Props = {
  icon: string;
  title: string;
  /** Shown under the title (closed and open) */
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** A small coloured mark on the left edge */
  accent?: string;
  children: ReactNode;
};

export function Collapsible({ icon, title, summary, open, onToggle, accent, children }: Props) {
  return (
    <View style={[styles.card, accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : null]}>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
          onToggle();
        }}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
      >
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>{icon}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.title}>{title}</Text>
          {summary != null && (
            <Text style={styles.summary} numberOfLines={open ? undefined : 1}>
              {summary}
            </Text>
          )}
        </View>
        <Text style={[styles.chevron, open && styles.chevronOpen]}>›</Text>
      </Pressable>
      {open && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  pressed: { opacity: 0.75 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  icon: { fontSize: 18 },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  summary: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 22, color: colors.textMuted, transform: [{ rotate: '90deg' }] },
  chevronOpen: { transform: [{ rotate: '-90deg' }] },
  body: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
});
