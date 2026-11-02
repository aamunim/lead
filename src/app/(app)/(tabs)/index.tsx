import { router, useFocusEffect, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { canImportContacts } from '@/features/contacts/api';
import { TodayList } from '@/features/follow-ups/TodayList';
import { getMyOpenNudge, markNudgeSeen, nudgeTitle, type Nudge } from '@/features/nudges/api';
import { SyncSetupSheet } from '@/features/nudges/SyncSetupSheet';
import { countUnread } from '@/features/notifications/api';
import { countDiscountsToAnswer } from '@/features/fees/api';
import { canSeeReports, getReportSettings } from '@/features/reports/api';
import { ReportHomeCard } from '@/features/reports/ReportHomeCard';
import { addedRange, getLeadsAdded } from '@/features/leads/added';
import { StudentsHomeCard } from '@/features/students/StudentsHomeCard';
import { TodayVisits } from '@/features/visits/TodayVisits';
import { isWeb } from '@/features/web/api';
import { APP_COLLEGE, APP_PRODUCT } from '@/features/web/brand';
import { takeBootUrl } from '@/shared/web/bootUrl';
import { countPendingUsers } from '@/features/users/api';
import { MIcon, SectionHeader, Tap, md, type MIconName } from '@/features/home/md';
import { TodayStats } from '@/features/home/TodayStats';
import { colors, fontSize, fontWeight } from '@/shared/theme';
import { ApprovalHomeCard } from '@/features/approval/ApprovalHomeCard';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LOGO = require('../../../../assets/web/ittc-logo-64.png');

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  // 🌐 The website opens on Students (the menu on the left has the rest),
  //   or, after a reload / from a shared link, on the page that was open
  if (isWeb) return <WebStart />;
  return <PhoneHome />;
}

function WebStart() {
  // Only once this page is really shown (it is also drawn, unseen, under others)
  useFocusEffect(
    useCallback(() => {
      router.replace((takeBootUrl() ?? '/students') as Href);
    }, []),
  );
  return null;
}

function PhoneHome() {
  const { profile, hasPermission } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [unread, setUnread] = useState(0);
  const [contactsAllowed, setContactsAllowed] = useState(false);
  const [discounts, setDiscounts] = useState(0);
  // ➕ Leads I added today / this week
  const [myAdded, setMyAdded] = useState<{ today: number; week: number } | null>(null);

  // Reminder from the Super Admin (e.g. "turn on call log sync")
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const [setupVisible, setSetupVisible] = useState(false);

  const canManageUsers = hasPermission('users.manage');

  const firstName = profile?.full_name?.split(' ')[0] ?? 'there';
  const today = new Date().toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  // --- reminder ----------------------------------------------------------
  const openSetup = useCallback((n: Nudge) => {
    setSetupVisible(true);
    // Tell the Super Admin it was seen (it won't pop up by itself again)
    if (!n.seenAt) {
      markNudgeSeen(n.id).catch(() => undefined);
      setNudge({ ...n, seenAt: new Date() });
    }
  }, []);

  const checkNudge = useCallback(async () => {
    try {
      const n = await getMyOpenNudge();
      setNudge(n);
      // A new reminder pops up once; after that only the banner shows
      if (n && !n.seenAt) openSetup(n);
    } catch {
      // no internet: try again next time
    }
  }, [openSetup]);

  // Refresh the approval count, contacts access and reminders every time Home comes into view
  useFocusEffect(
    useCallback(() => {
      canImportContacts()
        .then(setContactsAllowed)
        .catch(() => setContactsAllowed(false));

      checkNudge();
      countUnread().then(setUnread);
      countDiscountsToAnswer().then(setDiscounts);
      const week = addedRange({ userId: null, day: 'week' });
      const day = addedRange({ userId: null, day: 'today' });
      if (week && day && profile?.id) {
        getLeadsAdded(week.from, week.to)
          .then(async (rows) => {
            const weekN = rows.find((r) => r.user_id === profile.id)?.total ?? 0;
            const todayN = weekN === 0 ? 0 : ((await getLeadsAdded(day.from, day.to)).find((r) => r.user_id === profile.id)?.total ?? 0);
            setMyAdded({ today: todayN, week: weekN });
          })
          .catch(() => setMyAdded(null));
      }

      if (!canManageUsers) return;
      countPendingUsers()
        .then(setPendingCount)
        .catch(() => setPendingCount(0));
    }, [canManageUsers, checkNudge, profile?.id]),
  );

  // ...and when the app comes back to the front
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkNudge();
        countUnread().then(setUnread);
      }
    });
    // A push came in while the app is open: the 🔔 number goes up
    const push = Notifications.addNotificationReceivedListener(() => countUnread().then(setUnread));
    return () => {
      sub.remove();
      push.remove();
    };
  }, [checkNudge]);

  // Reports in Quick actions only for people allowed (Settings → Reports)
  const [reportsAllowed, setReportsAllowed] = useState(false);
  useEffect(() => {
    getReportSettings()
      .then((r) => setReportsAllowed(canSeeReports(r, profile, hasPermission('settings.manage'))))
      .catch(() => setReportsAllowed(false));
  }, [profile, hasPermission]);

  const initials = (profile?.full_name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

  // The bar gets a tint once the page scrolls (Material top app bar)
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<{ scrollTo: (o: { y: number; animated?: boolean }) => void } | null>(null);
  const callsY = useRef(0);

  const quick: { icon: MIconName; label: string; href: Href; show: boolean }[] = [
    { icon: 'groups', label: 'All leads', href: '/leads', show: true },
    { icon: 'contacts', label: 'Phone contacts', href: '/contacts', show: contactsAllowed },
    { icon: 'emoji-events', label: 'Scorecard', href: '/scorecard' as Href, show: true },
    { icon: 'insights', label: 'Reports', href: '/reports', show: reportsAllowed },
    {
      icon: 'today',
      label: myAdded ? `Added today: ${myAdded.today}` : 'Added today',
      href: { pathname: '/leads', params: { addedBy: profile?.id ?? '', addedDay: 'today' } } as unknown as Href,
      show: !!profile?.id,
    },
  ];

  return (
    <View style={styles.screen}>
      {/* ── Top app bar ─────────────────────────────── */}
      <SafeAreaView edges={['top']} style={[styles.bar, scrolled && styles.barScrolled]}>
        <View style={styles.barRow}>
          <View style={styles.barLogo}>
            <Image source={LOGO} style={styles.barLogoImg} accessibilityLabel="ITTC logo" />
          </View>
          <View style={styles.flex}>
            <Text style={styles.barTitle} numberOfLines={1}>
              {APP_PRODUCT}
            </Text>
            <Text style={styles.barSub} numberOfLines={1}>
              {APP_COLLEGE}
            </Text>
          </View>
          <Tap
            onPress={() => router.push('/notifications' as Href)}
            style={styles.iconBtn}
            borderless
            label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
          >
            <MIcon name={unread > 0 ? 'notifications' : 'notifications-none'} size={26} />
            {unread > 0 && (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>{unread > 99 ? '99+' : unread}</Text>
              </View>
            )}
          </Tap>
          <Tap onPress={() => router.push('/more' as Href)} style={styles.avatar} borderless label="More">
            <Text style={styles.avatarText}>{initials || '?'}</Text>
          </Tap>
        </View>
      </SafeAreaView>

      <ScrollView
        ref={scrollRef as never}
        contentContainerStyle={styles.content}
        onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 4)}
        scrollEventThrottle={32}
      >
        {/* ── Greeting ─────────────────────────────── */}
        <Text style={styles.hello}>
          {greeting()}, {firstName}
        </Text>
        <View style={styles.helloSub}>
          <Text style={styles.date}>{today}</Text>
          <View style={styles.roleChip}>
            <Text style={styles.roleChipText}>{profile?.role?.name ?? 'No role'}</Text>
          </View>
        </View>

        {/* ── Today at a glance ────────────────────── */}
        <TodayStats onOpenCalls={() => scrollRef.current?.scrollTo({ y: callsY.current, animated: true })} />

        {/* ── Banners ──────────────────────────────── */}
        {nudge && !setupVisible && (
          <Banner
            icon="sync-problem"
            tone="warn"
            title={nudgeTitle(nudge.reason)}
            sub={nudge.message ?? `${nudge.sentByName ?? 'Your admin'} asked you to do this`}
            action="Set up"
            onPress={() => openSetup(nudge)}
          />
        )}
        {canManageUsers && pendingCount > 0 && (
          <Banner
            icon="how-to-reg"
            tone="primary"
            title={`${pendingCount} ${pendingCount === 1 ? 'person is' : 'people are'} waiting for approval`}
            sub="New sign-ups"
            action="Review"
            onPress={() => router.push('/users' as Href)}
          />
        )}
        {discounts > 0 && (
          <Banner
            icon="discount"
            tone="ok"
            title={`${discounts} discount ${discounts === 1 ? 'request' : 'requests'} waiting`}
            sub="Approve or answer"
            action="Review"
            onPress={() => router.push('/discounts' as Href)}
          />
        )}

        {/* ── Today: visits and calls ──────────────── */}
        <View onLayout={(e) => (callsY.current = e.nativeEvent.layout.y - 8)}>
          <TodayVisits />
          <TodayList />
        </View>

        {/* ── Students, approvals, this month ──────── */}
        <StudentsHomeCard />
        <ApprovalHomeCard />
        <ReportHomeCard />

        {/* ── Quick actions ────────────────────────── */}
        <SectionHeader title="Quick actions" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quick}>
          {quick
            .filter((q) => q.show)
            .map((q) => (
              <Tap key={q.label} onPress={() => router.push(q.href)} style={styles.quickItem} label={q.label}>
                <View style={styles.quickIcon}>
                  <MIcon name={q.icon} size={26} color={colors.primary} />
                </View>
                <Text style={styles.quickText} numberOfLines={2}>
                  {q.label}
                </Text>
              </Tap>
            ))}
        </ScrollView>
      </ScrollView>

      {/* ── Add lead (FAB) ─────────────────────────── */}
      <Tap onPress={() => router.push('/leads/edit/new' as Href)} style={styles.fab} label="Add a lead">
        <MIcon name="person-add" size={24} color={md.onPrimaryC} />
        <Text style={styles.fabText}>Add lead</Text>
      </Tap>

      {nudge && (
        <SyncSetupSheet
          visible={setupVisible}
          nudge={nudge}
          onLater={() => setSetupVisible(false)}
          onDone={() => {
            setSetupVisible(false);
            setNudge(null);
          }}
        />
      )}
    </View>
  );
}

const TONES = {
  warn: { bg: md.warnC, fg: md.onWarnC, text: '#2C1600', sub: '#5C3A00' },
  primary: { bg: md.primaryC, fg: md.onPrimaryC, text: md.onPrimaryC, sub: '#3A4A8A' },
  ok: { bg: md.okC, fg: md.onOkC, text: '#0B3A22', sub: '#2D5A40' },
};

/** A Material banner card: icon, two lines, a text button */
function Banner({
  icon,
  tone,
  title,
  sub,
  action,
  onPress,
}: {
  icon: MIconName;
  tone: keyof typeof TONES;
  title: string;
  sub?: string;
  action: string;
  onPress: () => void;
}) {
  const t = TONES[tone];
  return (
    <Tap onPress={onPress} style={[styles.banner, { backgroundColor: t.bg }]} label={`${title}. ${action}`}>
      <MIcon name={icon} size={26} color={t.fg} />
      <View style={styles.flex}>
        <Text style={[styles.bannerTitle, { color: t.text }]} numberOfLines={2}>
          {title}
        </Text>
        {!!sub && (
          <Text style={[styles.bannerSub, { color: t.sub }]} numberOfLines={1}>
            {sub}
          </Text>
        )}
      </View>
      <Text style={[styles.bannerAction, { color: t.fg }]}>{action}</Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  // top app bar
  bar: { backgroundColor: colors.background },
  barScrolled: { backgroundColor: md.surface1 },
  barRow: { height: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingRight: 8 },
  barLogo: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  barLogoImg: { width: 26, height: 26, resizeMode: 'contain' },
  barTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  barSub: { fontSize: 11, color: colors.textMuted, letterSpacing: 0.2 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  bellBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: md.onErrorC,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: '#FFFFFF' },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginHorizontal: 4,
    backgroundColor: md.primaryC,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
  // body
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 110, gap: 0 },
  hello: { fontSize: 24, lineHeight: 32, fontWeight: fontWeight.regular, color: colors.text },
  helloSub: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  date: { fontSize: fontSize.small, color: colors.textMuted },
  roleChip: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: md.outline,
    justifyContent: 'center',
  },
  roleChipText: { fontSize: fontSize.caption, fontWeight: fontWeight.medium, color: colors.textMuted },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 14,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 16,
    borderRadius: 16,
    overflow: 'hidden',
  },
  bannerTitle: { fontSize: fontSize.small, fontWeight: fontWeight.medium },
  bannerSub: { fontSize: fontSize.caption, marginTop: 1 },
  bannerAction: { fontSize: fontSize.small, fontWeight: fontWeight.semibold },
  quick: { gap: 8, paddingRight: 8 },
  quickItem: { width: 82, alignItems: 'center', gap: 6, paddingVertical: 4, borderRadius: 16, overflow: 'hidden' },
  quickIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: md.surface1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickText: { fontSize: fontSize.caption, color: colors.text, textAlign: 'center' },
  // FAB
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    height: 56,
    paddingLeft: 16,
    paddingRight: 20,
    borderRadius: 16,
    backgroundColor: md.primaryC,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  fabText: { fontSize: 15, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
});
