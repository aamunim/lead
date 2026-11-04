import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  BOARD_PERIODS,
  boardRange,
  getBreakdown,
  getLeaderboard,
  giveCredits,
  kindInfo,
  setLeaderboardHidden,
  type BoardPeriod,
  type BoardRow,
  type BreakdownRow,
} from '@/features/credits/api';
import { MIcon, md } from '@/features/home/md';
import { isWeb } from '@/features/web/api';
import { colors, fontWeight } from '@/shared/theme';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🏆 Leaderboard: everyone's credits for the period, the top three on a
//   podium, your own place always in sight. Tap yourself for your
//   breakdown (the Super Admin: anyone's, leave out, give credits).
// =====================================================================

const ROLE: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  team_lead: 'Team Lead',
  caller: 'Caller',
  admission_officer: 'Admission Officer',
};
const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');
const initials = (n: string | null) =>
  (n ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';
const PAL = [
  [md.primaryC, md.onPrimaryC],
  ['#FFE0D6', '#9C2E00'],
  [md.okC, md.onOkC],
  [md.warnC, md.onWarnC],
  ['#F3DDF8', '#6A1B7A'],
];
const pal = (n: string | null) => PAL[[...(n ?? '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % PAL.length];

export default function LeaderboardScreen() {
  const { profile } = useAuth();
  const me = profile?.id ?? '';
  const superAdmin = profile?.role_key === 'super_admin';
  const [period, setPeriod] = useState<BoardPeriod>('week');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [prev, setPrev] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<BoardRow | null>(null);

  const range = useMemo(() => boardRange(period), [period]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [now, before] = await Promise.all([
        getLeaderboard(range.from, range.to),
        range.prev ? getLeaderboard(range.prev.from, range.prev.to).catch(() => []) : Promise.resolve([]),
      ]);
      setRows(now);
      setPrev(new Map(before.filter((r) => r.rank != null).map((r) => [r.user_id, r.rank as number])));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the leaderboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const ranked = rows.filter((r) => r.rank != null).sort((a, b) => (a.rank as number) - (b.rank as number));
  const hidden = rows.filter((r) => r.rank == null);
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const mine = rows.find((r) => r.user_id === me) ?? null;
  const ahead = mine?.rank ? ranked.filter((r) => r.total > mine.total).slice(-1)[0] : null;
  const move = (r: BoardRow) =>
    r.rank != null && prev.has(r.user_id) ? (prev.get(r.user_id) as number) - r.rank : null;

  const canOpen = (r: BoardRow) => r.user_id === me || superAdmin;
  const tap = (r: BoardRow) =>
    canOpen(r)
      ? setOpen(r)
      : Alert.alert(
          r.name ?? 'No name',
          `${fmt(r.total)} credits. Only the Super Admin sees other people’s breakdown.`,
        );

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: '🏆 Leaderboard', ...(isWeb ? { headerShown: false } : {}) }} />
      <ScrollView
        contentContainerStyle={[s.content, isWeb && s.webContent]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
      >
        {isWeb && <Text style={s.webTitle}>🏆 Leaderboard</Text>}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {BOARD_PERIODS.map((p) => {
            const on = period === p.value;
            return (
              <Pressable
                key={p.value}
                onPress={() => setPeriod(p.value)}
                style={[s.chip, on && s.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
              >
                {on && <MIcon name="check" size={15} color={md.onPrimaryC} />}
                <Text style={[s.chipText, on && s.chipTextOn]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : error ? (
          <View style={s.center}>
            <Text style={s.muted}>{error}</Text>
          </View>
        ) : (
          <>
            {/* 🙋 You */}
            {mine && (
              <Pressable onPress={() => setOpen(mine)} style={s.mine} accessibilityRole="button">
                <View style={s.mineRank}>
                  <Text style={s.mineRankText}>{mine.rank ? `#${mine.rank}` : '—'}</Text>
                </View>
                <View style={s.flex}>
                  <Text style={s.mineTitle}>
                    {fmt(mine.total)} credits
                    {move(mine) ? (
                      <Text style={{ color: (move(mine) as number) > 0 ? '#BFF5D4' : '#FFD3CE' }}>
                        {'  '}
                        {(move(mine) as number) > 0 ? '▲' : '▼'}
                        {Math.abs(move(mine) as number)}
                      </Text>
                    ) : null}
                  </Text>
                  <Text style={s.mineSub}>
                    {mine.hidden
                      ? 'You are left out of the leaderboard'
                      : mine.rank === 1
                        ? '🥇 You are at the top!'
                        : ahead
                          ? `#${ahead.rank} ${(ahead.name ?? '').split(' ')[0]} is ${fmt(ahead.total - mine.total)} ahead`
                          : 'Your place'}
                  </Text>
                </View>
                <MIcon name="chevron-right" size={22} color="#FFFFFF" />
              </Pressable>
            )}

            {/* 🥇🥈🥉 */}
            {top.length > 0 && (
              <View style={s.podium}>
                {[top[1], top[0], top[2]].map((r, i) =>
                  r ? (
                    <Pressable key={r.user_id} onPress={() => tap(r)} style={[s.step, i === 1 && s.stepFirst]}>
                      <Text style={s.medal}>
                        {r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`}
                      </Text>
                      <View style={[s.bigAvatar, i === 1 && s.bigAvatarFirst, { backgroundColor: pal(r.name)[0] }]}>
                        <Text style={[s.bigAvatarText, { color: pal(r.name)[1] }]}>{initials(r.name)}</Text>
                      </View>
                      <Text style={s.stepName} numberOfLines={1}>
                        {(r.name ?? 'No name').split(' ')[0]}
                      </Text>
                      <Text style={s.stepPts}>{fmt(r.total)}</Text>
                      <View
                        style={[s.block, { height: i === 1 ? 54 : i === 0 ? 38 : 26 }, r.user_id === me && s.blockMe]}
                      />
                    </Pressable>
                  ) : (
                    <View key={`e${i}`} style={s.step} />
                  ),
                )}
              </View>
            )}

            {/* Everyone else */}
            <View style={s.list}>
              {rest.map((r) => (
                <Row key={r.user_id} r={r} me={r.user_id === me} move={move(r)} onPress={() => tap(r)} />
              ))}
              {ranked.length === 0 && <Text style={[s.muted, s.pad]}>Nobody has credits in this period yet.</Text>}
            </View>

            {superAdmin && hidden.length > 0 && (
              <>
                <Text style={s.label}>LEFT OUT (ONLY YOU SEE THIS)</Text>
                <View style={s.list}>
                  {hidden.map((r) => (
                    <Row key={r.user_id} r={r} me={r.user_id === me} move={null} onPress={() => tap(r)} />
                  ))}
                </View>
              </>
            )}
            <Text style={s.foot}>
              Credits come from calls, talk time, WhatsApp, notes, next calls, leads, visits, papers, admissions,
              payments and app time. Pull down to refresh.
            </Text>
          </>
        )}
      </ScrollView>

      {open && (
        <BreakdownSheet
          row={open}
          from={range.from}
          to={range.to}
          superAdmin={superAdmin}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            load();
          }}
        />
      )}
    </View>
  );
}

function Row({ r, me, move, onPress }: { r: BoardRow; me: boolean; move: number | null; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} android_ripple={{ color: md.ripple }} style={[s.row, me && s.rowMe]}>
      <Text style={s.rank}>{r.rank ?? '—'}</Text>
      <View style={[s.avatar, { backgroundColor: pal(r.name)[0] }]}>
        <Text style={[s.avatarText, { color: pal(r.name)[1] }]}>{initials(r.name)}</Text>
      </View>
      <View style={s.flex}>
        <Text style={s.name} numberOfLines={1}>
          {r.name ?? 'No name'}
          {me ? ' (you)' : ''}
        </Text>
        <Text style={s.role}>{ROLE[r.role_key] ?? r.role_key}</Text>
      </View>
      {move ? (
        <Text style={[s.move, { color: move > 0 ? md.onOkC : md.onErrorC }]}>
          {move > 0 ? '▲' : '▼'}
          {Math.abs(move)}
        </Text>
      ) : null}
      <Text style={s.pts}>{fmt(r.total)}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------
// One person's credits, by kind
// ---------------------------------------------------------------------
function BreakdownSheet({
  row,
  from,
  to,
  superAdmin,
  onClose,
  onChanged,
}: {
  row: BoardRow;
  from: string;
  to: string;
  superAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [list, setList] = useState<BreakdownRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pts, setPts] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getBreakdown(row.user_id, from, to)
      .then(setList)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load.'));
  }, [row.user_id, from, to]);

  const max = Math.max(1, ...(list ?? []).map((b) => Math.abs(b.points)));

  const give = async () => {
    const n = parseInt(pts, 10);
    if (!n || !reason.trim())
      return Alert.alert('Credits and a reason', 'Write a number (minus to take away) and why.');
    setBusy(true);
    try {
      await giveCredits(row.user_id, n, reason);
      onChanged();
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={s.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={s.sheet}>
          <View style={s.handle} />
          <View style={s.sheetHead}>
            <View style={s.flex}>
              <Text style={s.sheetTitle}>{row.name ?? 'No name'}</Text>
              <Text style={s.muted}>
                {row.rank ? `#${row.rank} · ` : ''}
                {fmt(row.total)} credits
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <MIcon name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={s.sheetBody} keyboardShouldPersistTaps="handled">
            {err ? (
              <Text style={s.muted}>{err}</Text>
            ) : !list ? (
              <ActivityIndicator color={colors.primary} />
            ) : list.length === 0 ? (
              <Text style={s.muted}>No credits in this period yet.</Text>
            ) : (
              list.map((b) => {
                const k = kindInfo(b.kind);
                return (
                  <View key={b.kind} style={s.bRow}>
                    <Text style={s.bIcon}>{k.icon}</Text>
                    <View style={s.flex}>
                      <View style={s.bTop}>
                        <Text style={s.bLabel} numberOfLines={1}>
                          {k.label}
                        </Text>
                        <Text style={[s.bPts, b.points < 0 && { color: md.onErrorC }]}>
                          {b.points > 0 ? '+' : ''}
                          {fmt(b.points)}
                        </Text>
                      </View>
                      <View style={s.bTrack}>
                        <View
                          style={[
                            s.bFill,
                            {
                              width: `${(Math.abs(b.points) / max) * 100}%`,
                              backgroundColor: b.points < 0 ? md.onErrorC : k.color,
                            },
                          ]}
                        />
                      </View>
                      <Text style={s.bQty}>
                        {b.kind === 'payment'
                          ? `৳${fmt(b.qty)} taken`
                          : b.kind === 'app_time' || b.kind === 'talk_minute'
                            ? `${fmt(b.qty)} min`
                            : `${fmt(b.qty)} ×`}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}

            {superAdmin && (
              <View style={s.admin}>
                <Text style={s.label}>SUPER ADMIN</Text>
                <View style={s.switchRow}>
                  <View style={s.flex}>
                    <Text style={s.bLabel}>Leave out of the leaderboard</Text>
                    <Text style={s.muted}>Their credits still count; others won’t see them in the list.</Text>
                  </View>
                  <Switch
                    value={row.hidden}
                    onValueChange={async (v) => {
                      try {
                        await setLeaderboardHidden(row.user_id, v);
                        onChanged();
                      } catch (e) {
                        Alert.alert('Could not change', e instanceof Error ? e.message : '');
                      }
                    }}
                  />
                </View>
                <Text style={[s.bLabel, { marginTop: 14 }]}>⭐ Give or take credits</Text>
                <View style={s.giveRow}>
                  <TextInput
                    value={pts}
                    onChangeText={setPts}
                    keyboardType="numbers-and-punctuation"
                    placeholder="+20 or −10"
                    placeholderTextColor={colors.textMuted}
                    style={[s.input, s.inputPts]}
                  />
                  <TextInput
                    value={reason}
                    onChangeText={setReason}
                    placeholder="Why (e.g. great week)"
                    placeholderTextColor={colors.textMuted}
                    style={[s.input, s.flex]}
                  />
                </View>
                <Pressable onPress={give} disabled={busy} style={s.giveBtn} accessibilityRole="button">
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.giveText}>Save</Text>}
                </Pressable>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1, minWidth: 0 },
  content: { padding: 14, paddingBottom: 40, gap: 12 },
  webContent: { maxWidth: 760, width: '100%', alignSelf: 'center' },
  webTitle: { fontSize: 24, fontWeight: fontWeight.bold, color: colors.text },
  center: { padding: 40, alignItems: 'center' },
  muted: { fontSize: 13, color: colors.textMuted },
  pad: { padding: 16, textAlign: 'center' },
  chips: { gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: md.primaryC, borderColor: md.primaryC },
  chipText: { fontSize: 13, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: md.onPrimaryC },

  mine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: colors.primary,
  },
  mineRank: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mineRankText: { fontSize: 19, fontWeight: fontWeight.bold, color: '#FFFFFF' },
  mineTitle: { fontSize: 18, fontWeight: fontWeight.bold, color: '#FFFFFF' },
  mineSub: { fontSize: 12.5, color: 'rgba(255,255,255,0.88)', marginTop: 2 },

  podium: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 8 },
  step: { flex: 1, alignItems: 'center', gap: 4 },
  stepFirst: {},
  medal: { fontSize: 22 },
  bigAvatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  bigAvatarFirst: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: '#F5B700' },
  bigAvatarText: { fontSize: 18, fontWeight: fontWeight.bold },
  stepName: { fontSize: 13, fontWeight: fontWeight.semibold, color: colors.text, maxWidth: '100%' },
  stepPts: { fontSize: 15, fontWeight: fontWeight.bold, color: colors.primary },
  block: { alignSelf: 'stretch', borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: md.primaryC },
  blockMe: { backgroundColor: colors.primary },

  list: { borderRadius: 18, overflow: 'hidden', backgroundColor: colors.surface },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    minHeight: 58,
    borderTopWidth: 1,
    borderTopColor: md.surface2,
  },
  rowMe: { backgroundColor: '#EEF2FF' },
  rank: { width: 24, textAlign: 'center', fontSize: 14, fontWeight: fontWeight.bold, color: colors.textMuted },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 13, fontWeight: fontWeight.semibold },
  name: { fontSize: 14.5, fontWeight: fontWeight.semibold, color: colors.text },
  role: { fontSize: 12, color: colors.textMuted },
  move: { fontSize: 12, fontWeight: fontWeight.bold },
  pts: { fontSize: 16, fontWeight: fontWeight.bold, color: colors.text, minWidth: 48, textAlign: 'right' },
  label: { fontSize: 11.5, fontWeight: fontWeight.bold, letterSpacing: 0.8, color: colors.textMuted, marginTop: 6 },
  foot: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: 4 },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    paddingTop: 8,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: colors.surface,
  },
  handle: { alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: md.outline },
  sheetHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6 },
  sheetTitle: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.text },
  sheetBody: { paddingHorizontal: 18, paddingBottom: 24, gap: 12 },
  bRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bIcon: { fontSize: 18, width: 26, textAlign: 'center', marginTop: 1 },
  bTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bLabel: { flex: 1, fontSize: 14, fontWeight: fontWeight.semibold, color: colors.text },
  bPts: { fontSize: 14, fontWeight: fontWeight.bold, color: colors.text },
  bTrack: { height: 6, borderRadius: 3, backgroundColor: md.surface2, marginTop: 5, overflow: 'hidden' },
  bFill: { height: '100%', borderRadius: 3 },
  bQty: { fontSize: 11.5, color: colors.textMuted, marginTop: 3 },
  admin: { marginTop: 8, padding: 12, borderRadius: 14, backgroundColor: md.surface1, gap: 6 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  giveRow: { flexDirection: 'row', gap: 8 },
  input: {
    height: 42,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: md.outline,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 14,
  },
  inputPts: { width: 96 },
  giveBtn: {
    height: 42,
    marginTop: 4,
    borderRadius: 21,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  giveText: { fontSize: 14, fontWeight: fontWeight.semibold, color: '#FFFFFF' },
});
