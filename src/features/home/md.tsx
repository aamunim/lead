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

import { colors, fontSize, fontWeight, isDark } from '@/shared/theme';

// =====================================================================
// 🎨 Material 3 bits for the phone (Home, tab bar): tonal colours,
//   Material icons, a pressable with the Android ripple, a card and a
//   section header. Same look as a native (Kotlin) Android app.
// =====================================================================

export type MIconName = ComponentProps<typeof MaterialIcons>['name'];

/** Tonal colours (container / on-container pairs) — light and 🌙 dark */
const mdLight = {
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
  // more tones (avatars, tiles, cards)
  peachC: '#FFE0D6',
  onPeachC: '#9C2E00',
  purpleC: '#F3DDF8',
  onPurpleC: '#6A1B7A',
  waC: '#DCF8E6',
  onWaC: '#128C4A',
  skyC: '#E0F2FE',
  onSkyC: '#0369A1',
  /** 🏆 credits, streaks, "kept in place" */
  goldC: '#FFF4D6',
  onGoldC: '#7A4B00',
  gold: '#E8A100',
  /** your own row, a lead page header */
  meC: '#EEF2FF',
  heroC: '#E4E9FF',
  /** "📞 Rahim is on a call" */
  lockC: '#FDE7E7',
  onLockC: '#B42318',
  /** a search word found in a name */
  highlight: '#FEF08A',
  /** a WhatsApp message preview */
  waBubble: '#DCF8C6',
  waBubbleText: '#111B21',
  /** text on the tonal banners */
  warnText: '#2C1600',
  warnSub: '#5C3A00',
  primarySub: '#3A4A8A',
  okText: '#0B3A22',
  okSub: '#2D5A40',
  fire: '#C2410C',
};

const mdDark: typeof mdLight = {
  surface1: '#1A2236',
  surface2: '#222B41',
  outline: '#3A4560',
  primaryC: '#25336A',
  onPrimaryC: '#C9D4FF',
  errorC: '#4A1F1A',
  onErrorC: '#FFB4A9',
  warnC: '#43300F',
  onWarnC: '#FFCF8A',
  okC: '#173A27',
  onOkC: '#8FDCAE',
  ripple: 'rgba(160,180,255,0.16)',
  peachC: '#47261A',
  onPeachC: '#FFB59C',
  purpleC: '#3B2342',
  onPurpleC: '#EBB5F7',
  waC: '#163A26',
  onWaC: '#7FE0A6',
  skyC: '#13324A',
  onSkyC: '#9BD3F7',
  goldC: '#3A2E12',
  onGoldC: '#FFD98A',
  gold: '#E8A100',
  meC: '#1E2949',
  heroC: '#1C2647',
  lockC: '#4A1F1F',
  onLockC: '#FFB4AB',
  highlight: '#6B5B12',
  waBubble: '#1F3B2C',
  waBubbleText: '#E7EBF4',
  warnText: '#FFE2B8',
  warnSub: '#E9C48A',
  primarySub: '#AFC0FF',
  okText: '#C8F0D8',
  okSub: '#9CCFB2',
  fire: '#FB8A5A',
};

export const md = isDark ? mdDark : mdLight;

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
    [md.peachC, md.onPeachC],
    [md.okC, md.onOkC],
    [md.warnC, md.onWarnC],
    [md.purpleC, md.onPurpleC],
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
