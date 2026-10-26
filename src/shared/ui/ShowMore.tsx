import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

/**
 * Show only the first `first` items of a list until "View more" is tapped.
 *   const more = useShowMore(calls, 3);
 *   more.visible.map(...)
 *   <ShowMoreButton {...more} />
 */
export function useShowMore<T>(items: T[], first: number) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, items.length - first);
  return {
    visible: expanded ? items : items.slice(0, first),
    expanded,
    hidden,
    toggle: () => setExpanded((e) => !e),
  };
}

/** "View more (12)" / "Show less". Shows nothing when nothing is hidden. */
export function ShowMoreButton({
  expanded,
  hidden,
  toggle,
  label = 'View more',
}: {
  expanded: boolean;
  hidden: number;
  toggle: () => void;
  /** Use when the hidden part is not a count of items (e.g. more details) */
  label?: string;
}) {
  if (hidden <= 0) return null;
  return (
    <Pressable
      onPress={toggle}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
    >
      <Text style={styles.text}>
        {expanded ? 'Show less' : label === 'View more' ? `View more (${hidden})` : label}
      </Text>
      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.6 },
  text: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
