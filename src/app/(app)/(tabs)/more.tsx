import Constants from 'expo-constants';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { signOut } from '@/features/auth/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { canSyncCalls, isCallLogAvailable, isCallSyncEnabled } from '@/features/call-sync/api';
import { listSyncHealth } from '@/features/call-sync/health';
import { canImportContacts } from '@/features/contacts/api';
import { canOpenActivity, getActivitySettings } from '@/features/activity/api';
import { canSeeReports, getReportSettings } from '@/features/reports/api';
import { countPendingUsers } from '@/features/users/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

export default function MoreScreen() {
  const { profile, session, hasPermission } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [contactsAllowed, setContactsAllowed] = useState(false);
  const [callSyncAllowed, setCallSyncAllowed] = useState(false);
  const [callSyncOn, setCallSyncOn] = useState(false);
  const [syncProblems, setSyncProblems] = useState(0);
  const [reportsAllowed, setReportsAllowed] = useState(false);
  const [activityAllowed, setActivityAllowed] = useState(false);

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

  useFocusEffect(
    useCallback(() => {
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

  const showTools = contactsAllowed || callSyncAllowed;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Profile */}
      <View style={styles.profile}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials || '?'}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.muted}>{profile?.email ?? session?.user.email}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{profile?.role?.name ?? 'No role'}</Text>
          </View>
        </View>
      </View>

      {/* Notifications */}
      <View style={styles.section}>
        <View style={styles.group}>
          <Row icon="🔔" title="Notifications" subtitle="Leads given to you, reminders, visits" href="/notifications" />
          <Row
            icon="💬"
            title="WhatsApp calls"
            subtitle="WhatsApp calls and messages with leads"
            href={'/whatsapp' as Href}
            divider
          />
          <Row
            icon="📝"
            title="Message templates"
            subtitle="Ready-made WhatsApp and SMS messages"
            href={'/templates' as Href}
            divider
          />
        </View>
      </View>

      {/* Reports (Settings → Reports decides who) */}
      {reportsAllowed && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>REPORTS</Text>
          <View style={styles.group}>
            <Row icon="📊" title="Reports" subtitle="Pipeline, sources, team, best time to call" href="/reports" />
          </View>
        </View>
      )}

      {/* Tools (for anyone who is allowed) */}
      {showTools && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>TOOLS</Text>
          <View style={styles.group}>
            {callSyncAllowed && (
              <Row
                icon="📞"
                title="Call log sync"
                subtitle={callSyncOn ? 'On · lead calls are saved automatically' : 'Off · tap to set up'}
                href="/call-sync"
                badge={callSyncOn ? undefined : 'Set up'}
              />
            )}
            {contactsAllowed && (
              <Row
                icon="📇"
                title="Phone contacts"
                subtitle="Save people from your phone as leads"
                href="/contacts"
                divider={callSyncAllowed}
              />
            )}
          </View>
        </View>
      )}

      {/* Team (Admins and Team Leads) */}
      {(canSeeSyncHealth || activityAllowed) && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>TEAM</Text>
          <View style={styles.group}>
            {activityAllowed && (
              <>
                <Row icon="👥" title="Team activity" subtitle="Who is working, app time, calls" href="/activity" />
                <Row
                  icon="📜"
                  title="Change log"
                  subtitle="Who changed what on which lead"
                  href="/changes"
                  divider
                />
              </>
            )}
            {canSeeSyncHealth && (
            <Row
              icon="🩺"
              title="Sync health"
              subtitle={canManageUsers ? 'Call sync on every phone' : 'Call sync on your team’s phones'}
              href="/sync-health"
              badge={syncProblems > 0 ? `${syncProblems} ${syncProblems === 1 ? 'problem' : 'problems'}` : undefined}
              badgeTone="danger"
              divider={activityAllowed}
            />
            )}
          </View>
        </View>
      )}

      {/* Admin */}
      {(canManageUsers || canManageSettings) && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ADMIN</Text>
          <View style={styles.group}>
            {canManageUsers && (
              <Row
                icon="👥"
                title="Users"
                href="/users"
                badge={pendingCount > 0 ? `${pendingCount} waiting` : undefined}
              />
            )}
            {canManageSettings && (
              <Row icon="⚙️" title="Settings" href="/settings" divider={canManageUsers} />
            )}
          </View>
        </View>
      )}

      {/* About */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>ABOUT</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.rowTitle}>App version</Text>
            <Text style={styles.muted}>{Constants.expoConfig?.version ?? '—'}</Text>
          </View>
        </View>
      </View>

      <Button title="Sign out" variant="secondary" onPress={handleSignOut} loading={signingOut} fullWidth />
    </ScrollView>
  );
}

function Row({
  icon,
  title,
  subtitle,
  href,
  badge,
  badgeTone = 'warning',
  divider,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  href: Href;
  badge?: string;
  badgeTone?: 'warning' | 'danger';
  divider?: boolean;
}) {
  return (
    <Pressable
      onPress={() => router.push(href)}
      style={({ pressed }) => [styles.row, divider && styles.divider, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${title}, ${badge}` : title}
    >
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
      </View>
      {badge && (
        <View style={[styles.badge, badgeTone === 'danger' && styles.badgeDanger]}>
          <Text style={[styles.badgeText, badgeTone === 'danger' && styles.badgeTextDanger]}>{badge}</Text>
        </View>
      )}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.xl, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  name: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  roleBadge: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingVertical: 3,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  roleText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primaryDark },
  section: { gap: spacing.sm },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginLeft: spacing.xs,
  },
  group: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 52,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  pressed: { backgroundColor: colors.background },
  rowIcon: { fontSize: 20 },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowSubtitle: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  badge: {
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.warningSoft,
  },
  badgeDanger: { backgroundColor: colors.dangerSoft },
  badgeText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.warning },
  badgeTextDanger: { color: colors.danger },
  chevron: { fontSize: fontSize.heading, color: colors.textMuted },
});