import { router, usePathname, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { signOut } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { canSeeStudents, getStudentsSettings } from '@/features/students/api';
import { canUseWeb, getWebSettings } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐 The website's frame: a menu on the left, the page on the right.
//   Only the website's modules are in the menu; the phone-only parts
//   (call log, WhatsApp, camera, voice recording, push) are not here.
//   Settings → Website decides who may sign in here (admins always).
// =====================================================================

type Item = { label: string; icon: string; href: string; match: (path: string) => boolean };

export function WebShell({ children }: { children: React.ReactNode }) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const path = usePathname();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [students, setStudents] = useState(false);

  useEffect(() => {
    Promise.all([getWebSettings(), getStudentsSettings()])
      .then(([w, s]) => {
        setAllowed(canUseWeb(w, profile, isAdmin));
        setStudents(canSeeStudents(s, profile, isAdmin));
      })
      .catch(() => setAllowed(isAdmin));
  }, [profile, isAdmin]);

  const items: Item[] = [
    ...(students
      ? [
          {
            label: 'Students',
            icon: '🎓',
            href: '/students',
            // A student's page opens from the list
            match: (p: string) => p.startsWith('/students') || p.startsWith('/leads/'),
          },
        ]
      : []),
  ];

  if (allowed === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!allowed) {
    return (
      <View style={styles.center}>
        <Text style={styles.bigIcon}>🌐</Text>
        <Text style={styles.title}>The website is not open for you</Text>
        <Text style={styles.muted}>Please use the Lead Management app on your phone. An admin can allow you in Settings → Website.</Text>
        <Pressable onPress={() => signOut()} style={styles.signOutBig} accessibilityRole="button">
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.frame}>
      <View style={styles.side}>
        <Text style={styles.brand}>Lead Management</Text>
        <View style={styles.menu}>
          {items.map((it) => {
            const on = it.match(path);
            return (
              <Pressable
                key={it.href}
                onPress={() => router.navigate(it.href as Href)}
                // react-native-web also passes "hovered"
                style={(state) => [
                  styles.item,
                  on && styles.itemOn,
                  (state as { hovered?: boolean }).hovered && !on && styles.itemHover,
                ]}
                accessibilityRole="link"
                accessibilityState={{ selected: on }}
              >
                <Text style={styles.itemIcon}>{it.icon}</Text>
                <Text style={[styles.itemText, on && styles.itemTextOn]}>{it.label}</Text>
              </Pressable>
            );
          })}
          {items.length === 0 && (
            <Text style={styles.sideHint}>Nothing here for you yet. An admin can turn on the Students tab for you.</Text>
          )}
        </View>
        <View style={styles.flex} />
        <View style={styles.me}>
          <Text style={styles.meName} numberOfLines={1}>
            {profile?.full_name ?? ''}
          </Text>
          <Pressable onPress={() => signOut()} accessibilityRole="button" hitSlop={6}>
            <Text style={styles.link}>Sign out</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.main}>
        <View style={styles.page}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  frame: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  side: {
    width: 240,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  brand: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.primary, paddingHorizontal: spacing.sm },
  menu: { marginTop: spacing.xl, gap: spacing.xs },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  itemOn: { backgroundColor: colors.primarySoft },
  itemHover: { backgroundColor: colors.background },
  itemIcon: { fontSize: fontSize.body },
  itemText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  itemTextOn: { color: colors.primary },
  sideHint: { fontSize: fontSize.caption, color: colors.textMuted, paddingHorizontal: spacing.sm },
  me: { gap: spacing.xs, paddingHorizontal: spacing.sm, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  meName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  main: { flex: 1, alignItems: 'center' },
  // Phone-shaped screens read best at a comfortable width on a big monitor
  page: { flex: 1, width: '100%', maxWidth: 1100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  bigIcon: { fontSize: 48 },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  muted: { fontSize: fontSize.body, color: colors.textMuted, textAlign: 'center', maxWidth: 420 },
  signOutBig: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  signOutText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
});
