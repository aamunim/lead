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
  createBankList,
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
import { BankPeekSheet } from '@/features/bank/BankPeekSheet';
import { ImportSheet, PullSheet } from '@/features/bank/BankSheets';
import { Avatar, MIcon, md, Tap, type MIconName } from '@/features/home/md';
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
  const [sheet, setSheet] = useState<
    null | 'peek' | 'pull' | 'import' | 'more' | 'move' | 'list' | 'rename' | 'newlist' | 'newlist-move'
  >(null);
  // the one number opened (its peek, and what is done from there)
  const [focus, setFocus] = useState<BankRow | null>(null);
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
  const queryNow = useRef(query);
  useEffect(() => {
    queryNow.current = query;
  }, [query]);

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
    // the old filter's pages: no more of them (and one still on its way is dropped)
    setMore(false);
    reqId.current++;
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
    setFocus(null);
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

  const open = useCallback((r: BankRow) => {
    setFocus(r);
    setSheet('peek');
  }, []);

  const selectAll = async () => {
    setBusy(true);
    try {
      const asked = query;
      const ids = await listBankIds(asked);
      // the filter changed meanwhile: these ids are not what is on the screen
      if (queryNow.current === asked) setSelected(new Set(ids));
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
  // one number (from its peek) or the marked ones
  const ids = focus ? [focus.id] : [...selected];
  const marked = rows?.filter((r) => selected.has(r.id)) ?? [];
  // all marked ones on the page are returned ones: no course needed (they keep theirs)
  const hasNew = focus ? !focus.lead_id : tab === 'new' || marked.some((r) => !r.lead_id);
  const selecting = selected.size > 0;
  const theList = listId && listId !== 'none' ? lists.find((l) => l.id === listId) : undefined;
  const closeSheet = () => {
    setSheet(null);
    setFocus(null);
  };

  const header = (
    <View style={styles.head}>
      {/* the numbers at a glance */}
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroIcon}>
            <MIcon name="savings" size={26} color={md.onPrimaryC} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.heroTitle}>Lead Bank</Text>
            <Text style={styles.heroSub}>Numbers kept aside, out of the lead list</Text>
          </View>
        </View>
        <View style={styles.tiles}>
          <Tile value={sum?.new} label="New" icon="fiber-new" tone={md.primaryC} ink={md.onPrimaryC} />
          <Tile value={sum?.returned} label="Returned" icon="undo" tone={md.warnC} ink={md.onWarnC} />
          <Tile value={sum?.in_leads} label="In leads" icon="arrow-forward" tone={md.okC} ink={md.onOkC} />
          <Tile value={sum?.resting} label="Resting" icon="hourglass-empty" tone={md.surface2} ink={colors.textMuted} />
        </View>
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
                {n !== undefined ? `  ${n}` : ''}
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
        {search ? (
          <Tap onPress={() => setSearch('')} label="Clear the search" style={styles.searchClear}>
            <MIcon name="close" size={20} color={colors.textMuted} />
          </Tap>
        ) : null}
      </View>

      {/* lists */}
      <View style={styles.sectionRow}>
        <Text style={ui.label}>LISTS</Text>
        <Tap onPress={() => setSheet('newlist')} label="New list" style={styles.link}>
          <MIcon name="add" size={18} color={colors.primary} />
          <Text style={styles.linkText}>New list</Text>
        </Tap>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip text="All" on={!listId} onPress={() => setListId(null)} />
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
      {lists.length === 0 && sum && (
        <Text style={ui.muted}>Make lists like “Education fair 2026” to keep numbers in groups.</Text>
      )}

      {/* the chosen list: how it did */}
      {theList && (
        <View style={styles.listCard}>
          <View style={styles.listTop}>
            <MIcon name="folder-open" color={md.onPrimaryC} />
            <Text style={styles.listName} numberOfLines={1}>
              {theList.name}
            </Text>
            <Tap
              onPress={() => {
                setListFor({ id: theList.id, name: theList.name });
                setSheet('rename');
              }}
              label="Rename the list"
              style={styles.iconBtn}
            >
              <MIcon name="edit" size={20} color={md.onPrimaryC} />
            </Tap>
            <Tap
              onPress={() => {
                setListFor({ id: theList.id, name: theList.name });
                setSheet('list');
              }}
              label="More for the list"
              style={styles.iconBtn}
            >
              <MIcon name="more-vert" size={20} color={md.onPrimaryC} />
            </Tap>
          </View>
          <Text style={styles.listStats}>
            🆕 {theList.new} new · ↩️ {theList.returned} returned · ➡️ {theList.in_leads} in leads · 🎓{' '}
            {theList.admitted} admitted
          </Text>
        </View>
      )}

      {/* filters */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip text="⏳ Resting too" on={resting} onPress={() => setResting(!resting)} />
        <Chip text="⛔ Do not call" on={dnc} onPress={() => setDnc(!dnc)} />
      </ScrollView>

      <View style={styles.actions}>
        <View style={styles.flex}>
          <Button title="📥 Add numbers" onPress={() => setSheet('import')} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button
            title={busy && !selecting ? 'Marking…' : `☑ Mark all ${Math.min(total, 2000)}`}
            variant="secondary"
            onPress={selectAll}
            disabled={busy || total === 0}
            fullWidth
          />
        </View>
      </View>
      <Text style={ui.muted}>
        {total} {tab === 'new' ? 'new' : 'returned'}
        {resting ? '' : ' (resting ones hidden)'}
        {selecting ? ' · tap to mark more' : ' · tap one to see it, hold to mark'}
      </Text>
      {error && <Text style={ui.error}>{error}</Text>}
    </View>
  );

  const deleteIds = async (list: string[], returnedOnes: boolean) => {
    if (
      await confirm(
        `Delete ${list.length === 1 ? 'this number' : list.length}?`,
        returnedOnes
          ? 'They leave the bank for good, and their old leads (with the history) are deleted too.'
          : 'They leave the bank for good.',
        'Delete',
      )
    )
      run(() => deleteBankRows(list), list.length === 1 ? 'Deleted.' : `${list.length} deleted.`);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: selecting ? `${selected.size} marked` : '🏦 Lead Bank' }} />
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
            <ActivityIndicator color={colors.primary} style={styles.loading} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>{search ? '🔍' : tab === 'new' ? '🏦' : '↩️'}</Text>
              <Text style={styles.emptyTitle}>
                {search ? 'Nothing found' : tab === 'new' ? 'No new numbers here' : 'No returned numbers here'}
              </Text>
              <Text style={[ui.muted, styles.centerText]}>
                {search
                  ? resting
                    ? 'Try another name or number.'
                    : 'Try another name or number, or turn on “⏳ Resting too”.'
                  : tab === 'new'
                    ? 'Bring numbers in by pasting them or from an Excel file.'
                    : 'Leads sent back to the bank (from the lead page or the list) show here.'}
              </Text>
              {tab === 'new' && !search && <Button title="📥 Add numbers" onPress={() => setSheet('import')} />}
            </View>
          )
        }
        renderItem={({ item }) => (
          <BankRowView r={item} marked={selected.has(item.id)} selecting={selecting} onToggle={toggle} onOpen={open} />
        )}
      />

      {selecting && (
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

      {sheet === 'peek' && focus && (
        <BankPeekSheet
          row={focus}
          onClose={closeSheet}
          onPull={() => setSheet('pull')}
          onDnc={() =>
            run(
              () => setBankDoNotCall([focus.id], !focus.do_not_call),
              focus.do_not_call ? 'It can be called again.' : 'It will never go into the leads.',
            )
          }
          onMove={() => setSheet('move')}
          onDelete={() => {
            const f = focus;
            closeSheet();
            deleteIds([f.id], f.status === 'returned');
          }}
        />
      )}
      {sheet === 'pull' && <PullSheet ids={ids} hasNew={hasNew} onClose={closeSheet} onDone={changed} />}
      {sheet === 'import' && (
        <ImportSheet
          lists={lists}
          listId={listId && listId !== 'none' ? listId : null}
          onClose={closeSheet}
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
          onClose={closeSheet}
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
              onPress: () => {
                const list = ids;
                closeSheet();
                deleteIds(list, tab === 'returned');
              },
            },
          ]}
        />
      )}
      {sheet === 'move' && (
        <MenuSheet
          title={focus ? 'Which list?' : `Move ${ids.length} to which list?`}
          onClose={closeSheet}
          items={[
            { label: 'New list…', icon: 'create-new-folder', onPress: () => setSheet('newlist-move') },
            { label: 'No list', icon: 'layers-clear', onPress: () => run(() => moveBankRows(ids, null), 'Moved.') },
            ...lists.map((l) => ({
              label: l.name,
              icon: 'folder-open' as const,
              onPress: () => run(() => moveBankRows(ids, l.id), `Moved to ${l.name}.`),
            })),
          ]}
        />
      )}
      {(sheet === 'newlist' || sheet === 'newlist-move') && (
        <TextSheet
          title="📁 New list"
          placeholder="e.g. Education fair 2026"
          maxLength={80}
          saveLabel={sheet === 'newlist-move' ? `Make it and move ${ids.length}` : 'Make the list'}
          onClose={closeSheet}
          onSave={async (name) => {
            const id = await createBankList(name);
            if (sheet === 'newlist-move') {
              await moveBankRows(ids, id);
              changed();
              say('Done', `Moved to ${name}.`);
            } else {
              changed();
              setListId(id);
            }
          }}
        />
      )}
      {sheet === 'list' && listFor && (
        <MenuSheet
          title={listFor.name}
          onClose={closeSheet}
          items={[
            { label: 'Rename', icon: 'edit', onPress: () => setSheet('rename') },
            {
              label: 'Delete the list (the numbers stay)',
              icon: 'delete-outline',
              danger: true,
              onPress: async () => {
                closeSheet();
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
          onClose={closeSheet}
          onSave={async (name) => {
            await renameBankList(listFor.id, name);
            changed();
          }}
        />
      )}
    </View>
  );
}

function Tile({
  value,
  label,
  icon,
  tone,
  ink,
}: {
  value: number | undefined;
  label: string;
  icon: MIconName;
  tone: string;
  ink: string;
}) {
  return (
    <View style={[styles.tile, { backgroundColor: tone }]}>
      <MIcon name={icon} size={18} color={ink} />
      <Text style={[styles.tileValue, { color: ink }]}>{value ?? '–'}</Text>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const BankRowView = memo(function BankRowView({
  r,
  marked,
  selecting,
  onToggle,
  onOpen,
}: {
  r: BankRow;
  marked: boolean;
  /** some are marked: a tap marks this one too */
  selecting: boolean;
  onToggle: (id: string) => void;
  onOpen: (r: BankRow) => void;
}) {
  const rest = restingDays(r);
  const meta = [r.list?.name ?? 'No list', r.area, ...(r.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => (selecting ? onToggle(r.id) : onOpen(r))}
      onLongPress={() => onToggle(r.id)}
      delayLongPress={350}
      android_ripple={{ color: md.ripple }}
      style={[styles.row, marked && styles.rowOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: marked }}
      accessibilityLabel={`${r.name ?? 'No name'}, ${r.phone}`}
      accessibilityHint={selecting ? 'Marks it' : 'Shows it; hold to mark'}
    >
      <Tap onPress={() => onToggle(r.id)} label={marked ? 'Unmark' : 'Mark'} style={styles.check}>
        {marked ? (
          <View style={styles.checkOn}>
            <MIcon name="check" size={22} color={colors.textOnPrimary} />
          </View>
        ) : (
          <Avatar name={r.name ?? r.phone} size={40} />
        )}
      </Tap>
      <View style={styles.flex}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {r.name ?? 'No name'}
          </Text>
          {r.do_not_call && <Badge text="⛔ DNC" tone="bad" />}
          {rest ? <Badge text={`⏳ ${rest}d`} tone="warn" /> : null}
          {r.times_pulled > 0 && <Badge text={`${r.times_pulled}×`} />}
        </View>
        <Text style={styles.phone}>
          {r.phone}
          {r.whatsapp_number ? `  ·  💬 ${r.whatsapp_number}` : ''}
        </Text>
        <Text style={ui.muted} numberOfLines={1}>
          {meta}
        </Text>
        {r.status === 'returned' && (
          <Text style={styles.returned} numberOfLines={1}>
            ↩️ {r.return_reason ?? 'Returned'}
            {r.returned_at
              ? ` · ${new Date(r.returned_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : ''}
          </Text>
        )}
      </View>
      {!selecting && <MIcon name="chevron-right" color={colors.textMuted} />}
    </Pressable>
  );
});

function Badge({ text, tone }: { text: string; tone?: 'bad' | 'warn' }) {
  return (
    <View
      style={[styles.badge, { backgroundColor: tone === 'bad' ? md.errorC : tone === 'warn' ? md.warnC : md.surface2 }]}
    >
      <Text
        style={[
          styles.badgeText,
          { color: tone === 'bad' ? md.onErrorC : tone === 'warn' ? md.onWarnC : colors.textMuted },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  centerText: { textAlign: 'center' },
  content: { padding: spacing.lg, paddingBottom: 120, width: '100%', maxWidth: 820, alignSelf: 'center' },
  head: { gap: spacing.md, marginBottom: spacing.sm },
  flex: { flex: 1 },
  flex2: { flex: 2 },
  loading: { marginTop: spacing.xl },
  hero: { gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: md.heroC },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.primaryC,
  },
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  heroSub: { fontSize: fontSize.small, color: md.primarySub },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: { flex: 1, padding: spacing.sm, borderRadius: radius.md, gap: 2 },
  tileValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  tileLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  tabs: { flexDirection: 'row', padding: 4, gap: 4, borderRadius: radius.lg, backgroundColor: md.surface2 },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  tabOn: { backgroundColor: colors.surface, ...Platform.select({ web: {}, default: { elevation: 1 } }) },
  tabText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.textMuted },
  tabTextOn: { color: colors.primary },
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
  searchClear: { padding: 4, borderRadius: 16, overflow: 'hidden' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: 16,
    overflow: 'hidden',
  },
  linkText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  chips: { gap: spacing.xs },
  listCard: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: md.primaryC },
  listTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  listName: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: md.onPrimaryC },
  listStats: { fontSize: fontSize.small, color: md.onPrimaryC },
  iconBtn: { padding: 6, borderRadius: 18, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  rowOn: { backgroundColor: md.primaryC },
  check: { borderRadius: 20, overflow: 'hidden' },
  checkOn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flexShrink: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm },
  badgeText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  phone: { fontSize: fontSize.small, color: colors.text, marginTop: 1 },
  returned: { fontSize: fontSize.small, color: md.onWarnC, marginTop: 1 },
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
