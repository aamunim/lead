import { router, useFocusEffect, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/features/auth/AuthProvider';
import { canImportContacts } from '@/features/contacts/api';
import { TodayList } from '@/features/follow-ups/TodayList';
import { getMyOpenNudge, markNudgeSeen, nudgeTitle, type Nudge } from '@/features/nudges/api';
import { SyncSetupSheet } from '@/features/nudges/SyncSetupSheet';
import { countUnread } from '@/features/notifications/api';
import { countDiscountsToAnswer } from '@/features/fees/api';
import { ReportHomeCard } from '@/features/reports/ReportHomeCard';
import { TodayVisits } from '@/features/visits/TodayVisits';
import { countPendingUsers } from '@/features/users/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  const { profile, hasPermission } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [unread, setUnread] = useState(0);
  const [contactsAllowed, setContactsAllowed] = useState(false);
  const [discounts, setDiscounts] = useState(0);

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

      if (!canManageUsers) return;
      countPendingUsers()
        .then(setPendingCount)
        .catch(() => setPendingCount(0));
    }, [canManageUsers, checkNudge]),
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

  return (
    <View style={styles.screen}>
      {/* Blue top area */}
      <SafeAreaView edges={['top']} style={styles.top}>
        <View style={styles.topRow}>
          <Text style={[styles.greeting, styles.flex]}>
            {greeting()}, {firstName}
          </Text>
          {/* 🔔 Notifications */}
          <Pressable
            onPress={() => router.push('/notifications' as Href)}
            hitSlop={10}
            style={({ pressed }) => [styles.bell, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
          >
            <Text style={styles.bellIcon}>🔔</Text>
            {unread > 0 && (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>{unread > 99 ? '99+' : unread}</Text>
              </View>
            )}
          </Pressable>
        </View>
        <Text style={styles.date}>{today}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{profile?.role?.name ?? 'No role'}</Text>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Reminder from the Super Admin: stays until it's done */}
        {nudge && !setupVisible && (
          <Pressable
            onPress={() => openSetup(nudge)}
            style={({ pressed }) => [styles.banner, styles.nudgeBanner, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${nudgeTitle(nudge.reason)}. Tap to set up`}
          >
            <Text style={styles.bannerIcon}>📞</Text>
            <View style={styles.flex}>
              <Text style={[styles.bannerText, styles.nudgeText]}>{nudgeTitle(nudge.reason)}</Text>
              <Text style={styles.nudgeSub} numberOfLines={1}>
                {nudge.message ?? `${nudge.sentByName ?? 'Your admin'} asked you to do this`}
              </Text>
            </View>
            <Text style={[styles.bannerAction, styles.nudgeText]}>Set up ›</Text>
          </Pressable>
        )}

        {/* Approvals waiting (admins only) */}
        {canManageUsers && pendingCount > 0 && (
          <Pressable
            onPress={() => router.push('/users' as Href)}
            style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.bannerIcon}>⏳</Text>
            <Text style={styles.bannerText}>
              {pendingCount} {pendingCount === 1 ? 'person is' : 'people are'} waiting for approval
            </Text>
            <Text style={styles.bannerAction}>Review ›</Text>
          </Pressable>
        )}

        {/* 💰 Discount requests I may answer */}
        {discounts > 0 && (
          <Pressable
            onPress={() => router.push('/discounts' as Href)}
            style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.bannerIcon}>💰</Text>
            <Text style={styles.bannerText}>
              {discounts} discount {discounts === 1 ? 'request is' : 'requests are'} waiting for you
            </Text>
            <Text style={styles.bannerAction}>Review ›</Text>
          </Pressable>
        )}

        {/* Today: follow-ups due today and overdue */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>TODAY</Text>
          <TodayVisits />
          <TodayList />
        </View>

        {/* This month at a glance (Settings → Reports) */}
        <ReportHomeCard />

        {/* Leads */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>LEADS</Text>
          <View style={styles.group}>
            <Tile icon="📋" title="All leads" text="Search, filter and open leads" href="/leads" />
            <Tile
              icon="➕"
              title="Add a lead"
              text="Quick add with name, phone and source"
              href="/leads/edit/new"
              divider
            />
            {contactsAllowed && (
              <Tile
                icon="📇"
                title="Phone contacts"
                text="Pick people from your phone and save them as leads"
                href="/contacts"
                divider
              />
            )}
          </View>
        </View>
      </ScrollView>

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

function Tile({
  icon,
  title,
  text,
  href,
  divider,
}: {
  icon: string;
  title: string;
  text: string;
  href: Href;
  divider?: boolean;
}) {
  return (
    <Pressable
      onPress={() => router.push(href)}
      style={({ pressed }) => [styles.tile, divider && styles.tileDivider, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.tileIcon}>
        <Text style={styles.tileIconText}>{icon}</Text>
      </View>
      <View style={styles.tileBody}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileText}>{text}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  top: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.xs,
  },
  greeting: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bell: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  bellIcon: { fontSize: 18 },
  bellBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBadgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  date: { fontSize: fontSize.small, color: colors.primarySoft },
  badge: {
    alignSelf: 'flex-start',
    marginTop: spacing.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  badgeText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textOnPrimary },
  content: { padding: spacing.xl, gap: spacing.lg },
  pressed: { opacity: 0.7 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.warningSoft,
  },
  bannerIcon: { fontSize: 20 },
  bannerText: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning },
  bannerAction: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.warning },
  nudgeBanner: { backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.primary },
  nudgeText: { color: colors.primary },
  nudgeSub: { fontSize: fontSize.caption, color: colors.text, marginTop: 2 },
  section: { gap: spacing.sm },
  sectionLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1.2, color: colors.textMuted },
  group: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tile: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  tileDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  tileIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileIconText: { fontSize: 22 },
  tileBody: { flex: 1, gap: 2 },
  tileTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  tileText: { fontSize: fontSize.caption, color: colors.textMuted },
  chevron: { fontSize: fontSize.heading, color: colors.textMuted },
});