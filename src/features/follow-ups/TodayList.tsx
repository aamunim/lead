import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  formatDue,
  isOverdue,
  isReviveFollowUp,
  listDueFollowUps,
  startOfDay,
  type DueFollowUp,
} from '@/features/follow-ups/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

const RATING_COLOR: Record<string, string> = {
  hot: colors.hot,
  warm: colors.warm,
  cold: colors.cold,
};

const SHOW_FIRST = 8;

type Scope = 'mine' | 'all';

/** Follow-ups made automatically from a lead's missed call */
const isMissedCall = (f: DueFollowUp) => (f.note ?? '').startsWith('📵 Missed call');

/** Order: missed calls first (they are waiting for us), then ♻️ Revive, then by time */
const rank = (f: DueFollowUp) => (isMissedCall(f) ? 0 : isReviveFollowUp(f) ? 1 : 2);

export function TodayList() {
  const { profile, hasPermission, assignmentOn, sharedMode } = useAuth();

  // Can this user see other people's follow-ups? (by role, or everyone sees all)
  const canSeeOthers = sharedMode || hasPermission('leads.view_all') || hasPermission('leads.view_team');
  const [scope, setScope] = useState<Scope>('mine');

  const [items, setItems] = useState<DueFollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // "Mine" means:
  //   assignment on  → leads assigned to me
  //   assignment off → follow-ups I set myself
  const load = useCallback(async () => {
    try {
      setError(null);
      const mine = !canSeeOthers || scope === 'mine';
      const options = !mine
        ? {}
        : assignmentOn
          ? { userId: profile?.id }
          : { createdBy: profile?.id };
      const data = await listDueFollowUps(options);
      // The list comes sorted by time; keep that order inside each group
      data.sort((a, b) => rank(a) - rank(b));
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load today’s calls.');
    } finally {
      setLoading(false);
    }
  }, [scope, profile?.id, assignmentOn, canSeeOthers]);

  // Reload every time Home comes back into view (e.g. after a call)
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const todayStart = startOfDay(new Date()).getTime();
  const missed = items.filter(isMissedCall);
  const revive = items.filter((f) => !isMissedCall(f) && isReviveFollowUp(f));
  const normal = items.filter((f) => !isMissedCall(f) && !isReviveFollowUp(f));
  const overdue = normal.filter((f) => new Date(f.due_at).getTime() < todayStart);
  const today = normal.filter((f) => new Date(f.due_at).getTime() >= todayStart);
  const visible = showAll ? items : items.slice(0, SHOW_FIRST);

  const mineHint = scope === 'mine' && canSeeOthers && !assignmentOn ? ' · set by you' : '';

  return (
    <View style={styles.card}>
      {/* Title + counts */}
      <View style={styles.headerRow}>
        <View style={styles.flex}>
          <Text style={styles.title}>Today’s calls</Text>
          {!loading && !error && (
            <Text style={styles.subtitle}>
              {missed.length > 0 && <Text style={styles.missedCount}>{missed.length} missed · </Text>}
              {revive.length > 0 && <Text style={styles.reviveCount}>{revive.length} revive · </Text>}
              {today.length} today
              {overdue.length > 0 ? ` · ` : ''}
              {overdue.length > 0 && <Text style={styles.overdueCount}>{overdue.length} overdue</Text>}
              {mineHint}
            </Text>
          )}
        </View>

        {canSeeOthers && (
          <View style={styles.toggle}>
            {(['mine', 'all'] as Scope[]).map((s) => (
              <Pressable
                key={s}
                onPress={() => {
                  setScope(s);
                  setShowAll(false);
                  setLoading(true);
                }}
                style={[styles.toggleBtn, scope === s && styles.toggleBtnOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: scope === s }}
              >
                <Text style={[styles.toggleText, scope === s && styles.toggleTextOn]}>
                  {s === 'mine' ? 'Mine' : 'All'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* Body */}
      {loading ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : error ? (
        <Pressable onPress={load} accessibilityRole="button">
          <Text style={styles.error}>{error} Tap to try again.</Text>
        </Pressable>
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🎉</Text>
          <Text style={styles.emptyText}>No calls due today.</Text>
        </View>
      ) : (
        <>
          {visible.map((f) => {
            if (!f.lead) return null;
            const missedCall = isMissedCall(f);
            const reviveCall = !missedCall && isReviveFollowUp(f);
            const late = !missedCall && !reviveCall && isOverdue(f.due_at);
            const ratingColor = f.lead.rating ? RATING_COLOR[f.lead.rating] : null;
            return (
              <Pressable
                key={f.id}
                onPress={() => router.push(`/leads/${f.lead!.id}` as Href)}
                style={({ pressed }) => [
                  styles.row,
                  missedCall && styles.rowMissed,
                  reviveCall && styles.rowRevive,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${f.lead.name}, ${
                  missedCall
                    ? 'missed call, call back'
                    : reviveCall
                      ? 'lost lead, try again'
                      : formatDue(f.due_at)
                }${late ? ', overdue' : ''}`}
              >
                {missedCall ? (
                  <Text style={styles.rowIcon}>📵</Text>
                ) : reviveCall ? (
                  <Text style={styles.rowIcon}>♻️</Text>
                ) : (
                  <View style={[styles.dot, { backgroundColor: late ? colors.danger : colors.primary }]} />
                )}
                <View style={styles.flex}>
                  <View style={styles.nameRow}>
                    <Text style={styles.name} numberOfLines={1}>
                      {f.lead.name}
                    </Text>
                    {ratingColor && (
                      <View style={[styles.rating, { backgroundColor: ratingColor + '22' }]}>
                        <Text style={[styles.ratingText, { color: ratingColor }]}>
                          {f.lead.rating!.toUpperCase()}
                        </Text>
                      </View>
                    )}
                  </View>
                  {missedCall ? (
                    <Text style={styles.missedText}>
                      Missed call · {formatDue(f.due_at)} · Call back
                    </Text>
                  ) : reviveCall ? (
                    <>
                      <Text style={styles.reviveText}>
                        Revive · {f.lead.stage?.kind === 'lost' ? 'Lost lead' : 'Try again'} · {formatDue(f.due_at)}
                      </Text>
                      {f.note && (
                        <Text style={styles.note} numberOfLines={1}>
                          {f.note.replace(/^♻️\s*/, '')}
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      <Text style={[styles.due, late && styles.dueLate]}>
                        {formatDue(f.due_at)}
                        {late ? ' · Overdue' : ''}
                        {f.lead.stage ? ` · ${f.lead.stage.name}` : ''}
                      </Text>
                      {f.note && (
                        <Text style={styles.note} numberOfLines={1}>
                          {f.note}
                        </Text>
                      )}
                    </>
                  )}
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            );
          })}

          {items.length > SHOW_FIRST && (
            <Pressable onPress={() => setShowAll((v) => !v)} style={styles.more} accessibilityRole="button">
              <Text style={styles.moreText}>
                {showAll ? 'Show less' : `Show all ${items.length}`}
              </Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  overdueCount: { color: colors.danger, fontWeight: fontWeight.bold },
  missedCount: { color: colors.danger, fontWeight: fontWeight.bold },
  reviveCount: { color: colors.success, fontWeight: fontWeight.bold },
  toggle: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  toggleBtn: { paddingVertical: 6, paddingHorizontal: spacing.md },
  toggleBtnOn: { backgroundColor: colors.primary },
  toggleText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  toggleTextOn: { color: colors.textOnPrimary },
  loader: { paddingVertical: spacing.lg },
  error: { fontSize: fontSize.small, color: colors.danger },
  empty: { alignItems: 'center', paddingVertical: spacing.md, gap: spacing.xs },
  emptyIcon: { fontSize: 28 },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowMissed: {
    backgroundColor: colors.dangerSoft,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderTopWidth: 0,
    marginTop: 2,
  },
  rowRevive: {
    backgroundColor: colors.successSoft,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderTopWidth: 0,
    marginTop: 2,
  },
  pressed: { opacity: 0.6 },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  rowIcon: { fontSize: 16 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  rating: { paddingVertical: 1, paddingHorizontal: spacing.sm, borderRadius: radius.pill },
  ratingText: { fontSize: 10, fontWeight: fontWeight.bold },
  due: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  dueLate: { color: colors.danger, fontWeight: fontWeight.semibold },
  missedText: { fontSize: fontSize.caption, color: colors.danger, fontWeight: fontWeight.semibold, marginTop: 2 },
  reviveText: { fontSize: fontSize.caption, color: colors.success, fontWeight: fontWeight.semibold, marginTop: 2 },
  note: { fontSize: fontSize.caption, color: colors.text, marginTop: 2 },
  chevron: { fontSize: 22, color: colors.textMuted },
  more: { alignItems: 'center', paddingTop: spacing.sm },
  moreText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});