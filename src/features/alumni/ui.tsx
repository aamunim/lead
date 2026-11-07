import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, md } from '@/features/home/md';
import { useSavedState } from '@/shared/lib/saved';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

import { alumniAllows, getAlumniSettings } from './api';

// =====================================================================
// 🎓 Shared bits of the Alumni screens (Material 3: tonal cards, filter
//   chips, tonal avatars — the same look as Home)
// =====================================================================

/** Can I see / manage alumni? (last answer at once, then checked again) */
export function useAlumniAccess(): { view: boolean; manage: boolean } {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [access, setAccess] = useSavedState('alumni:access', { view: false, manage: false });
  useEffect(() => {
    const check = () =>
      getAlumniSettings()
        .then((s) => {
          const p = profile ? { id: profile.id, role_key: profile.role_key } : null;
          setAccess({ view: alumniAllows(s, p, isAdmin, 'view'), manage: alumniAllows(s, p, isAdmin, 'manage') });
        })
        .catch(() => undefined);
    check();
    const sub = AppState.addEventListener('change', (st) => st === 'active' && check());
    return () => sub.remove();
  }, [profile, isAdmin]);
  return access;
}

export function Chip({ text, on, onPress, count }: { text: string; on: boolean; onPress: () => void; count?: number }) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: md.ripple }}
      style={[s.chip, on && s.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      {on && <MIcon name="check" size={16} color={md.onPrimaryC} />}
      <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>
        {text}
        {count !== undefined ? ` · ${count}` : ''}
      </Text>
    </Pressable>
  );
}

// Tonal pairs (container / on-container), the same for a name every time
const TONES: [string, string][] = [
  [md.primaryC, md.onPrimaryC],
  [md.okC, md.onOkC],
  [md.peachC, md.onPeachC],
  [md.purpleC, md.onPurpleC],
  [md.skyC, md.onSkyC],
  [md.warnC, md.onWarnC],
  [md.waC, md.onWaC],
  [md.goldC, md.onGoldC],
];

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  // (×31 then % 8 gave every name the same colour: mix the bits well)
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const [bg, fg] = TONES[(h >>> 8) % TONES.length];
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      <Text style={[s.avatarText, { fontSize: size * 0.38, color: fg }]}>{initials || '?'}</Text>
    </View>
  );
}

export function Stat({ value, label, tint }: { value: string | number; label: string; tint?: string }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statValue, tint ? { color: tint } : null]}>{value}</Text>
      <Text style={s.statLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

/** "3 days ago" */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Re-load when an alumni screen changes something */
let version = 0;
const listeners = new Set<() => void>();
export function alumniChanged() {
  version++;
  listeners.forEach((l) => l());
}
export function useAlumniVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export const s = StyleSheet.create({
  // Material 3 filter chip
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  chipOn: { backgroundColor: md.primaryC, borderColor: md.primaryC, paddingLeft: spacing.sm },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.medium, color: colors.text },
  chipTextOn: { color: md.onPrimaryC, fontWeight: fontWeight.semibold },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: fontWeight.bold },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center' },
  // Material 3 filled card (tonal, no border)
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: md.surface1,
  },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 0.8, color: colors.primary },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  error: { fontSize: fontSize.small, color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
