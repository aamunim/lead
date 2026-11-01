import { router, useGlobalSearchParams, usePathname, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { signOut } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { canSeeStudents, getStudentsSettings } from '@/features/students/api';
import { canUseWeb, getWebSettings } from '@/features/web/api';
import { loadPref, onKey, savePref, typingInField } from '@/features/web/prefs';
import { installWebCss } from '@/shared/web/webCss';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐 The website's frame (for a computer screen)
//   Left: the menu (can be made narrow: icons only, remembered).
//   Top: the page name, one search box for students (Ctrl+K or /),
//   the signed-in person. Settings → Website decides who may sign in
//   here (admins always). The phone-only parts are not here.
// =====================================================================

installWebCss();

type Item = { label: string; icon: string; href: string; match: (path: string) => boolean };

const SMALL_KEY = 'web_side_small';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl + K  or  /', 'Search students'],
  ['J  or  ↓', 'Next student'],
  ['K  or  ↑', 'Previous student'],
  ['Enter', 'Open the student’s full page'],
  ['X', 'Tick / untick the student'],
  ['Esc', 'Close the panel or a dialog'],
  ['?', 'This list'],
];

function pageTitle(path: string): string {
  if (path.startsWith('/leads/edit/')) return 'Students › Edit';
  if (path.startsWith('/leads/')) return 'Students › Student';
  if (path.startsWith('/password')) return 'Change password';
  return 'Students';
}

export function WebShell({ children }: { children: React.ReactNode }) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const path = usePathname();
  const params = useGlobalSearchParams<{ q?: string }>();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [students, setStudents] = useState(false);
  const [small, setSmall] = useState(() => loadPref(SMALL_KEY, false));
  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '');
  const [help, setHelp] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // (the TextInput type here has no focus/blur, the web element has)
  const searchRef = useRef<{ focus: () => void; blur: () => void } | null>(null);

  useEffect(() => {
    Promise.all([getWebSettings(), getStudentsSettings()])
      .then(([w, s]) => {
        setAllowed(canUseWeb(w, profile, isAdmin));
        setStudents(canSeeStudents(s, profile, isAdmin));
      })
      .catch(() => setAllowed(isAdmin));
  }, [profile, isAdmin]);

  // Ctrl+K or / → search · ? → shortcuts
  useEffect(
    () =>
      onKey((e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          searchRef.current?.focus();
          return;
        }
        if (typingInField(e)) return;
        if (e.key === '/') {
          e.preventDefault();
          searchRef.current?.focus();
        } else if (e.key === '?') {
          setHelp(true);
        }
      }),
    [],
  );

  const onStudents = path === '/students' || path === '/';
  const search = (text: string) => {
    setQuery(text);
    if (onStudents) router.setParams({ q: text || undefined });
  };
  const submit = () => {
    if (!onStudents) router.navigate({ pathname: '/students', params: query ? { q: query } : {} } as Href);
  };

  const items: Item[] = students
    ? [
        {
          label: 'Students',
          icon: '🎓',
          href: '/students',
          // A student's page opens from the list
          match: (p: string) => p.startsWith('/students') || p.startsWith('/leads/'),
        },
      ]
    : [];

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
        <Text style={styles.muted}>
          Please use the Lead Management app on your phone. An admin can allow you in Settings → Website.
        </Text>
        <Pressable onPress={() => signOut()} style={styles.signOutBig} accessibilityRole="button">
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    );
  }

  const name = profile?.full_name ?? '';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

  return (
    <View style={styles.frame}>
      {/* ── Menu ─────────────────────────────────────────── */}
      <View style={[styles.side, small && styles.sideSmall]}>
        <View style={[styles.brandRow, small && styles.brandRowSmall]}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>LM</Text>
          </View>
          {!small && (
            <Text style={styles.brand} numberOfLines={1}>
              Lead Management
            </Text>
          )}
        </View>

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
                  small && styles.itemSmall,
                  on && styles.itemOn,
                  (state as { hovered?: boolean }).hovered && !on && styles.itemHover,
                ]}
                accessibilityRole="link"
                accessibilityLabel={it.label}
                accessibilityState={{ selected: on }}
              >
                {on && <View style={styles.itemBar} />}
                <Text style={styles.itemIcon}>{it.icon}</Text>
                {!small && <Text style={[styles.itemText, on && styles.itemTextOn]}>{it.label}</Text>}
              </Pressable>
            );
          })}
          {items.length === 0 && !small && (
            <Text style={styles.sideHint}>
              Nothing here for you yet. An admin can turn on the Students tab for you.
            </Text>
          )}
        </View>

        <View style={styles.flex} />
        <Pressable
          onPress={() => {
            setSmall(!small);
            savePref(SMALL_KEY, !small);
          }}
          style={(state) => [
            styles.item,
            small && styles.itemSmall,
            (state as { hovered?: boolean }).hovered && styles.itemHover,
          ]}
          accessibilityRole="button"
          accessibilityLabel={small ? 'Wider menu' : 'Narrow menu'}
        >
          <Text style={styles.itemIcon}>{small ? '»' : '«'}</Text>
          {!small && <Text style={styles.collapseText}>Narrow menu</Text>}
        </Pressable>
      </View>

      <View style={styles.main}>
        {/* ── Top bar ─────────────────────────────────────── */}
        <View style={styles.top}>
          <Text style={styles.pageTitle} numberOfLines={1}>
            {pageTitle(path)}
          </Text>

          <View style={styles.searchBox}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              ref={searchRef as never}
              value={query}
              onChangeText={search}
              onSubmitEditing={submit}
              placeholder="Search students: name, phone, College ID, NU ID…"
              placeholderTextColor={colors.textMuted}
              style={styles.searchInput}
              accessibilityLabel="Search students"
              onKeyPress={(e) => {
                if ((e.nativeEvent as { key?: string }).key === 'Escape') {
                  search('');
                  searchRef.current?.blur();
                }
              }}
            />
            {query ? (
              <Pressable onPress={() => search('')} hitSlop={8} accessibilityLabel="Clear search">
                <Text style={styles.clear}>✕</Text>
              </Pressable>
            ) : (
              <View style={styles.kbd}>
                <Text style={styles.kbdText}>Ctrl K</Text>
              </View>
            )}
          </View>

          <View style={styles.flex} />
          <Pressable
            onPress={() => setHelp(true)}
            style={(state) => [styles.iconBtn, (state as { hovered?: boolean }).hovered && styles.itemHover]}
            accessibilityRole="button"
            accessibilityLabel="Keyboard shortcuts"
          >
            <Text style={styles.iconBtnText}>⌨</Text>
          </Pressable>

          <View>
            <Pressable
              onPress={() => setMenuOpen(!menuOpen)}
              style={(state) => [styles.me, (state as { hovered?: boolean }).hovered && styles.itemHover]}
              accessibilityRole="button"
              accessibilityLabel="My account"
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials || '?'}</Text>
              </View>
              <Text style={styles.meName} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.caret}>▾</Text>
            </Pressable>
            {menuOpen && (
              <View style={styles.dropdown}>
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.navigate('/password' as Href);
                  }}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.itemHover]}
                  accessibilityRole="link"
                >
                  <Text style={styles.dropText}>🔐 Change password</Text>
                </Pressable>
                <Pressable
                  onPress={() => signOut()}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.itemHover]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.dropText, { color: colors.danger }]}>Sign out</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>

        <View style={styles.page}>{children}</View>
      </View>

      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </View>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.dialogBack} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.dialog} onPress={() => undefined}>
          <Text style={styles.dialogTitle}>⌨ Keyboard shortcuts</Text>
          {SHORTCUTS.map(([k, what]) => (
            <View key={k} style={styles.shortRow}>
              <View style={styles.kbdWide}>
                <Text style={styles.kbdText}>{k}</Text>
              </View>
              <Text style={styles.shortText}>{what}</Text>
            </View>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  frame: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },

  side: {
    width: 232,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    backgroundColor: '#101A33',
  },
  sideSmall: { width: 68, paddingHorizontal: spacing.sm },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs },
  brandRowSmall: { justifyContent: 'center', paddingHorizontal: 0 },
  logo: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: '#fff', fontWeight: fontWeight.bold, fontSize: fontSize.small },
  brand: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: '#fff' },
  menu: { marginTop: spacing.xl, gap: spacing.xs },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  itemSmall: { justifyContent: 'center', paddingHorizontal: 0 },
  itemOn: { backgroundColor: 'rgba(255,255,255,0.12)' },
  itemHover: { backgroundColor: 'rgba(127,140,170,0.16)' },
  itemBar: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  itemIcon: { fontSize: fontSize.body, color: '#C9D2E8' },
  itemText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: '#C9D2E8' },
  itemTextOn: { color: '#fff' },
  collapseText: { fontSize: fontSize.caption, color: '#8E9AB8' },
  sideHint: { fontSize: fontSize.caption, color: '#8E9AB8', paddingHorizontal: spacing.sm },

  main: { flex: 1, minWidth: 0 },
  top: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    zIndex: 10,
  },
  pageTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, minWidth: 120 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
    width: 460,
    height: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchIcon: { fontSize: fontSize.small },
  searchInput: { flex: 1, minWidth: 0, fontSize: fontSize.small, color: colors.text, outlineStyle: 'none' } as object,
  clear: { fontSize: fontSize.small, color: colors.textMuted, paddingHorizontal: spacing.xs },
  kbd: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  kbdWide: {
    width: 150,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  kbdText: { fontSize: 11, fontWeight: fontWeight.semibold, color: colors.textMuted },
  iconBtn: { width: 38, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  iconBtnText: { fontSize: fontSize.title, color: colors.textMuted },
  me: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  meName: { maxWidth: 160, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  caret: { fontSize: fontSize.caption, color: colors.textMuted },
  dropdown: {
    position: 'absolute',
    top: 46,
    right: 0,
    width: 210,
    padding: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  dropItem: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.sm },
  dropText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },

  page: { flex: 1, minHeight: 0 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  bigIcon: { fontSize: 48 },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  muted: { fontSize: fontSize.body, color: colors.textMuted, textAlign: 'center', maxWidth: 420 },
  signOutBig: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  signOutText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },

  dialogBack: {
    flex: 1,
    backgroundColor: 'rgba(16,26,51,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 440,
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  dialogTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.sm },
  shortRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  shortText: { fontSize: fontSize.small, color: colors.text },
});
