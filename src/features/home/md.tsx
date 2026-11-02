import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  Animated,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

// Old-architecture Android needs this for LayoutAnimation (a no-op elsewhere)
if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);

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

// ---------------------------------------------------------------------
// 📂 Fold: one line (icon, title, a short summary, ⌄); tap opens the
//   details. Each fold remembers on this phone whether it was open.
// ---------------------------------------------------------------------
const foldKey = (id: string) => `home_fold_${id}`;

export function Fold({
  id,
  icon,
  tint,
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  id: string;
  icon: MIconName;
  tint: { bg: string; fg: string };
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const turn = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;
  useEffect(() => {
    AsyncStorage.getItem(foldKey(id))
      .then((v) => {
        if (v == null) return;
        const o = v === '1';
        setOpen(o);
        turn.setValue(o ? 1 : 0);
      })
      .catch(() => undefined);
  }, [id, turn]);

  const toggle = () => {
    const next = !open;
    LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setOpen(next);
    Animated.timing(turn, { toValue: next ? 1 : 0, duration: 220, useNativeDriver: true }).start();
    AsyncStorage.setItem(foldKey(id), next ? '1' : '0').catch(() => undefined);
  };

  return (
    <View style={[card, foldStyles.fold]}>
      <Tap onPress={toggle} style={foldStyles.foldHead} label={`${title}${open ? ', open' : ''}`}>
        <View style={[foldStyles.foldIcon, { backgroundColor: tint.bg }]}>
          <MIcon name={icon} size={18} color={tint.fg} />
        </View>
        <Text style={foldStyles.foldTitle} numberOfLines={1}>
          {title}
        </Text>
        {summary != null && (
          <Text style={foldStyles.foldSummary} numberOfLines={1}>
            {summary}
          </Text>
        )}
        <Animated.View
          style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}
        >
          <MIcon name="expand-more" size={22} color={colors.textMuted} />
        </Animated.View>
      </Tap>
      {open && <View style={foldStyles.foldBody}>{children}</View>}
    </View>
  );
}

/** Bold numbers inside a fold's summary */
export function B({ children, tone }: { children: ReactNode; tone?: 'bad' | 'good' }) {
  return (
    <Text style={[foldStyles.b, tone === 'bad' && { color: md.onErrorC }, tone === 'good' && { color: md.onOkC }]}>
      {children}
    </Text>
  );
}

const foldStyles = StyleSheet.create({
  fold: { marginTop: 10 },
  foldHead: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 10 },
  foldIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  foldTitle: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  foldSummary: { fontSize: fontSize.caption, color: colors.textMuted, maxWidth: '50%' },
  foldBody: { borderTopWidth: 1, borderTopColor: md.surface2 },
  b: { fontWeight: fontWeight.semibold, color: colors.text },
});
