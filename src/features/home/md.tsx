import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { ComponentProps, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, fontSize, fontWeight } from '@/shared/theme';

// =====================================================================
// 🎨 Material 3 bits for the phone (Home, tab bar): tonal colours,
//   Material icons, a pressable with the Android ripple, a card and a
//   section header. Same look as a native (Kotlin) Android app.
// =====================================================================

export type MIconName = ComponentProps<typeof MaterialIcons>['name'];

/** Tonal colours (container / on-container pairs) */
export const md = {
  surface1: '#F0F2FA',
  surface2: '#E9ECF6',
  outline: '#C4C7D3',
  primaryC: '#DCE2FF',
  onPrimaryC: '#0F2A8A',
  errorC: '#FFDAD6',
  onErrorC: '#BA1A1A',
  warnC: '#FFE2B8',
  onWarnC: '#8A5300',
  okC: '#D3F0DE',
  onOkC: '#1F6B42',
  ripple: 'rgba(53,87,212,0.12)',
};

export function MIcon({ name, size = 24, color = colors.text }: { name: MIconName; size?: number; color?: string }) {
  return <MaterialIcons name={name} size={size} color={color} />;
}

/** A pressable with the Android ripple (and a light fade elsewhere) */
export function Tap({
  onPress,
  style,
  children,
  label,
  borderless,
  rippleColor = md.ripple,
}: {
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  label?: string;
  borderless?: boolean;
  rippleColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: rippleColor, borderless: !!borderless, foreground: true }}
      style={({ pressed }) => [style, Platform.OS !== 'android' && pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={borderless ? 8 : undefined}
    >
      {children}
    </Pressable>
  );
}

/** "Next calls  ·  See all" */
export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!action && (
        <Tap onPress={onAction} style={styles.sectionAction} label={action}>
          <Text style={styles.sectionActionText}>{action}</Text>
        </Tap>
      )}
    </View>
  );
}

/** An elevated card (white, 16 rounded, soft shadow) */
export const card: ViewStyle = {
  backgroundColor: colors.surface,
  borderRadius: 16,
  overflow: 'hidden',
  shadowColor: '#101840',
  shadowOpacity: 0.08,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
};

/** The colour circle with a person's first letter */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const pal = [
    [md.primaryC, md.onPrimaryC],
    ['#FFE0D6', '#9C2E00'],
    [md.okC, md.onOkC],
    [md.warnC, md.onWarnC],
    ['#F3DDF8', '#6A1B7A'],
  ];
  const i = [...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % pal.length;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: pal[i][0],
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: pal[i][1], fontSize: size * 0.4, fontWeight: fontWeight.semibold }}>
        {(name.trim()[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 22,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  sectionAction: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 16 },
  sectionActionText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});
