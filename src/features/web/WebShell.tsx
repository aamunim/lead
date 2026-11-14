import { router, useGlobalSearchParams, usePathname, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import Constants from 'expo-constants';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { signOut } from '@/features/auth/api';
import { useAlumniAccess } from '@/features/alumni/ui';
import { canSendSms } from '@/features/sms/api';
import { canSeeContribution } from '@/features/contribution/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { canSeeStudents, getStudentsSettings } from '@/features/students/api';
import { canApprove, countWaitingApproval, getApprovalSettings } from '@/features/approval/api';
import { chatUnread } from '@/features/feedback/chat';
import { canUseWeb, getWebSettings } from '@/features/web/api';
import { canOpenActivity, getActivitySettings } from '@/features/activity/api';
import { canSeeReports, getReportSettings } from '@/features/reports/api';
import { copyrightLine, logoSource, useBrand } from '@/features/brand/brand';
import { loadPref, onKey, savePref, typingInField } from '@/features/web/prefs';
import { installWebCss } from '@/shared/web/webCss';
import {
  WEB_THEME_KEY,
  colors,
  fontSize,
  fontWeight,
  isDark,
  radius,
  spacing,
  webThemeChoice,
  type WebTheme,
} from '@/shared/theme';

// =====================================================================
// 🌐 The website's frame (for a computer screen)
//   Left: the menu (can be made narrow: icons only, remembered).
//   Top: the page name, one search box for students (Ctrl+K or /),
//   the signed-in person. Settings → Website decides who may sign in
//   here (admins always). The phone-only parts are not here.
// =====================================================================

installWebCss();

type Item = { label: string; icon: string; href: string; match: (path: string) => boolean; badge?: number };

export const LOGO = require('../../../assets/web/ittc-logo-192.png');
const VERSION = Constants.expoConfig?.version ?? '';

const THEMES: { key: WebTheme; icon: string; label: string }[] = [
  { key: 'system', icon: '🖥', label: 'System (like this computer)' },
  { key: 'light', icon: '☀️', label: 'Light' },
  { key: 'dark', icon: '🌙', label: 'Dark' },
];

/** A new colour choice: remembered, then the page reloads with it */
function pickTheme(t: WebTheme) {
  savePref(WEB_THEME_KEY, t);
  window.location.reload();
}

/** How often the Admission Officer's "waiting" count is checked */
const WAITING_EVERY_MS = 60_000;

const SMALL_KEY = 'web_side_small';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl + K  or  /', 'Search (leads or students)'],
  ['J  or  ↓', 'Next student'],
  ['K  or  ↑', 'Previous student'],
  ['Enter', 'Open the student’s full page'],
  ['X', 'Tick / untick the student'],
  ['Esc', 'Close the panel or a dialog'],
  ['?', 'This list'],
];

function pageTitle(path: string): string {
  if (path.startsWith('/leads/merge')) return 'Leads › Merge leads';
  if (path.startsWith('/leads/duplicates')) return 'Leads › Possible duplicates';
  if (path.startsWith('/leads/edit/new')) return 'Leads › New lead';
  if (path.startsWith('/leads/edit/')) return 'Leads › Edit';
  if (path.startsWith('/leads/')) return 'Leads › Lead';
  if (path === '/leads') return 'Leads';
  if (path.startsWith('/activity')) return 'Team activity';
  if (path.startsWith('/changes')) return 'Change log';
  if (path.startsWith('/reports')) return 'Reports';
  if (path.startsWith('/import')) return 'Leads › Import';
  if (path.startsWith('/password')) return 'Change password';
  if (path.startsWith('/settings/uploads')) return 'Settings › Upload rules';
  if (path.startsWith('/photo-studio')) return 'Photo Studio';
  if (path.startsWith('/scorecard')) return 'Weekly scorecard';
  if (path.startsWith('/contribution')) return 'Admission Contribution';
  if (path === '/sms') return 'SMS Center';
  if (path.startsWith('/alumni/sms')) return 'SMS sent';
  if (path.startsWith('/alumni/referrals')) return 'Referral inbox';
  if (path.startsWith('/alumni')) return 'Alumni';
  if (path.startsWith('/bank')) return 'Lead Bank';
  if (path.startsWith('/supervisor/chat')) return 'Supervisor › AI chat';
  if (path.startsWith('/supervisor')) return 'Supervisor';
  if (path.startsWith('/settings/supervisor-targets')) return 'Settings › Admission targets';
  if (path.startsWith('/settings/supervisor-playbook')) return 'Settings › Objection answers';
  if (path.startsWith('/settings/supervisor')) return 'Settings › Supervisor';
  if (path.startsWith('/feedback')) return 'Contact developer';
  if (path.startsWith('/settings/roles')) return 'Settings › Roles';
  if (path.startsWith('/speed')) return 'Speed check';
  if (path.startsWith('/push-health')) return 'Push health';
  if (path.startsWith('/push-check')) return 'Notification check';
  return 'Students';
}

export function WebShell({ children }: { children: React.ReactNode }) {
  const { profile, hasPermission } = useAuth();
  const brand = useBrand();
  const isAdmin = hasPermission('settings.manage');
  const path = usePathname();
  const params = useGlobalSearchParams<{ q?: string }>();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [students, setStudents] = useState(false);
  const alumni = useAlumniAccess();
  // 📨 SMS Center (Settings → SMS → who may send)
  const [smsOk, setSmsOk] = useState(false);
  useEffect(() => {
    canSendSms().then(setSmsOk);
  }, []);
  const [small, setSmall] = useState(() => loadPref(SMALL_KEY, false));
  const [query, setQuery] = useState(typeof params.q === 'string' ? params.q : '');
  const [help, setHelp] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const theme = webThemeChoice();

  // 💬 Unread messages from / to the developer
  const [chatNew, setChatNew] = useState(0);
  useEffect(() => {
    let live = true;
    const check = () =>
      chatUnread()
        .then((n) => live && setChatNew(n))
        .catch(() => undefined);
    check();
    const t = setInterval(check, 60000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // 🔔 Admission Officer: how many are ready for ITTC (badge), and a note when more come
  const [officer, setOfficer] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [newOnes, setNewOnes] = useState(0);
  const lastWaiting = useRef<number | null>(null);
  useEffect(() => {
    getApprovalSettings()
      .then((s) => setOfficer(canApprove(s, profile, isAdmin)))
      .catch(() => setOfficer(false));
  }, [profile, isAdmin]);
  useEffect(() => {
    if (!officer) return;
    let live = true;
    const check = () =>
      countWaitingApproval()
        .then((n) => {
          if (!live) return;
          if (lastWaiting.current != null && n > lastWaiting.current) setNewOnes(n - lastWaiting.current);
          lastWaiting.current = n;
          setWaiting(n);
        })
        .catch(() => undefined);
    check();
    const timer = setInterval(check, WAITING_EVERY_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [officer]);
  // (the TextInput type here has no focus/blur, the web element has)
  const searchRef = useRef<{ focus: () => void; blur: () => void } | null>(null);

  // ⏱ Team activity / Change log and 📊 Reports: the phone's rules
  const [activityOk, setActivityOk] = useState(false);
  const [reportsOk, setReportsOk] = useState(false);
  // 🤝 Admission Contribution (Settings → AI → who sees the shares)
  const [contribOk, setContribOk] = useState(false);
  useEffect(() => {
    canSeeContribution()
      .then(setContribOk)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    getActivitySettings()
      .then((a) => setActivityOk(canOpenActivity(a, hasPermission)))
      .catch(() => setActivityOk(false));
    getReportSettings()
      .then((r) => setReportsOk(canSeeReports(r, profile, isAdmin)))
      .catch(() => setReportsOk(false));
  }, [profile, isAdmin, hasPermission]);

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

  // The browser tab's name
  useEffect(() => {
    document.title = `${pageTitle(path).split(' › ').pop()} · ${brand.short_name} Admission`;
  }, [path, brand.short_name]);

  // The search box filters the list that is open (Leads or Students)
  const onLeads = path === '/leads';
  const onStudents = path === '/students' || path === '/' || onLeads;
  const search = (text: string) => {
    setQuery(text);
    if (onStudents) router.setParams({ q: text || undefined });
  };
  const submit = () => {
    if (!onStudents) router.navigate({ pathname: '/students', params: query ? { q: query } : {} } as Href);
  };

  const items: Item[] = [
    // 📋 Leads: as on the phone (each person sees the leads they may)
    {
      label: 'Leads',
      icon: '📋',
      href: '/leads',
      match: (p: string) =>
        p === '/leads' || (p.startsWith('/leads/') && !p.startsWith('/leads/duplicates')) || p.startsWith('/import'),
    },
    ...(students
      ? [
          {
            label: 'Students',
            icon: '🎓',
            href: '/students',
            // A student's page opens from the list
            match: (p: string) => p.startsWith('/students'),
            badge: officer && waiting ? waiting : undefined,
          },
        ]
      : []),
    ...(alumni.view
      ? [{ label: 'Alumni', icon: '🧑‍🎓', href: '/alumni', match: (p: string) => p.startsWith('/alumni') }]
      : []),
    ...(smsOk ? [{ label: 'SMS Center', icon: '📨', href: '/sms', match: (p: string) => p === '/sms' }] : []),
    // 🧑‍💼 Supervisor: everyone
    { label: 'Supervisor', icon: '🧑‍💼', href: '/supervisor', match: (p: string) => p.startsWith('/supervisor') },
    // 🏦 Lead Bank: admins
    ...(isAdmin
      ? [{ label: 'Lead Bank', icon: '🏦', href: '/bank', match: (p: string) => p.startsWith('/bank') }]
      : []),
    // 🔗 the same person as two leads: people who may merge
    ...(hasPermission('leads.merge')
      ? [
          {
            label: 'Duplicates',
            icon: '🔗',
            href: '/leads/duplicates',
            match: (p: string) => p.startsWith('/leads/duplicates'),
          },
        ]
      : []),
    ...(reportsOk
      ? [{ label: 'Reports', icon: '📊', href: '/reports', match: (p: string) => p.startsWith('/reports') }]
      : []),
    ...(activityOk
      ? [
          { label: 'Team activity', icon: '⏱', href: '/activity', match: (p: string) => p.startsWith('/activity') },
          { label: 'Change log', icon: '📜', href: '/changes', match: (p: string) => p.startsWith('/changes') },
        ]
      : []),
    ...(contribOk
      ? [
          {
            label: 'Admission Contribution',
            icon: '🤝',
            href: '/contribution',
            match: (p: string) => p.startsWith('/contribution'),
          },
        ]
      : []),
    { label: 'Leaderboard', icon: '🏆', href: '/leaderboard', match: (p: string) => p.startsWith('/leaderboard') },
    {
      label: 'Scorecard',
      icon: '🏁',
      href: '/scorecard',
      match: (p: string) => p.startsWith('/scorecard'),
    },
    // 💬 The chat with the developer (the developer: everyone's chats)
    {
      label: 'Contact developer',
      icon: '💬',
      href: '/feedback',
      match: (p: string) => p.startsWith('/feedback'),
      badge: chatNew > 0 ? chatNew : undefined,
    },
    // ⚙️ Admins and the Admission Officer
    ...(isAdmin || officer
      ? [
          {
            label: 'Upload rules',
            icon: '📎',
            href: '/settings/uploads',
            match: (p: string) => p.startsWith('/settings/uploads'),
          },
          {
            label: 'Photo Studio',
            icon: '🖼',
            href: '/photo-studio',
            match: (p: string) => p.startsWith('/photo-studio'),
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
        <Text style={styles.muted}>
          This is the {brand.system}. Please use the app on your phone, or ask an admin to allow you (Settings →
          Website).
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
          <Image source={logoSource(brand, LOGO)} style={styles.logo} accessibilityLabel={brand.short_name} />
          {!small && (
            <View style={styles.flex}>
              <Text style={styles.brand} numberOfLines={1}>
                {brand.short_name}
              </Text>
              <Text style={styles.brandSub} numberOfLines={1}>
                Admission Management
              </Text>
            </View>
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
                {!small && <Text style={[styles.itemText, styles.flex, on && styles.itemTextOn]}>{it.label}</Text>}
                {!!it.badge && (
                  <View style={[styles.badge, small && styles.badgeSmall]}>
                    <Text style={styles.badgeText}>{it.badge > 99 ? '99+' : it.badge}</Text>
                  </View>
                )}
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
        {!small && (
          <Text style={styles.footer}>
            {VERSION ? `v${VERSION} · ` : ''}
            {copyrightLine(brand)}
          </Text>
        )}
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
              placeholder={
                onLeads ? 'Search leads: name, phone, WhatsApp…' : 'Search students: name, phone, College ID, NU ID…'
              }
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
          {/* 🌙 Light / dark / like the computer */}
          <View>
            <Pressable
              onPress={() => setThemeOpen(!themeOpen)}
              style={(state) => [styles.iconBtn, (state as { hovered?: boolean }).hovered && styles.topHover]}
              accessibilityRole="button"
              accessibilityLabel="Colours: light or dark"
            >
              <Text style={styles.iconBtnText}>{THEMES.find((t) => t.key === theme)?.icon ?? '🖥'}</Text>
            </Pressable>
            {themeOpen && (
              <View style={[styles.dropdown, styles.dropdownTheme]}>
                {THEMES.map((t) => (
                  <Pressable
                    key={t.key}
                    onPress={() => (t.key === theme ? setThemeOpen(false) : pickTheme(t.key))}
                    style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: t.key === theme }}
                  >
                    <Text style={[styles.dropText, t.key === theme && { color: colors.primary }]}>
                      {t.icon} {t.label}
                      {t.key === theme ? '  ✓' : ''}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
          <Pressable
            onPress={() => setHelp(true)}
            style={(state) => [styles.iconBtn, (state as { hovered?: boolean }).hovered && styles.topHover]}
            accessibilityRole="button"
            accessibilityLabel="Keyboard shortcuts"
          >
            <Text style={styles.iconBtnText}>⌨</Text>
          </Pressable>

          <View>
            <Pressable
              onPress={() => setMenuOpen(!menuOpen)}
              style={(state) => [styles.me, (state as { hovered?: boolean }).hovered && styles.topHover]}
              accessibilityRole="button"
              accessibilityLabel="My account"
            >
              <View style={styles.avatar}>
                {profile?.avatar_url ? (
                  <Image source={{ uri: profile.avatar_url }} style={styles.avatarImg} accessibilityLabel="My photo" />
                ) : (
                  <Text style={styles.avatarText}>{initials || '?'}</Text>
                )}
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
                    router.navigate('/speed' as Href);
                  }}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
                  accessibilityRole="link"
                >
                  <Text style={styles.dropText}>⏱ Speed check</Text>
                </Pressable>
                {(hasPermission('settings.manage') || hasPermission('users.manage')) && (
                  <Pressable
                    onPress={() => {
                      setMenuOpen(false);
                      router.navigate('/push-health' as Href);
                    }}
                    style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
                    accessibilityRole="link"
                  >
                    <Text style={styles.dropText}>🔔 Push health</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.navigate('/password' as Href);
                  }}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
                  accessibilityRole="link"
                >
                  <Text style={styles.dropText}>🔐 Change password</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.navigate('/delete-account' as Href);
                  }}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
                  accessibilityRole="link"
                >
                  <Text style={styles.dropText}>🗑 Delete my account</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.navigate('/privacy' as Href);
                  }}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
                  accessibilityRole="link"
                >
                  <Text style={styles.dropText}>🔒 Privacy policy</Text>
                </Pressable>
                <Pressable
                  onPress={() => signOut()}
                  style={(state) => [styles.dropItem, (state as { hovered?: boolean }).hovered && styles.topHover]}
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

      {/* 🔔 More students ready for ITTC (Admission Officer) */}
      {newOnes > 0 && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            🏛 {newOnes} more student{newOnes > 1 ? 's' : ''} ready for ITTC (admission fee paid)
          </Text>
          <Pressable
            onPress={() => {
              setNewOnes(0);
              router.navigate({ pathname: '/students', params: { quick: 'ittc_ready' } } as Href);
            }}
            style={styles.noticeBtn}
            accessibilityRole="button"
          >
            <Text style={styles.noticeBtnText}>Show</Text>
          </Pressable>
          <Pressable onPress={() => setNewOnes(0)} hitSlop={8} accessibilityLabel="Close">
            <Text style={styles.noticeClose}>✕</Text>
          </Pressable>
        </View>
      )}
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
    backgroundColor: isDark ? '#080C17' : '#101A33',
    borderRightWidth: isDark ? 1 : 0,
    borderRightColor: colors.border,
  },
  sideSmall: { width: 68, paddingHorizontal: spacing.sm },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs },
  brandRowSmall: { justifyContent: 'center', paddingHorizontal: 0 },
  logo: { width: 40, height: 40 },
  brand: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: '#fff', letterSpacing: 1 },
  brandSub: { fontSize: 11, color: '#8E9AB8' },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSmall: { position: 'absolute', top: 2, right: 4, minWidth: 16, height: 16, paddingHorizontal: 4 },
  badgeText: { fontSize: 11, fontWeight: fontWeight.bold, color: '#101A33' },
  footer: { marginTop: spacing.sm, paddingHorizontal: spacing.sm, fontSize: 10, lineHeight: 14, color: '#6F7B99' },
  topHover: { backgroundColor: colors.background },
  dropdownTheme: { width: 250 },
  notice: {
    position: 'absolute',
    top: 72,
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  noticeText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  noticeBtn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  noticeBtnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  noticeClose: { fontSize: fontSize.small, color: colors.textMuted },
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
    overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
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
