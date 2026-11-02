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
import { Avatar, MIcon, Tap, card, md } from '@/features/home/md';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

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
    <View>
      {/* Title, counts, Mine / All */}
      <View style={styles.headerRow}>
        <View style={styles.flex}>
          <Text style={styles.title}>Next calls</Text>
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
            {(['mine', 'all'] as Scope[]).map((sc) => (
              <Pressable
                key={sc}
                onPress={() => {
                  setScope(sc);
                  setShowAll(false);
                  setLoading(true);
                }}
                style={[styles.toggleBtn, scope === sc && styles.toggleBtnOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: scope === sc }}
              >
                {scope === sc && <MIcon name="check" size={14} color={md.onPrimaryC} />}
                <Text style={[styles.toggleText, scope === sc && styles.toggleTextOn]}>
                  {sc === 'mine' ? 'Mine' : 'All'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <View style={styles.card}>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : error ? (
          <Pressable onPress={load} accessibilityRole="button" style={styles.emptyBox}>
            <Text style={styles.error}>{error} Tap to try again.</Text>
          </Pressable>
        ) : items.length === 0 ? (
          <View style={styles.emptyBox}>
            <MIcon name="celebration" size={32} color={colors.primary} />
            <Text style={styles.emptyText}>No calls due today.</Text>
          </View>
        ) : (
          <>
            {visible.map((f, i) => {
              if (!f.lead) return null;
              const missedCall = isMissedCall(f);
              const reviveCall = !missedCall && isReviveFollowUp(f);
              const late = !missedCall && !reviveCall && isOverdue(f.due_at);
              const ratingColor = f.lead.rating ? RATING_COLOR[f.lead.rating] : null;
              const chip = missedCall
                ? { text: 'Missed', bg: md.errorC, fg: md.onErrorC }
                : reviveCall
                  ? { text: 'Revive', bg: md.okC, fg: md.onOkC }
                  : late
                    ? { text: 'Late', bg: md.errorC, fg: md.onErrorC }
                    : { text: timeOf(f.due_at), bg: md.surface1, fg: colors.textMuted };
              const line = missedCall
                ? `Missed call · ${formatDue(f.due_at)}`
                : reviveCall
                  ? `${f.lead.stage?.kind === 'lost' ? 'Lost lead' : 'Try again'}${f.note ? ` · ${f.note.replace(/^♻️\s*/, '')}` : ''}`
                  : [f.lead.stage?.name, f.note].filter(Boolean).join(' · ') || formatDue(f.due_at);
              return (
                <Tap
                  key={f.id}
                  onPress={() => router.push(`/leads/${f.lead!.id}` as Href)}
                  style={[styles.row, i > 0 && styles.rowLine]}
                  label={`${f.lead.name}, ${chip.text}`}
                >
                  <Avatar name={f.lead.name} />
                  <View style={styles.flex}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={1}>
                        {f.lead.name}
                      </Text>
                      {ratingColor && <View style={[styles.ratingDot, { backgroundColor: ratingColor }]} />}
                    </View>
                    <Text style={styles.line} numberOfLines={2}>
                      {line}
                    </Text>
                  </View>
                  <View style={[styles.chip, { backgroundColor: chip.bg }]}>
                    <Text style={[styles.chipText, { color: chip.fg }]}>{chip.text}</Text>
                  </View>
                  {!!f.lead.phone && (
                    <Tap
                      onPress={() =>
                        router.push({ pathname: '/leads/[id]', params: { id: f.lead!.id, dial: '1' } } as unknown as Href)
                      }
                      style={styles.callBtn}
                      label={`Call ${f.lead.name}`}
                      rippleColor="rgba(31,107,66,0.2)"
                    >
                      <MIcon name="call" size={20} color={md.onOkC} />
                    </Tap>
                  )}
                </Tap>
              );
            })}

            {items.length > SHOW_FIRST && (
              <Tap onPress={() => setShowAll((v) => !v)} style={styles.more} label="Show more">
                <Text style={styles.moreText}>{showAll ? 'Show less' : `Show all ${items.length}`}</Text>
              </Tap>
            )}
          </>
        )}
      </View>
    </View>
  );
}

/** 11:30 am */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: 22, marginBottom: 8, paddingHorizontal: 2 },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  subtitle: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  overdueCount: { color: colors.danger, fontWeight: fontWeight.bold },
  missedCount: { color: colors.danger, fontWeight: fontWeight.bold },
  reviveCount: { color: colors.success, fontWeight: fontWeight.bold },
  toggle: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: md.outline,
    overflow: 'hidden',
  },
  toggleBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 5, paddingHorizontal: spacing.md },
  toggleBtnOn: { backgroundColor: md.primaryC },
  toggleText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  toggleTextOn: { color: md.onPrimaryC },
  card: { ...card },
  loader: { paddingVertical: spacing.xl },
  error: { fontSize: fontSize.small, color: colors.danger },
  emptyBox: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 14 },
  rowLine: { borderTopWidth: 1, borderTopColor: md.surface2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, fontSize: 15, fontWeight: fontWeight.semibold, color: colors.text },
  ratingDot: { width: 8, height: 8, borderRadius: 4 },
  line: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  chip: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8 },
  chipText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  callBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: md.okC,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  more: { alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: md.surface2 },
  moreText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});
