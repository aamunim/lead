import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { useSavedState } from '@/shared/lib/saved';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

import { alumniAllows, getAlumniSettings } from './api';

// =====================================================================
// 🎓 Shared bits of the Alumni screens
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
      style={[s.chip, on && s.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>
        {text}
        {count !== undefined ? ` · ${count}` : ''}
      </Text>
    </Pressable>
  );
}

const TINTS = ['#3557D4', '#0F9D58', '#E37400', '#8E24AA', '#00897B', '#C2185B', '#5D4037', '#1E88E5'];

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = TINTS[h % TINTS.length];
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      <Text style={[s.avatarText, { fontSize: size * 0.38 }]}>{initials || '?'}</Text>
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
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: fontWeight.bold },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center' },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  error: { fontSize: fontSize.small, color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
