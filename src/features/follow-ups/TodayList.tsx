import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';

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

const SHOW_FIRST = 3;

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
      const options = !mine ? {} : assignmentOn ? { userId: profile?.id } : { createdBy: profile?.id };
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
      {/* Title, counts, Mine / All */}
      <View style={styles.head}>
        <View style={styles.headIcon}>
          <MIcon name="call" size={18} color={md.onPrimaryC} />
        </View>
        <Text style={styles.title}>Next calls</Text>
        {!loading && !error && (
          <Text style={styles.subtitle} numberOfLines={1}>
            <Text style={styles.strong}>{today.length + revive.length + missed.length}</Text> today
            {overdue.length > 0 && (
              <>
                {' · '}
                <Text style={styles.overdueCount}>{overdue.length}</Text> late
              </>
            )}
          </Text>
        )}
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
                <Text style={[styles.toggleText, scope === sc && styles.toggleTextOn]}>
                  {sc === 'mine' ? 'Mine' : 'All'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      {!!mineHint && <Text style={styles.hint}>{mineHint.replace(' · ', '')}</Text>}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : error ? (
        <Pressable onPress={load} accessibilityRole="button" style={styles.emptyBox}>
          <Text style={styles.error}>{error} Tap to try again.</Text>
        </Pressable>
      ) : items.length === 0 ? (
        <View style={styles.emptyBox}>
          <MIcon name="celebration" size={22} color={colors.primary} />
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
            const chip = missedCall
              ? { text: 'Missed', bg: md.errorC, fg: md.onErrorC }
              : reviveCall
                ? { text: 'Revive', bg: md.okC, fg: md.onOkC }
                : late
                  ? { text: 'Late', bg: md.errorC, fg: md.onErrorC }
                  : { text: timeOf(f.due_at), bg: md.surface1, fg: colors.textMuted };
            const sub = f.lead.stage?.name ?? '';
            return (
              <Tap
                key={f.id}
                onPress={() => router.push(`/leads/${f.lead!.id}` as Href)}
                style={styles.row}
                label={`${f.lead.name}, ${chip.text}${f.note ? `, ${f.note}` : ''}`}
              >
                <Avatar name={f.lead.name} size={30} />
                <Text style={styles.name} numberOfLines={1}>
                  {f.lead.name}
                  {!!sub && <Text style={styles.sub}> {sub}</Text>}
                </Text>
                {ratingColor && <View style={[styles.ratingDot, { backgroundColor: ratingColor }]} />}
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
                    <MIcon name="call" size={17} color={md.onOkC} />
                  </Tap>
                )}
              </Tap>
            );
          })}

          {items.length > SHOW_FIRST && (
            <Tap
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
                setShowAll((v) => !v);
              }}
              style={styles.more}
              label={showAll ? 'Show less' : `Show all ${items.length}`}
            >
              <Text style={styles.moreText}>{showAll ? 'Show less' : `Show all ${items.length}`}</Text>
              <MIcon name={showAll ? 'expand-less' : 'expand-more'} size={18} color={colors.primary} />
            </Tap>
          )}
        </>
      )}
    </View>
  );
}

/** 11:30 am */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const styles = StyleSheet.create({
  card: { ...card, marginTop: 10 },
  head: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 10 },
  headIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: md.primaryC,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  subtitle: { flex: 1, textAlign: 'right', fontSize: fontSize.caption, color: colors.textMuted },
  strong: { fontWeight: fontWeight.semibold, color: colors.text },
  overdueCount: { color: md.onErrorC, fontWeight: fontWeight.bold },
  hint: { fontSize: 11, color: colors.textMuted, paddingHorizontal: 14, marginTop: -8, marginBottom: 6 },
  toggle: { flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: md.outline, overflow: 'hidden' },
  toggleBtn: { paddingVertical: 3, paddingHorizontal: 8 },
  toggleBtnOn: { backgroundColor: md.primaryC },
  toggleText: { fontSize: 11, fontWeight: fontWeight.semibold, color: colors.text },
  toggleTextOn: { color: md.onPrimaryC },
  loader: { paddingVertical: spacing.lg },
  error: { fontSize: fontSize.small, color: colors.danger },
  emptyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: md.surface2,
  },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted },
  row: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 12,
    paddingRight: 10,
    borderTopWidth: 1,
    borderTopColor: md.surface2,
  },
  name: { flex: 1, fontSize: 13.5, fontWeight: fontWeight.semibold, color: colors.text },
  sub: { fontSize: 12, fontWeight: fontWeight.regular, color: colors.textMuted },
  ratingDot: { width: 7, height: 7, borderRadius: 4 },
  chip: { paddingVertical: 2, paddingHorizontal: 7, borderRadius: 7 },
  chipText: { fontSize: 11, fontWeight: fontWeight.semibold },
  callBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: md.okC,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  more: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderTopWidth: 1,
    borderTopColor: md.surface2,
  },
  moreText: { fontSize: 12.5, fontWeight: fontWeight.semibold, color: colors.primary },
});
