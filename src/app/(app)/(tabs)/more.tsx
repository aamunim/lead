import Constants from 'expo-constants';
import { Redirect, router, useFocusEffect, type Href } from 'expo-router';
import { Children, useCallback, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { signOut } from '@/features/auth/api';
import { isWeb } from '@/features/web/api';
import { APP_PRODUCT } from '@/features/web/brand';
import { useAuth } from '@/features/auth/AuthProvider';
import { canSyncCalls, isCallLogAvailable, isCallSyncEnabled } from '@/features/call-sync/api';
import { listSyncHealth } from '@/features/call-sync/health';
import { canImportContacts } from '@/features/contacts/api';
import { countDiscountsToAnswer } from '@/features/fees/api';
import { MIcon, md, type MIconName } from '@/features/home/md';
import { countUnread } from '@/features/notifications/api';
import { checkAndDownload, currentVersionInfo, restartWithUpdate } from '@/features/updates/api';
import { WhatsNewSheet } from '@/features/updates/WhatsNewSheet';
import { ExportWorkSheet } from '@/features/activity/ExportWorkSheet';
import { countNewFeedback, isDeveloper } from '@/features/feedback/api';
import { chatUnread } from '@/features/feedback/chat';
import { canOpenActivity, getActivitySettings } from '@/features/activity/api';
import { canSeeReports, getReportSettings } from '@/features/reports/api';
import { countPendingUsers } from '@/features/users/api';
import { designOf, saveListDesign, type ListDesign } from '@/features/leads/design';
import { APPEARANCE, currentAppearance, setAppearance } from '@/features/settings/appearance';
import { colors, fontWeight } from '@/shared/theme';

// =====================================================================
// ☰ More (phone): Material top bar (🔔 ⚙️), your profile card, four
//   quick tiles, then every page in tidy groups (Reports, Tools, Team,
//   Admin, App, Help) with what needs you on the right, and Sign out.
// =====================================================================

export default function MoreScreen() {
  if (isWeb) return <Redirect href="/students" />;
  return <PhoneMore />;
}

// Tonal icon colours
const TONE = {
  blue: [md.primaryC, md.onPrimaryC],
  green: [md.okC, md.onOkC],
  orange: [md.warnC, md.onWarnC],
  red: [md.errorC, md.onErrorC],
  purple: [md.purpleC, md.onPurpleC],
  wa: [md.waC, md.onWaC],
  grey: [md.surface2, colors.text],
} as const;
type Tone = keyof typeof TONE;

function PhoneMore() {
  const { profile, session, hasPermission, refreshProfile } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [contactsAllowed, setContactsAllowed] = useState(false);
  const [callSyncAllowed, setCallSyncAllowed] = useState(false);
  const [callSyncOn, setCallSyncOn] = useState(false);
  const [syncProblems, setSyncProblems] = useState(0);
  const [reportsAllowed, setReportsAllowed] = useState(false);
  const [activityAllowed, setActivityAllowed] = useState(false);
  const [unread, setUnread] = useState(0);

  const canManageUsers = hasPermission('users.manage');
  const canManageSettings = hasPermission('settings.manage');
  // Admins see every phone; Team Leads see their team's
  const canSeeSyncHealth = canManageUsers || hasPermission('leads.view_team');

  const name = profile?.full_name || 'No name';
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const [discounts, setDiscounts] = useState(0);
  // 🔄 EAS Update (not in development builds)
  const update = currentVersionInfo();
  const version = Constants.expoConfig?.version ?? '—';
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'ready' | 'latest'>('idle');
  const [whatsNew, setWhatsNew] = useState(false);
  const [exportMine, setExportMine] = useState(false);

  // 🎨 Leads / Students list: the new design or the classic one
  const design = designOf(profile?.list_design);
  const [designBusy, setDesignBusy] = useState(false);
  // 🌗 Light / dark / system on this phone
  const [appearance, setAppearanceState] = useState(currentAppearance());
  const pickDesign = async (next: ListDesign) => {
    if (!profile?.id || next === design) return;
    setDesignBusy(true);
    try {
      await saveListDesign(profile.id, next);
      await refreshProfile();
    } catch {
      // stays as it was
    } finally {
      setDesignBusy(false);
    }
  };

  // 💬 The developer sees the inbox, with the new ones counted
  const [developer, setDeveloper] = useState(false);
  const [newFeedback, setNewFeedback] = useState(0);

  useFocusEffect(
    useCallback(() => {
      isDeveloper()
        .then(async (dev) => {
          setDeveloper(dev);
          // 💬 unread messages: mine (the developer: everyone's)
          setNewFeedback(await chatUnread().catch(() => countNewFeedback()));
        })
        .catch(() => setDeveloper(false));
      countDiscountsToAnswer().then(setDiscounts);
      countUnread()
        .then(setUnread)
        .catch(() => setUnread(0));
      canImportContacts()
        .then(setContactsAllowed)
        .catch(() => setContactsAllowed(false));

      getReportSettings().then((s) => setReportsAllowed(canSeeReports(s, profile, canManageSettings)));
      getActivitySettings().then((s) => setActivityAllowed(canOpenActivity(s, hasPermission)));

      // Call log sync only exists in the Android app (not Expo Go / iPhone)
      if (isCallLogAvailable) {
        canSyncCalls()
          .then(setCallSyncAllowed)
          .catch(() => setCallSyncAllowed(false));
        setCallSyncOn(isCallSyncEnabled());
      }

      // How many phones have a problem (red), for the badge
      if (canSeeSyncHealth) {
        listSyncHealth()
          .then((rows) => setSyncProblems(rows.filter((r) => r.status === 'problem').length))
          .catch(() => setSyncProblems(0));
      }

      if (!canManageUsers) return;
      countPendingUsers()
        .then(setPendingCount)
        .catch(() => setPendingCount(0));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canManageUsers, canSeeSyncHealth, profile, canManageSettings]),
  );

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const go = (href: string) => () => router.push(href as Href);

  // Four quick tiles: Team activity for those who may see it (else Message templates)
  const tiles: { icon: MIconName; tone: Tone; label: string; href: string; badge?: number }[] = [
    { icon: 'notifications', tone: 'blue', label: 'Alerts', href: '/notifications', badge: unread },
    { icon: 'chat', tone: 'wa', label: 'WhatsApp', href: '/whatsapp' },
    activityAllowed
      ? { icon: 'timer', tone: 'purple', label: 'Team activity', href: '/activity' }
      : { icon: 'description', tone: 'purple', label: 'Templates', href: '/templates' },
    { icon: 'sell', tone: 'orange', label: 'Discounts', href: '/discounts', badge: discounts },
  ];

  const updateText =
    updateState === 'checking'
      ? 'Checking…'
      : updateState === 'ready'
        ? 'A new version is ready'
        : updateState === 'latest'
          ? '✓ You have the latest version'
          : update.enabled
            ? update.builtIn
              ? 'Built in'
              : [
                  update.createdAt
                    ? `Update ${update.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                    : null,
                  (update.updateId ?? '').slice(0, 8) || null,
                  update.channel,
                ]
                  .filter(Boolean)
                  .join(' · ')
            : 'Development build';

  return (
    <View style={styles.screen}>
      {/* Top bar */}
      <SafeAreaView edges={['top']} style={styles.bar}>
        <View style={styles.barRow}>
          <Text style={styles.barTitle}>More</Text>
          <IconBtn icon="notifications-none" label="Notifications" badge={unread} onPress={go('/notifications')} />
          {canManageSettings && <IconBtn icon="settings" label="Settings" onPress={go('/settings')} />}
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        {/* 👤 You */}
        <Pressable
          onPress={go('/profile')}
          android_ripple={{ color: 'rgba(255,255,255,0.18)', foreground: true }}
          style={styles.profile}
          accessibilityRole="button"
          accessibilityLabel="My profile"
        >
          <View style={styles.profileGlow} />
          {profile?.avatar_url ? (
            <Image source={{ uri: profile.avatar_url }} style={styles.avatar} accessibilityLabel="My photo" />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials || '?'}</Text>
            </View>
          )}
          <View style={styles.flex}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.email} numberOfLines={1}>
              {profile?.email ?? session?.user.email}
            </Text>
            <View style={styles.roleBadge}>
              <Text style={styles.roleText}>{profile?.role?.name ?? 'No role'}</Text>
            </View>
          </View>
          <Pressable
            onPress={go('/password')}
            android_ripple={{ color: 'rgba(255,255,255,0.25)', borderless: true, radius: 22 }}
            style={styles.keyBtn}
            accessibilityRole="button"
            accessibilityLabel="Change password"
          >
            <MIcon name="vpn-key" size={20} color="#FFFFFF" />
          </Pressable>
        </Pressable>

        {/* ⚡ Quick tiles */}
        <View style={styles.tiles}>
          {tiles.map((t) => (
            <Pressable
              key={t.label}
              onPress={go(t.href)}
              android_ripple={{ color: md.ripple, foreground: true }}
              style={({ pressed }) => [styles.tile, Platform.OS !== 'android' && pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={t.badge ? `${t.label}, ${t.badge}` : t.label}
            >
              <View style={[styles.tileIcon, { backgroundColor: TONE[t.tone][0] }]}>
                <MIcon name={t.icon} size={22} color={TONE[t.tone][1]} />
              </View>
              <Text style={styles.tileText} numberOfLines={1}>
                {t.label}
              </Text>
              {!!t.badge && (
                <View style={styles.tileBadge}>
                  <Text style={styles.tileBadgeText}>{t.badge > 99 ? '99+' : t.badge}</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>

        {/* 📊 Reports (Settings → Reports decides who); everyone sees the scorecard */}
        <Section title="REPORTS">
          {reportsAllowed && (
            <Row
              icon="bar-chart"
              tone="blue"
              title="Reports"
              subtitle="Pipeline, sources, team, best time to call"
              onPress={go('/reports')}
            />
          )}
          <Row
            icon="emoji-events"
            tone="orange"
            title="Leaderboard"
            subtitle="Credits for everyone's work, and your place"
            onPress={go('/leaderboard')}
          />
          <Row
            icon="military-tech"
            tone="green"
            title="Weekly scorecard"
            subtitle="Last week next to the week before"
            onPress={go('/scorecard')}
          />
        </Section>

        {/* 🧰 Tools */}
        <Section title="TOOLS">
          {callSyncAllowed && (
            <Row
              icon="phone-callback"
              tone={callSyncOn ? 'green' : 'orange'}
              title="Call log sync"
              subtitle={callSyncOn ? 'On · lead calls are saved automatically' : 'Off · tap to set up'}
              pill={callSyncOn ? { text: 'ON', tone: 'green' } : { text: 'Set up', tone: 'orange' }}
              onPress={go('/call-sync')}
            />
          )}
          {contactsAllowed && (
            <Row
              icon="contacts"
              tone="grey"
              title="Phone contacts"
              subtitle="Save people from your phone as leads"
              onPress={go('/contacts')}
            />
          )}
          {activityAllowed && (
            <Row
              icon="description"
              tone="purple"
              title="Message templates"
              subtitle="Ready-made WhatsApp and SMS messages"
              onPress={go('/templates')}
            />
          )}
          <Row
            icon="file-download"
            tone="blue"
            title="Export my work"
            subtitle="My calls, notes, leads: Excel or text"
            onPress={() => setExportMine(true)}
          />
          <Row
            icon="chat"
            tone="wa"
            title="WhatsApp calls"
            subtitle="WhatsApp calls and messages with leads"
            onPress={go('/whatsapp')}
          />
        </Section>

        {/* 👥 Team (Admins and Team Leads) */}
        {(canSeeSyncHealth || activityAllowed) && (
          <Section title="TEAM">
            {activityAllowed && (
              <Row
                icon="timer"
                tone="blue"
                title="Team activity"
                subtitle="Who is working, app time, calls"
                onPress={go('/activity')}
              />
            )}
            {activityAllowed && (
              <Row
                icon="history"
                tone="purple"
                title="Change log"
                subtitle="Who changed what on which lead"
                onPress={go('/changes')}
              />
            )}
            {canSeeSyncHealth && (
              <Row
                icon={syncProblems > 0 ? 'sync-problem' : 'sync'}
                tone={syncProblems > 0 ? 'red' : 'green'}
                title="Sync health"
                subtitle={canManageUsers ? 'Call sync on every phone' : 'Call sync on your team’s phones'}
                pill={syncProblems > 0 ? { text: String(syncProblems), tone: 'red' } : undefined}
                onPress={go('/sync-health')}
              />
            )}
          </Section>
        )}

        {/* 🛠 Admin */}
        {(canManageUsers || canManageSettings) && (
          <Section title="ADMIN">
            {canManageUsers && (
              <Row
                icon="manage-accounts"
                tone="blue"
                title="Users"
                subtitle="Approve, roles, teams"
                pill={pendingCount > 0 ? { text: `${pendingCount} waiting`, tone: 'orange' } : undefined}
                onPress={go('/users')}
              />
            )}
            {canManageSettings && (
              <Row
                icon="settings"
                tone="grey"
                title="Settings"
                subtitle="Courses, stages, fees, rules"
                onPress={go('/settings')}
              />
            )}
            {(canManageSettings || canManageUsers) && (
              <Row
                icon="notifications-active"
                tone="orange"
                title="Push health"
                subtitle="Whose phone gets no notifications, and why"
                onPress={go('/push-health')}
              />
            )}
            {canManageSettings && (
              <Row
                icon="system-update"
                tone="grey"
                title="App versions"
                subtitle="Who runs which update"
                onPress={go('/app-versions')}
              />
            )}
          </Section>
        )}

        {/* 📱 App */}
        <Section title="APP">
          <Row icon="view-agenda" tone="blue" title="List design" subtitle="Leads & Students">
            <View style={styles.seg}>
              {(['new', 'classic'] as ListDesign[]).map((d) => {
                const on = design === d;
                return (
                  <Pressable
                    key={d}
                    onPress={() => pickDesign(d)}
                    disabled={designBusy}
                    style={[styles.segItem, on && styles.segOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <Text style={[styles.segText, on && styles.segTextOn]}>{d === 'new' ? '✨ New' : 'Classic'}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Row>
          {/* 🌗 Light / dark (this phone) */}
          {!isWeb && (
            <Row icon="dark-mode" tone="purple" title="Appearance" subtitle="Light, dark or like the phone">
              <View style={styles.seg}>
                {APPEARANCE.map((a) => {
                  const on = appearance === a.value;
                  return (
                    <Pressable
                      key={a.value}
                      onPress={() => {
                        setAppearanceState(a.value);
                        setAppearance(a.value);
                      }}
                      style={[styles.segItem, on && styles.segOn]}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={a.label}
                    >
                      <Text style={[styles.segText, on && styles.segTextOn]}>{a.icon}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Row>
          )}
          <Row
            icon="new-releases"
            tone="orange"
            title="What’s new"
            subtitle="The latest changes"
            onPress={() => setWhatsNew(true)}
          />
          <Row icon="system-update-alt" tone="green" title={`Version ${version}`} subtitle={updateText}>
            {update.enabled &&
              (updateState === 'checking' ? (
                <ActivityIndicator color={colors.primary} />
              ) : updateState === 'ready' ? (
                <Pressable onPress={() => restartWithUpdate()} style={styles.chipBtn} accessibilityRole="button">
                  <Text style={styles.chipBtnText}>Restart</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={async () => {
                    setUpdateState('checking');
                    const r = await checkAndDownload(true);
                    setUpdateState(r === 'downloaded' ? 'ready' : 'latest');
                  }}
                  style={styles.chipBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Check for updates"
                >
                  <Text style={styles.chipBtnText}>Check</Text>
                </Pressable>
              ))}
          </Row>
        </Section>

        {/* 💬 Help */}
        <Section title="HELP">
          <Row
            icon="support-agent"
            tone="purple"
            title="Contact developer"
            subtitle="Chat: a problem, an idea or a question"
            pill={!developer && newFeedback > 0 ? { text: `${newFeedback} new`, tone: 'orange' } : undefined}
            onPress={go('/feedback')}
          />
          <Row
            icon="notifications-active"
            tone="orange"
            title="Notification check"
            subtitle="Not getting notifications? Check and test this phone"
            onPress={go('/push-check')}
          />
          <Row
            icon="speed"
            tone="blue"
            title="Speed check"
            subtitle="Is the app slow? Test it and send the result"
            onPress={go('/speed')}
          />
          {developer && (
            <Row
              icon="inbox"
              tone="blue"
              title="Feedback inbox"
              subtitle="Chats with everyone, topics, crashes"
              pill={newFeedback > 0 ? { text: `${newFeedback} new`, tone: 'orange' } : undefined}
              onPress={go('/feedback/inbox')}
            />
          )}
        </Section>

        <Pressable
          onPress={handleSignOut}
          disabled={signingOut}
          android_ripple={{ color: 'rgba(186,26,26,0.12)', foreground: true }}
          style={({ pressed }) => [styles.signOut, Platform.OS !== 'android' && pressed && styles.pressed]}
          accessibilityRole="button"
        >
          {signingOut ? (
            <ActivityIndicator color={md.onErrorC} />
          ) : (
            <>
              <MIcon name="logout" size={20} color={md.onErrorC} />
              <Text style={styles.signOutText}>Sign out</Text>
            </>
          )}
        </Pressable>
        <Text style={styles.footer}>
          ITTC {APP_PRODUCT} · v{version}
        </Text>
      </ScrollView>
      {whatsNew && <WhatsNewSheet onClose={() => setWhatsNew(false)} />}
      {exportMine && profile && (
        <ExportWorkSheet people={[{ id: profile.id, name: name }]} onClose={() => setExportMine(false)} />
      )}
    </View>
  );
}

function IconBtn({
  icon,
  label,
  onPress,
  badge,
}: {
  icon: MIconName;
  label: string;
  onPress: () => void;
  badge?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: md.ripple, borderless: true, radius: 21 }}
      style={styles.iconBtn}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge} new` : label}
    >
      <MIcon name={icon} size={25} color={colors.text} />
      {!!badge && (
        <View style={styles.dot}>
          <Text style={styles.dotText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  // Only the rows this person may see; a line between them
  const rows = Children.toArray(children);
  if (rows.length === 0) return null;
  return (
    <View>
      <Text style={styles.sectionLabel}>{title}</Text>
      <View style={styles.group}>
        {rows.map((r, i) => (
          <View key={i} style={i > 0 && styles.divider}>
            {r}
          </View>
        ))}
      </View>
    </View>
  );
}

function Row({
  icon,
  tone,
  title,
  subtitle,
  pill,
  onPress,
  children,
}: {
  icon: MIconName;
  tone: Tone;
  title: string;
  subtitle?: string;
  pill?: { text: string; tone: Tone };
  onPress?: () => void;
  /** Something on the right instead of the › (a switch, a button) */
  children?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      android_ripple={onPress ? { color: md.ripple, foreground: true } : undefined}
      style={({ pressed }) => [styles.row, Platform.OS !== 'android' && pressed && onPress && styles.pressed]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={pill ? `${title}, ${pill.text}` : title}
    >
      <View style={[styles.rowIcon, { backgroundColor: TONE[tone][0] }]}>
        <MIcon name={icon} size={20} color={TONE[tone][1]} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {!!pill && (
        <Text style={[styles.pill, { backgroundColor: TONE[pill.tone][0], color: TONE[pill.tone][1] }]}>
          {pill.text}
        </Text>
      )}
      {children}
      {!!onPress && !children && <MIcon name="chevron-right" size={22} color={md.outline} />}
    </Pressable>
  );
}

const card = {
  backgroundColor: colors.surface,
  shadowColor: '#101840',
  shadowOpacity: 0.07,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
} as const;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },

  bar: { backgroundColor: colors.background },
  barRow: { height: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 6, gap: 2 },
  barTitle: { flex: 1, fontSize: 22, fontWeight: fontWeight.semibold, color: colors.text },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute',
    top: 6,
    right: 5,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: md.onErrorC,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { fontSize: 10, fontWeight: fontWeight.bold, color: '#FFFFFF' },

  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 28 },

  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 22,
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  // a lighter corner, like a gradient
  profileGlow: {
    position: 'absolute',
    right: -60,
    top: -60,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 21, fontWeight: fontWeight.semibold, color: '#FFFFFF' },
  name: { fontSize: 17, fontWeight: fontWeight.semibold, color: '#FFFFFF' },
  email: { fontSize: 12.5, color: 'rgba(255,255,255,0.85)', marginTop: 1 },
  roleBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  roleText: { fontSize: 11, fontWeight: fontWeight.semibold, color: '#FFFFFF' },
  keyBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  tiles: { flexDirection: 'row', gap: 8, marginTop: 14 },
  tile: {
    ...card,
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 4,
    borderRadius: 16,
    overflow: 'hidden',
  },
  tileIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontSize: 11, color: colors.text },
  tileBadge: {
    position: 'absolute',
    top: 7,
    right: 10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: md.onErrorC,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBadgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: '#FFFFFF' },

  sectionLabel: {
    fontSize: 11.5,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
    color: colors.textMuted,
    marginTop: 18,
    marginBottom: 8,
    marginHorizontal: 4,
  },
  group: { ...card, borderRadius: 18, overflow: 'hidden' },
  divider: { borderTopWidth: 1, borderTopColor: md.surface2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, paddingLeft: 12, paddingRight: 10 },
  rowIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 14.5, fontWeight: '500', color: colors.text },
  rowSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  pill: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    overflow: 'hidden',
  },

  seg: { flexDirection: 'row', gap: 3, padding: 3, borderRadius: 12, backgroundColor: md.surface1 },
  segItem: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 9 },
  segOn: {
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segText: { fontSize: 12, fontWeight: fontWeight.semibold, color: colors.textMuted },
  segTextOn: { color: md.onPrimaryC },

  chipBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14, backgroundColor: md.primaryC },
  chipBtnText: { fontSize: 12, fontWeight: fontWeight.semibold, color: md.onPrimaryC },

  signOut: {
    marginTop: 20,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    overflow: 'hidden',
  },
  signOutText: { fontSize: 14.5, fontWeight: fontWeight.semibold, color: md.onErrorC },
  footer: { textAlign: 'center', fontSize: 11.5, color: colors.textMuted, marginTop: 12 },
});
