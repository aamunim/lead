import { router, Stack, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { LIST_CONFIGS, type ListConfig } from '@/features/settings/lists';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

type Tile = {
  title: string;
  description: string;
  icon: string;
  href: Href;
};

const listTile = (config: ListConfig): Tile => ({
  title: config.title,
  description: config.description,
  icon: config.icon,
  href: `/settings/list/${config.table}` as Href,
});

// Pipeline stages have their own screen now (key, order, rules), not the simple list
const listsInGroup = (group: ListConfig['group']) =>
  Object.values(LIST_CONFIGS)
    .filter((c) => c.group === group && c.table !== 'pipeline_stages')
    .map(listTile);

const SECTIONS: { title: string; tiles: Tile[] }[] = [
  {
    title: 'ADMISSIONS',
    tiles: [
      {
        title: 'Courses & batches',
        description: 'Fees, batches and seats',
        icon: '🎓',
        href: '/settings/courses' as Href,
      },
      {
        title: 'Students tab',
        description: 'The admitted students’ own tab: on/off, who sees it',
        icon: '🎓',
        href: '/settings/students' as Href,
      },
      {
        title: 'Fee & discount',
        description: 'Negotiation, discount limits, payments, methods, receipts',
        icon: '💰',
        href: '/settings/fees' as Href,
      },
      {
        title: 'Admission rules',
        description: 'Who can admit or cancel, papers check, student ID, closed leads',
        icon: '📋',
        href: '/settings/admission' as Href,
      },
      {
        title: 'Required papers',
        description: 'Papers to collect, required or not, for which courses',
        icon: '📄',
        href: '/settings/papers' as Href,
      },
      ...listsInGroup('admissions'),
    ],
  },
  {
    title: 'LEADS',
    tiles: [
      {
        title: 'Pipeline stages',
        description: 'Steps a lead goes through, order and rules',
        icon: '🪜',
        href: '/settings/stages' as Href,
      },
      {
        title: 'Reports',
        description: 'Who sees reports, the Home card, which parts are shown',
        icon: '📊',
        href: '/settings/reports' as Href,
      },
      {
        title: 'Pipeline board',
        description: 'Board view on or off, Admitted / Lost columns, who can use it',
        icon: '📋',
        href: '/settings/board' as Href,
      },
      {
        title: 'Campus visit',
        description: 'On or off, what happens after a visit or a no-show',
        icon: '🏫',
        href: '/settings/visits' as Href,
      },
      ...listsInGroup('leads'),
      {
        title: 'Lead filters',
        description: 'Which filters users see, in what order',
        icon: '🔎',
        href: '/settings/filters' as Href,
      },
    ],
  },
  {
    title: 'OFFICE',
    tiles: [
      {
        title: 'Working days & holidays',
        description: 'Weekly off days, office hours, holidays',
        icon: '📅',
        href: '/settings/calendar' as Href,
      },
    ],
  },

  {
    title: 'DATA',
    tiles: [
      {
        title: 'Import leads',
        description: 'From Excel or CSV, with undo',
        icon: '📥',
        href: '/import' as Href,
      },
      {
        title: 'Export leads',
        description: 'Download leads as an Excel file',
        icon: '📤',
        href: '/export' as Href,
      },
      {
        title: 'Google Drive',
        description: 'Where lead files are saved, who sees them',
        icon: '📎',
        href: '/settings/drive' as Href,
      },
      {
        title: 'Message templates',
        description: 'WhatsApp / SMS templates, who can use them',
        icon: '💬',
        href: '/templates' as Href,
      },
      {
        title: 'Phone contacts access',
        description: 'Who can add leads from their phone contacts',
        icon: '📇',
        href: '/settings/contacts' as Href,
      },
    ],
  },

  {
    title: 'TEAM',
    tiles: [
      {
        title: 'Users',
        description: 'Approve, set roles, deactivate',
        icon: '👥',
        href: '/users' as Href,
      },
      {
        title: 'Lead assignment',
        description: 'Who gets new leads, who sees which leads',
        icon: '🧭',
        href: '/settings/assignment' as Href,
      },
      {
        title: 'Call log sync',
        description: 'Save lead calls from phones automatically',
        icon: '📞',
        href: '/settings/calls' as Href,
      },
      {
        title: 'Notifications',
        description: 'What sends a push, quiet hours, reminders, who can hand over leads',
        icon: '🔔',
        href: '/settings/notifications' as Href,
      },
      {
        title: 'Team activity',
        description: 'App time, who sees activity and the change log, idle and alert minutes',
        icon: '👁',
        href: '/settings/activity' as Href,
      },
      {
        title: 'Sync health',
        description: 'Whose phone is syncing, last sync, problems',
        icon: '🩺',
        href: '/sync-health' as Href,
      },
    ],
  },
];

export default function SettingsScreen() {
  const { hasPermission } = useAuth();

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Settings' }} />
        <Text style={styles.emptyTitle}>No access</Text>
        <Text style={styles.emptyText}>Only admins can change settings.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Settings' }} />

      {SECTIONS.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.sectionLabel}>{section.title}</Text>

          <View style={styles.group}>
            {section.tiles.map((tile, index) => (
              <Pressable
                key={tile.title}
                onPress={() => router.push(tile.href)}
                style={({ pressed }) => [
                  styles.tile,
                  index > 0 && styles.tileDivider,
                  pressed && styles.tilePressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${tile.title}. ${tile.description}`}
              >
                <View style={styles.tileIcon}>
                  <Text style={styles.tileIconText}>{tile.icon}</Text>
                </View>
                <View style={styles.tileBody}>
                  <Text style={styles.tileTitle}>{tile.title}</Text>
                  <Text style={styles.tileText}>{tile.description}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.xl, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
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
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  tileDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  tilePressed: { backgroundColor: colors.background },
  tileIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileIconText: { fontSize: 20 },
  tileBody: { flex: 1, gap: 2 },
  tileTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  tileText: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
  },
  chevron: {
    fontSize: fontSize.heading,
    color: colors.textMuted,
  },
  emptyTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  emptyText: {
    fontSize: fontSize.small,
    color: colors.textMuted,
    textAlign: 'center',
  },
});