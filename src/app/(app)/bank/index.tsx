import { Stack, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { MenuSheet, TextSheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  BANK_PAGE,
  bankSummary,
  deleteBankList,
  deleteBankRows,
  listBank,
  listBankIds,
  moveBankRows,
  renameBankList,
  restingDays,
  setBankDoNotCall,
  type BankQuery,
  type BankRow,
  type BankSummary,
  type BankTab,
} from '@/features/bank/api';
import { ImportSheet, PullSheet } from '@/features/bank/BankSheets';
import { MIcon, md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🏦 Lead Bank (admins): numbers kept aside, out of the lead list.
//   Tabs: 🆕 New (never in the leads) · ↩️ Returned (came back).
//   Mark → ➡️ into the leads (course, people in turn, stage), list,
//   ⛔ do not call, delete. 📥 bring numbers in (paste / Excel).
//   ⚡ A page of 50 and one request for the numbers.
// =====================================================================

function confirm(title: string, text: string, ok: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  return new Promise((resolve) =>
    Alert.alert(title, text, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}
function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

export default function LeadBankScreen() {
  const { hasPermission } = useAuth();
  const admin = hasPermission('settings.manage');
  // opened from the caller card: that number, in its tab
  const params = useLocalSearchParams<{ q?: string; tab?: string }>();
  const [tab, setTab] = useState<BankTab>(params.tab === 'returned' ? 'returned' : 'new');
  const [listId, setListId] = useState<string | null>(null);
  const [search, setSearch] = useState(typeof params.q === 'string' ? params.q : '');
  // a number looked up from the caller card may be resting: show those too
  const [resting, setResting] = useState(typeof params.q === 'string' && params.q !== '');
  const [dnc, setDnc] = useState(false);
  const [sum, setSum] = useState<BankSummary | null>(null);
  const [rows, setRows] = useState<BankRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<null | 'pull' | 'import' | 'more' | 'move' | 'list' | 'rename'>(null);
  const [listFor, setListFor] = useState<{ id: string; name: string } | null>(null);
  const reqId = useRef(0);

  // opened again from another caller card while this screen is open
  useEffect(() => {
    if (typeof params.q !== 'string' || !params.q) return;
    setSearch(params.q);
    setResting(true);
    setDnc(false);
    setListId(null);
    setTab(params.tab === 'returned' ? 'returned' : 'new');
  }, [params.q, params.tab]);

  const query = useMemo<BankQuery>(() => ({ tab, listId, search, resting, dnc }), [tab, listId, search, resting, dnc]);

  const loadSum = useCallback(() => {
    bankSummary()
      .then(setSum)
      .catch(() => undefined);
  }, []);
  const load = useCallback(
    async (p = 0) => {
      const id = ++reqId.current;
      try {
        const r = await listBank({ ...query, page: p });
        if (id !== reqId.current) return;
        setRows((old) => (p === 0 ? r.rows : [...(old ?? []), ...r.rows]));
        setTotal(r.total);
        setPage(p);
        setMore(r.rows.length === BANK_PAGE);
        setError(null);
      } catch (e) {
        if (id === reqId.current) setError(e instanceof Error ? e.message : 'Could not load.');
      }
    },
    [query],
  );

  useEffect(() => {
    if (!admin) return;
    loadSum();
  }, [admin, loadSum]);
  useEffect(() => {
    if (!admin) return;
    setSelected(new Set());
    const t = setTimeout(() => load(0), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [admin, load, search]);

  const refresh = async () => {
    setRefreshing(true);
    loadSum();
    await load(0);
    setRefreshing(false);
  };
  const changed = () => {
    setSelected(new Set());
    setSheet(null);
    loadSum();
    load(0);
  };

  const toggle = useCallback((id: string) => {
    setSelected((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = async () => {
    setBusy(true);
    try {
      setSelected(new Set(await listBankIds(query)));
    } catch (e) {
      say('Could not mark', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await work();
      changed();
      say('Done', done);
    } catch (e) {
      say('Could not do it', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!admin) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead Bank' }} />
        <Text style={ui.muted}>Only admins can open the Lead Bank.</Text>
      </View>
    );
  }

  const lists = sum?.lists ?? [];
  const ids = [...selected];
  const marked = rows?.filter((r) => selected.has(r.id)) ?? [];
  // all marked ones on the page are returned ones: no course needed (they keep theirs)
  const hasNew = tab === 'new' || marked.some((r) => !r.lead_id);

  const header = (
    <View style={styles.head}>
      {/* numbers */}
      <View style={styles.tiles}>
        <Tile value={sum?.new} label="New" tone={md.primaryC} />
        <Tile value={sum?.returned} label="Returned" tone={md.warnC} />
        <Tile value={sum?.in_leads} label="In the leads" tone={md.okC} />
        <Tile value={sum?.resting} label="Resting" tone={md.surface2} />
      </View>

      {/* the two tabs */}
      <View style={styles.tabs}>
        {(['new', 'returned'] as BankTab[]).map((t) => {
          const on = tab === t;
          const n = t === 'new' ? sum?.new : sum?.returned;
          return (
            <Tap key={t} onPress={() => setTab(t)} style={[styles.tab, on && styles.tabOn]} label={t}>
              <Text style={[styles.tabText, on && styles.tabTextOn]}>
                {t === 'new' ? '🆕 New' : '↩️ Returned'}
                {n !== undefined ? ` · ${n}` : ''}
              </Text>
            </Tap>
          );
        })}
      </View>

      {/* search */}
      <View style={styles.search}>
        <MIcon name="search" size={22} color={colors.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, number, area"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          accessibilityLabel="Search the bank"
        />
      </View>

      {/* lists (hold one to rename / delete it) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip text="All lists" on={!listId} onPress={() => setListId(null)} />
        {lists.map((l) => (
          <Pressable
            key={l.id}
            onLongPress={() => {
              setListFor({ id: l.id, name: l.name });
              setSheet('list');
            }}
            delayLongPress={400}
          >
            <Chip
              text={`${l.name} · ${tab === 'new' ? l.new : l.returned}`}
              on={listId === l.id}
              onPress={() => setListId(listId === l.id ? null : l.id)}
            />
          </Pressable>
        ))}
        {(sum?.no_list ?? 0) > 0 && <Chip text="No list" on={listId === 'none'} onPress={() => setListId('none')} />}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip text="⏳ Resting too" on={resting} onPress={() => setResting(!resting)} />
        <Chip text="⛔ Do not call" on={dnc} onPress={() => setDnc(!dnc)} />
      </ScrollView>

      <View style={styles.actions}>
        <View style={styles.flex}>
          <Button title="📥 Bring numbers in" onPress={() => setSheet('import')} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button
            title={busy ? 'Marking…' : `Mark all ${total}`}
            variant="secondary"
            onPress={selectAll}
            disabled={busy || total === 0}
            fullWidth
          />
        </View>
      </View>
      <Text style={ui.muted}>
        {total} {tab === 'new' ? 'new' : 'returned'}
        {resting ? '' : ' (resting ones hidden)'} · tap to mark
      </Text>
      {error && <Text style={ui.error}>{error}</Text>}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: selected.size ? `${selected.size} marked` : '🏦 Lead Bank' }} />
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.4}
        onEndReached={() => more && load(page + 1)}
        initialNumToRender={15}
        windowSize={7}
        extraData={selected}
        ListEmptyComponent={
          rows === null ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={[ui.muted, styles.centerText]}>
              {tab === 'new' ? 'No new numbers here. Bring some in with 📥.' : 'No returned numbers here.'}
            </Text>
          )
        }
        renderItem={({ item }) => <BankRowView r={item} marked={selected.has(item.id)} onToggle={toggle} />}
      />

      {selected.size > 0 && (
        <View style={styles.bar}>
          <View style={styles.flex2}>
            <Button
              title={`➡️ Into leads (${selected.size})`}
              onPress={() => setSheet('pull')}
              disabled={busy}
              fullWidth
            />
          </View>
          <View style={styles.flex}>
            <Button title="More" variant="secondary" onPress={() => setSheet('more')} disabled={busy} fullWidth />
          </View>
          <Tap onPress={() => setSelected(new Set())} label="Unmark all" style={styles.clear}>
            <MIcon name="close" color={colors.text} />
          </Tap>
        </View>
      )}

      {sheet === 'pull' && <PullSheet ids={ids} hasNew={hasNew} onClose={() => setSheet(null)} onDone={changed} />}
      {sheet === 'import' && (
        <ImportSheet
          lists={lists}
          listId={listId && listId !== 'none' ? listId : null}
          onClose={() => setSheet(null)}
          onDone={(r) => {
            changed();
            say(
              '📥 Done',
              `${r.added} added` +
                (r.in_bank ? ` · ${r.in_bank} already in the bank` : '') +
                (r.in_leads ? ` · ${r.in_leads} already leads` : '') +
                (r.invalid ? ` · ${r.invalid} not a mobile number` : ''),
            );
          }}
        />
      )}
      {sheet === 'more' && (
        <MenuSheet
          title={`${selected.size} marked`}
          onClose={() => setSheet(null)}
          items={[
            { label: 'Move to a list', icon: 'drive-file-move', onPress: () => setSheet('move') },
            dnc
              ? {
                  label: 'Do not call: off',
                  icon: 'do-not-disturb-off',
                  onPress: () => run(() => setBankDoNotCall(ids, false), `${ids.length} can be called again.`),
                }
              : {
                  label: '⛔ Do not call',
                  icon: 'do-not-disturb-on',
                  onPress: () => run(() => setBankDoNotCall(ids, true), `${ids.length} will never go into the leads.`),
                },
            {
              label: 'Delete from the bank',
              icon: 'delete-outline',
              danger: true,
              onPress: async () => {
                setSheet(null);
                if (
                  await confirm(
                    `Delete ${ids.length}?`,
                    tab === 'returned'
                      ? 'They leave the bank for good, and their old leads (with the history) are deleted too.'
                      : 'They leave the bank for good.',
                    'Delete',
                  )
                )
                  run(() => deleteBankRows(ids), `${ids.length} deleted.`);
              },
            },
          ]}
        />
      )}
      {sheet === 'move' && (
        <MenuSheet
          title="Move to which list?"
          onClose={() => setSheet(null)}
          items={[
            { label: 'No list', icon: 'layers-clear', onPress: () => run(() => moveBankRows(ids, null), 'Moved.') },
            ...lists.map((l) => ({
              label: l.name,
              icon: 'folder-open' as const,
              onPress: () => run(() => moveBankRows(ids, l.id), `Moved to ${l.name}.`),
            })),
          ]}
        />
      )}
      {sheet === 'list' && listFor && (
        <MenuSheet
          title={listFor.name}
          onClose={() => setSheet(null)}
          items={[
            { label: 'Rename', icon: 'edit', onPress: () => setSheet('rename') },
            {
              label: 'Delete the list (the numbers stay)',
              icon: 'delete-outline',
              danger: true,
              onPress: async () => {
                setSheet(null);
                if (
                  await confirm(`Delete “${listFor.name}”?`, 'Its numbers stay in the bank with no list.', 'Delete')
                ) {
                  if (listId === listFor.id) setListId(null);
                  run(() => deleteBankList(listFor.id), 'List deleted.');
                }
              },
            },
          ]}
        />
      )}
      {sheet === 'rename' && listFor && (
        <TextSheet
          title="Rename the list"
          placeholder={listFor.name}
          maxLength={80}
          onClose={() => setSheet(null)}
          onSave={async (name) => {
            await renameBankList(listFor.id, name);
            changed();
          }}
        />
      )}
    </View>
  );
}

function Tile({ value, label, tone }: { value: number | undefined; label: string; tone: string }) {
  return (
    <View style={[styles.tile, { backgroundColor: tone }]}>
      <Text style={styles.tileValue}>{value ?? '–'}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const BankRowView = memo(function BankRowView({
  r,
  marked,
  onToggle,
}: {
  r: BankRow;
  marked: boolean;
  onToggle: (id: string) => void;
}) {
  const rest = restingDays(r);
  return (
    <Pressable
      onPress={() => onToggle(r.id)}
      android_ripple={{ color: md.ripple }}
      style={[styles.row, marked && styles.rowOn]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: marked }}
      accessibilityLabel={r.name ?? r.phone}
    >
      <MIcon
        name={marked ? 'check-box' : 'check-box-outline-blank'}
        color={marked ? colors.primary : colors.textMuted}
      />
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {r.name ?? 'No name'}
          {r.do_not_call ? '  ⛔' : ''}
        </Text>
        <Text style={styles.phone}>
          📞 {r.phone}
          {r.whatsapp_number ? `  💬 ${r.whatsapp_number}` : ''}
        </Text>
        <Text style={ui.muted} numberOfLines={1}>
          {[r.list?.name ?? 'No list', r.area, ...(r.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(' · ')}
        </Text>
        {r.status === 'returned' && (
          <Text style={styles.returned} numberOfLines={2}>
            ↩️ {r.return_reason ?? 'Returned'}
            {r.returned_at
              ? ` · ${new Date(r.returned_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : ''}
            {r.times_pulled ? ` · out ${r.times_pulled}×` : ''}
            {rest ? ` · ⏳ rests ${rest} more day${rest === 1 ? '' : 's'}` : ''}
          </Text>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  centerText: { textAlign: 'center', marginTop: spacing.xl },
  content: { padding: spacing.lg, paddingBottom: 120 },
  head: { gap: spacing.sm, marginBottom: spacing.sm },
  flex: { flex: 1 },
  flex2: { flex: 2 },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: { flex: 1, padding: spacing.sm, borderRadius: radius.md, gap: 2 },
  tileValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  tileLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  tabs: { flexDirection: 'row', gap: spacing.sm },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: md.surface2,
    overflow: 'hidden',
  },
  tabOn: { backgroundColor: colors.primary },
  tabText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  tabTextOn: { color: colors.textOnPrimary },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: 24,
    backgroundColor: md.surface2,
  },
  searchInput: { flex: 1, fontSize: fontSize.body, color: colors.text },
  chips: { gap: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.xs,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  rowOn: { backgroundColor: md.primaryC },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  phone: { fontSize: fontSize.small, color: colors.text },
  returned: { fontSize: fontSize.small, color: md.onWarnC },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  clear: { padding: spacing.sm, borderRadius: radius.md, overflow: 'hidden' },
});
