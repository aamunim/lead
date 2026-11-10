import { router, type Href } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Fold, md } from '@/features/home/md';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

import { SEVERITY, supervisorHome, type SupervisorHome } from './api';

// =====================================================================
// 🧑‍💼 Home: the supervisor in one card — what needs me now, who to call
//   first, and (Team Leads / admins) the team's count. One small request.
// =====================================================================

export function SupervisorHomeCard() {
  const [data, setData] = useSavedState<SupervisorHome | null>('home:supervisor', null);

  useFocusRefresh(
    useCallback(() => {
      supervisorHome()
        .then(setData)
        .catch(() => undefined);
    }, [setData]),
  );

  if (!data || !data.enabled) return null;
  const me = data.me;
  const team = data.team;
  const mine = me.urgent + me.today + me.improve;
  const teamOpen = team ? team.urgent + team.today + team.improve : 0;
  if (mine === 0 && data.tasks.length === 0 && teamOpen === 0) return null;

  const summary = [
    me.urgent ? `${SEVERITY.urgent.icon} ${me.urgent}` : null,
    me.today ? `${SEVERITY.today.icon} ${me.today}` : null,
    data.tasks.length ? `📋 ${data.tasks.length}` : null,
    team && teamOpen ? `👥 ${teamOpen}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Fold
      id="supervisor"
      icon="support-agent"
      tint={{ bg: md.purpleC, fg: md.onPurpleC }}
      title="সুপারভাইজার"
      summary={summary}
      defaultOpen
    >
      {/* what needs me */}
      {data.top.map((f) => (
        <Pressable
          key={f.id}
          onPress={() => router.push((f.lead_id ? `/leads/${f.lead_id}` : '/supervisor?tab=issues') as Href)}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Text style={styles.dot}>{SEVERITY[f.severity].icon}</Text>
          <View style={styles.flex}>
            <Text style={styles.title} numberOfLines={1}>
              {f.title}
            </Text>
            {!!f.detail && (
              <Text style={styles.sub} numberOfLines={1}>
                {f.detail}
              </Text>
            )}
          </View>
        </Pressable>
      ))}

      {/* who to call first */}
      {data.tasks.length > 0 && (
        <>
          <Text style={styles.label}>আগে যাদের কল করবেন</Text>
          {data.tasks.slice(0, 3).map((t) => (
            <Pressable
              key={t.lead_id}
              onPress={() => router.push(`/leads/${t.lead_id}` as Href)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <View style={styles.flex}>
                <Text style={styles.title} numberOfLines={1}>
                  {t.name}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {t.reason}
                </Text>
              </View>
            </Pressable>
          ))}
        </>
      )}

      {/* the team (Team Leads / admins) */}
      {team && teamOpen > 0 && (
        <Pressable
          onPress={() => router.push('/supervisor?tab=team' as Href)}
          style={({ pressed }) => [styles.team, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Text style={styles.teamText}>
            👥 টিম: {team.urgent ? `🔴 ${team.urgent} · ` : ''}
            {team.today ? `🟠 ${team.today} · ` : ''}
            {team.improve ? `🟢 ${team.improve} · ` : ''}
            {team.people} জন
          </Text>
        </Pressable>
      )}

      <View style={styles.footer}>
        <Pressable onPress={() => router.push('/supervisor' as Href)} hitSlop={8} accessibilityRole="button">
          <Text style={styles.all}>সব দেখুন ›</Text>
        </Pressable>
      </View>
    </Fold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  pressed: { opacity: 0.7 },
  dot: { fontSize: 12 },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  sub: { fontSize: fontSize.caption, color: colors.textMuted },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.primary,
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  team: { marginTop: spacing.xs, padding: spacing.sm, borderRadius: 12, backgroundColor: md.purpleC },
  teamText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: md.onPurpleC },
  footer: { alignItems: 'flex-end', paddingTop: 2 },
  all: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
