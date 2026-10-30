import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { contactLabel, openWhatsApp, whatsAppOnly } from '@/features/leads/contact';
import type { TemplateChannel } from '@/features/templates/api';
import { TemplateSheet } from '@/features/templates/TemplateSheet';
import { canUseFees, feeBadge, getFeeSettings } from '@/features/fees/api';
import { FeeSheet, type FeeSheetLead } from '@/features/fees/FeeSheet';
import { useTemplateAccess } from '@/features/templates/useTemplateAccess';
import { getCallSyncSettings, markCallFromApp } from '@/features/call-sync/api';
import type { CallChannel } from '@/features/calls/api';
import {
  canUseBoard,
  getBoardSettings,
  loadLeadsView,
  saveLeadsView,
  DEFAULT_BOARD,
  type BoardSettings,
  type LeadsView,
} from '@/features/board/api';
import { LeadBoard } from '@/features/board/LeadBoard';
import { CallResultSheet } from '@/features/calls/CallResultSheet';
import { LeadFilterSheet } from '@/features/leads/LeadFilterSheet';
import { canHandOver } from '@/features/settings/assignment';
import { LeadQuickSheet, type QuickField } from '@/features/leads/LeadQuickSheet';
import { LeadSortSheet, loadLeadSort, saveLeadSort, sortLabel } from '@/features/leads/LeadSortSheet';
import {
  DEFAULT_SORT,
  MAX_MARK_ALL,
  listAllMatchingLeads,
  listLeads,
  type ClosedMode,
  type LeadListItem,
  type LeadSort,
  type QuickFilter,
} from '@/features/leads/api';
import {
  countActiveFilters,
  deleteSavedFilter,
  listSavedFilters,
  type LeadFilters,
  type SavedFilter,
} from '@/features/leads/filters';
import { papersBadge } from '@/features/papers/api';
import { visitBadge } from '@/features/visits/api';
import { LostSheet } from '@/features/pipeline/LostSheet';
import { getAdmissionSettings } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

const RATING_COLOR: Record<string, string> = {
  hot: colors.hot,
  warm: colors.warm,
  cold: colors.cold,
};

const WHATSAPP_GREEN = '#25D366';

// The floating buttons shown while leads are marked ("lost" opens the Lost sheet)
type FloatAction = QuickField | 'lost' | 'fee';

const ACTIONS: {
  field: FloatAction;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}[] = [
  { field: 'note', label: 'Note', icon: 'create', color: '#8B5CF6' },
  { field: 'stage', label: 'Stage', icon: 'flag', color: '#6366F1' },
  { field: 'tags', label: 'Tag', icon: 'pricetags', color: '#EC4899' },
  { field: 'assign', label: 'Assign', icon: 'person-add', color: '#0EA5E9' },
  { field: 'followup', label: 'Next call', icon: 'alarm', color: '#10B981' },
  { field: 'fee', label: 'Fee', icon: 'cash', color: '#D97706' },
  { field: 'lost', label: 'Lost', icon: 'close-circle', color: '#EF4444' },
];

// Closed leads on the card
const CLOSED_BADGE: Record<string, { label: string; color: string }> = {
  won: { label: '🎓 Admitted', color: colors.success },
  lost: { label: '✕ Lost', color: colors.danger },
  cancelled: { label: '↩ Cancelled', color: colors.textMuted },
};

function followUpLabel(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const date = new Date(iso);
  const now = new Date();
  const overdue = date.getTime() < now.getTime();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return { text: `Today ${time}`, overdue };
  return {
    text: date.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ` ${time}`,
    overdue,
  };
}

export default function LeadsScreen() {
  const { profile, hasPermission, assignmentOn, sharedMode, canAssign, assignment } = useAuth();
  // Everyone may give leads to someone (Settings → Lead assignment → Hand over)
  const mayHandOver = canHandOver(assignment, hasPermission);

  // Can this user see other people's leads? (by role, or because everyone sees all)
  const seesOthers = sharedMode || hasPermission('leads.view_all') || hasPermission('leads.view_team');
  const isAdmin = hasPermission('settings.manage');

  // "Mine" and "Unassigned" only make sense while assignment is on
  const quickFilters: { key: QuickFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    ...(assignmentOn && seesOthers ? [{ key: 'mine' as QuickFilter, label: 'Mine' }] : []),
    { key: 'new', label: 'Not contacted' },
    { key: 'hot', label: 'Hot' },
    ...(assignmentOn && canAssign ? [{ key: 'unassigned' as QuickFilter, label: 'Unassigned' }] : []),
    { key: 'closed', label: 'Closed' },
  ];

  // Many leads lost at once: only for people who edit their team's or all leads
  const canBulkLost = hasPermission('leads.edit_team') || hasPermission('leads.edit_all');

  // 💰 Fee & discount (one marked lead), when the feature is on for this person
  const [feeOn, setFeeOn] = useState(false);
  const [feeFor, setFeeFor] = useState<FeeSheetLead | null>(null);
  useEffect(() => {
    getFeeSettings()
      .then((s) => setFeeOn(canUseFees(s, profile, isAdmin || hasPermission('discounts.approve'))))
      .catch(() => setFeeOn(false));
  }, [profile, isAdmin, hasPermission]);

  const actions = ACTIONS.filter(
    (a) =>
      (a.field !== 'assign' || mayHandOver) && (a.field !== 'lost' || canBulkLost) && (a.field !== 'fee' || feeOn),
  );
  const showAssignee = assignmentOn && seesOthers;

  const [quick, setQuick] = useState<QuickFilter>('all');
  // Opened from a notification about many leads: show just those
  const [idsFilter, setIdsFilter] = useState<string[] | null>(null);

  // List or Board (Settings → Pipeline board decides who may use the board)
  const [view, setView] = useState<LeadsView>('list');
  const [boardSettings, setBoardSettings] = useState<BoardSettings>(DEFAULT_BOARD);
  const boardAllowed = canUseBoard(boardSettings, profile, isAdmin);
  const showBoard = view === 'board' && boardAllowed;
  const [boardReload, setBoardReload] = useState(0);
  useEffect(() => {
    getBoardSettings().then(setBoardSettings);
    loadLeadsView().then(setView);
  }, []);
  const switchView = (next: LeadsView) => {
    setSelected(new Set()); // marking is for the list only
    setView(next);
    saveLeadsView(next);
  };

  // Sort: kept on this phone
  const [sort, setSort] = useState<LeadSort>(DEFAULT_SORT);
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  useEffect(() => {
    loadLeadSort().then((saved) => {
      if (saved !== DEFAULT_SORT) {
        setLoading(true);
        setSort(saved);
      }
    });
  }, []);
  const pickSort = (next: LeadSort) => {
    setSortSheetVisible(false);
    if (next === sort) return;
    saveLeadSort(next);
    setLoading(true);
    setSort(next);
  };
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Full filters
  const [filters, setFilters] = useState<LeadFilters>({});
  const [filterSheetVisible, setFilterSheetVisible] = useState(false);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const filterCount = countActiveFilters(filters);

  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Marked leads (press and hold a lead to start)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [matchingCache, setMatchingCache] = useState<LeadListItem[]>([]); // from "Mark all matching"
  const [markingAll, setMarkingAll] = useState(false);
  const selecting = selected.size > 0;

  // Which quick-change sheet is open
  const [sheetField, setSheetField] = useState<QuickField | null>(null);
  const [lostVisible, setLostVisible] = useState(false);

  // Closed leads (Admitted / Lost / Cancelled) hidden or shown (Settings → Admission)
  const [closedMode, setClosedMode] = useState<ClosedMode>('hide');

  // Call popup (after calling from the list)
  const [callLead, setCallLead] = useState<LeadListItem | null>(null);
  const [callSheetVisible, setCallSheetVisible] = useState(false);
  const [estimatedSec, setEstimatedSec] = useState<number | null>(null);
  const callStartedAt = useRef<number | null>(null);
  const leftApp = useRef(false);
  // 💬 Message templates (Settings → Message templates)
  const templates = useTemplateAccess();
  const tapOpensTemplates = templates.allowed && templates.settings.tap === 'sheet';
  const [templateFor, setTemplateFor] = useState<{ lead: LeadListItem; channel: TemplateChannel } | null>(null);
  // 📞 phone call or 💬 WhatsApp: which one the popup asks about
  const [callChannel, setCallChannel] = useState<CallChannel>('phone');
  const pendingChannel = useRef<CallChannel>('phone');
  const [askAfterWhatsApp, setAskAfterWhatsApp] = useState(true);

  useEffect(() => {
    getCallSyncSettings()
      .then((s) => setAskAfterWhatsApp(s.whatsapp_ask_after))
      .catch(() => undefined);
  }, []);

  // Short message after saving
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ignore answers from older requests (e.g. while typing fast)
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Read the "closed leads in the list" setting
  useEffect(() => {
    getAdmissionSettings()
      .then((s) => setClosedMode(s.closed_in_list))
      .catch(() => setClosedMode('hide'));
  }, []);

  // If assignment gets switched off, drop the chips that no longer exist
  useEffect(() => {
    if (!assignmentOn && (quick === 'mine' || quick === 'unassigned')) setQuick('all');
  }, [assignmentOn, quick]);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  // With assignment off, an "Assigned to" filter would be confusing: ignore it
  const effectiveFilters = useMemo<LeadFilters>(() => {
    if (assignmentOn || !filters.assigned) return filters;
    const { assigned, ...rest } = filters; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  }, [filters, assignmentOn]);

  // --- load the first page ---------------------------------------------
  const loadFirstPage = useCallback(async () => {
    const myRequest = ++requestId.current;
    try {
      setError(null);
      const result = await listLeads({
        search: debouncedSearch,
        quick,
        userId: profile?.id,
        filters: effectiveFilters,
        closedMode,
        sort,
        ids: idsFilter,
        page: 0,
      });
      if (myRequest !== requestId.current) return;
      setLeads(result.items);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setPage(0);
    } catch (e) {
      if (myRequest !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load leads.');
    } finally {
      if (myRequest === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [debouncedSearch, quick, profile?.id, effectiveFilters, closedMode, sort, idsFilter]);

  const loadSavedFilters = useCallback(async () => {
    try {
      setSavedFilters(await listSavedFilters());
    } catch {
      // the list still works without saved filters
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadFirstPage();
      loadSavedFilters();
    }, [loadFirstPage, loadSavedFilters]),
  );

  // Back on this screen (e.g. from a lead page): the board reloads too
  useFocusEffect(
    useCallback(() => {
      setBoardReload((n) => n + 1);
    }, []),
  );

  // Changing the search or filters clears the marks
  useEffect(() => {
    setSelected(new Set());
    setMatchingCache([]);
  }, [debouncedSearch, quick, effectiveFilters]);

  // --- after a call from the list: open the popup on return -----------
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (callStartedAt.current == null) return;

      if (state === 'background' || state === 'inactive') {
        leftApp.current = true;
        return;
      }

      if (state === 'active' && leftApp.current) {
        const seconds = Math.round((Date.now() - callStartedAt.current) / 1000);
        callStartedAt.current = null;
        leftApp.current = false;
        setEstimatedSec(seconds);
        setCallChannel(pendingChannel.current);
        setCallSheetVisible(true);
      }
    });
    return () => sub.remove();
  }, []);

  // --- load the next page when the list end is reached ---------------
  const loadMore = async () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const result = await listLeads({
        search: debouncedSearch,
        quick,
        userId: profile?.id,
        filters: effectiveFilters,
        closedMode,
        sort,
        ids: idsFilter,
        page: next,
      });
      setLeads((list) => [...list, ...result.items]);
      setHasMore(result.hasMore);
      setPage(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more leads.');
    } finally {
      setLoadingMore(false);
    }
  };

  // --- filters ------------------------------------------------------------
  // Opened from Reports (a funnel bar): show the leads in that stage
  const { stage: stageParam, ids: idsParam } = useLocalSearchParams<{ stage?: string; ids?: string }>();
  useEffect(() => {
    if (!idsParam) return;
    setLoading(true);
    setIdsFilter(String(idsParam).split(',').filter(Boolean));
    router.setParams({ ids: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsParam]);
  useEffect(() => {
    if (!stageParam) return;
    applyFilters({ stageIds: [String(stageParam)] }, null);
    router.setParams({ stage: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageParam]);

  const applyFilters = (next: LeadFilters, savedId: string | null = null) => {
    setLoading(true);
    setFilters(next);
    setActiveSavedId(savedId);
  };

  const pressSavedFilter = (f: SavedFilter) => {
    if (activeSavedId === f.id) applyFilters({}, null);
    else applyFilters(f.filters ?? {}, f.id);
  };

  const longPressSavedFilter = (f: SavedFilter) => {
    const canDelete = f.owner_id === profile?.id || (f.is_shared && isAdmin);
    if (!canDelete) {
      Alert.alert(f.name, 'This filter was shared by an admin.');
      return;
    }
    Alert.alert(f.name, f.is_shared ? 'Shared with everyone.' : 'Your saved filter.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteSavedFilter(f.id);
            if (activeSavedId === f.id) applyFilters({}, null);
            loadSavedFilters();
            showToast('Filter deleted.');
          } catch (e) {
            Alert.alert('Could not delete', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  // --- contact buttons ----------------------------------------------------
  const open = async (url: string, fallback?: string) => {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      if (fallback) {
        try {
          await Linking.openURL(fallback);
          return true;
        } catch {
          // fall through
        }
      }
      Alert.alert('Could not open', 'This action is not available on this phone.');
      return false;
    }
  };

  const call = async (lead: LeadListItem) => {
    if (!lead.phone) return;
    setCallLead(lead);
    callStartedAt.current = Date.now();
    leftApp.current = false;
    pendingChannel.current = 'phone';
    // The app shows its own popup for this call: no "add a note" notification
    markCallFromApp(lead.phone);
    const ok = await open(`tel:${lead.phone}`);
    if (!ok) callStartedAt.current = null;
  };

  // 💬 WhatsApp: when the user comes back, ask what happened (Settings → Calls)
  const whatsapp = async (lead: LeadListItem) => {
    if (tapOpensTemplates) {
      setTemplateFor({ lead, channel: 'whatsapp' });
      return;
    }
    await openPlainWhatsApp(lead);
  };

  const openPlainWhatsApp = async (lead: LeadListItem) => {
    if (askAfterWhatsApp) {
      setCallLead(lead);
      callStartedAt.current = Date.now();
      leftApp.current = false;
      pendingChannel.current = 'whatsapp';
    }
    const ok = await openWhatsApp(lead);
    if (!ok) callStartedAt.current = null;
  };

  const sms = (lead: LeadListItem) => {
    if (tapOpensTemplates) {
      setTemplateFor({ lead, channel: 'sms' });
      return;
    }
    if (lead.phone) open(`sms:${lead.phone}`);
  };

  // --- marking ------------------------------------------------------------
  const toggleSelect = (id: string) => {
    setSelected((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalMatching = total ?? leads.length;
  const allMarked = selected.size > 0 && selected.size >= Math.min(totalMatching, MAX_MARK_ALL);

  const markAllMatching = async () => {
    if (allMarked) {
      setSelected(new Set());
      setMatchingCache([]);
      return;
    }
    // Everything is already loaded: no need to ask the server
    if (!hasMore) {
      setSelected(new Set(leads.map((l) => l.id)));
      return;
    }
    setMarkingAll(true);
    try {
      const all = await listAllMatchingLeads({
        search: debouncedSearch,
        quick,
        userId: profile?.id,
        filters: effectiveFilters,
        closedMode,
        sort,
        ids: idsFilter,
      });
      setMatchingCache(all);
      setSelected(new Set(all.map((l) => l.id)));
      if (totalMatching > MAX_MARK_ALL) {
        showToast(`Marked the first ${MAX_MARK_ALL}. Narrow the filter to change the rest.`);
      }
    } catch (e) {
      Alert.alert('Could not mark all', e instanceof Error ? e.message : '');
    } finally {
      setMarkingAll(false);
    }
  };

  // Every lead we know about, by id (loaded pages + "mark all" results)
  const pool = useMemo(() => {
    const map = new Map<string, LeadListItem>();
    for (const l of matchingCache) map.set(l.id, l);
    for (const l of leads) map.set(l.id, l);
    return map;
  }, [leads, matchingCache]);

  const markedLeads = [...selected].map((id) => pool.get(id)).filter(Boolean) as LeadListItem[];

  const listIsFiltered = filterCount > 0 || quick !== 'all' || !!debouncedSearch;

  return (
    <View style={styles.screen}>
      {/* Search + Filter button */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or phone"
            placeholderTextColor={colors.textMuted}
            style={styles.search}
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
        <Pressable
          onPress={() => setFilterSheetVisible(true)}
          style={({ pressed }) => [
            styles.filterBtn,
            filterCount > 0 && styles.filterBtnOn,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={filterCount > 0 ? `Filters, ${filterCount} on` : 'Filters'}
        >
          <Ionicons name="options" size={20} color={filterCount > 0 ? colors.textOnPrimary : colors.text} />
          {filterCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{filterCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Quick filters + saved filters (hidden while marking) */}
      {!selecting && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsScroll}
        >
          {quickFilters.map((f) => {
            const on = f.key === quick;
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  setLoading(true);
                  setQuick(f.key);
                }}
                style={[styles.chip, on && styles.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
              </Pressable>
            );
          })}

          {savedFilters.length > 0 && <View style={styles.chipDivider} />}

          {savedFilters.map((f) => {
            const on = activeSavedId === f.id;
            return (
              <Pressable
                key={f.id}
                onPress={() => pressSavedFilter(f)}
                onLongPress={() => longPressSavedFilter(f)}
                style={[styles.chip, styles.savedChip, on && styles.savedChipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityHint="Press and hold to delete"
              >
                <Ionicons
                  name={f.is_shared ? 'people' : 'bookmark'}
                  size={12}
                  color={on ? colors.textOnPrimary : colors.primary}
                />
                <Text style={[styles.chipText, styles.savedChipText, on && styles.chipTextOn]}>{f.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Count line + sort */}
      {!selecting && (
        <View style={styles.countRow}>
          <Text style={[styles.countText, styles.countGrow]} numberOfLines={1}>
            {loading
              ? ' '
              : `${total ?? leads.length} ${(total ?? leads.length) === 1 ? 'lead' : 'leads'}${
                  idsFilter ? ' from a notification' : listIsFiltered ? ' found' : ''
                }`}
          </Text>
          {idsFilter && (
            <Pressable
              onPress={() => {
                setLoading(true);
                setIdsFilter(null);
              }}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.clearFilters}>Show all</Text>
            </Pressable>
          )}
          {filterCount > 0 && (
            <Pressable onPress={() => applyFilters({}, null)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.clearFilters}>Clear filters</Text>
            </Pressable>
          )}
          {boardAllowed && (
            <View style={styles.viewToggle}>
              {(['list', 'board'] as LeadsView[]).map((v) => {
                const on = (v === 'board') === showBoard;
                return (
                  <Pressable
                    key={v}
                    onPress={() => switchView(v)}
                    hitSlop={6}
                    style={[styles.viewBtn, on && styles.viewBtnOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={v === 'list' ? 'List view' : 'Board view'}
                  >
                    <Ionicons
                      name={v === 'list' ? 'list' : 'grid'}
                      size={14}
                      color={on ? colors.textOnPrimary : colors.textMuted}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
          <Pressable
            onPress={() => setSortSheetVisible(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.sortBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Sort: ${sortLabel(sort)}. Change`}
          >
            <Ionicons name="swap-vertical" size={14} color={sort === DEFAULT_SORT ? colors.textMuted : colors.primary} />
            <Text style={[styles.sortText, sort !== DEFAULT_SORT && styles.sortTextOn]} numberOfLines={1}>
              {sortLabel(sort)}
            </Text>
            <Ionicons name="chevron-down" size={12} color={sort === DEFAULT_SORT ? colors.textMuted : colors.primary} />
          </Pressable>
        </View>
      )}

      {showBoard ? (
        <LeadBoard
          query={{ search: debouncedSearch, quick, userId: profile?.id, filters: effectiveFilters, closedMode, sort, ids: idsFilter }}
          closedColumns={boardSettings.closed_columns}
          showAssignee={showAssignee}
          reloadKey={boardReload}
          onCall={call}
          onWhatsApp={whatsapp}
          onSms={sms}
          onTemplate={templates.allowed ? (lead, ch) => setTemplateFor({ lead, channel: ch }) : undefined}
          onFee={
            feeOn
              ? (lead) =>
                  setFeeFor({
                    id: lead.id,
                    name: lead.name,
                    stageKind: lead.stage?.kind ?? 'open',
                    courseIds: lead.lead_courses.map((c) => c.course?.id ?? '').filter(Boolean),
                  })
              : undefined
          }
          onChanged={(message) => {
            showToast(message);
            loadFirstPage();
          }}
        />
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(l) => l.id}
          extraData={selected}
          contentContainerStyle={[styles.list, selecting && styles.listSelecting, { paddingBottom: 96 }]}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                loadFirstPage();
              }}
            />
          }
          ListHeaderComponent={
            error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{listIsFiltered ? 'No matching leads' : 'No leads yet'}</Text>
              <Text style={styles.emptyText}>
                {listIsFiltered ? 'Try another search or change the filters.' : 'Tap + to add your first lead.'}
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator style={styles.footer} color={colors.primary} /> : null
          }
          renderItem={({ item }) => (
            <LeadCard
              lead={item}
              showAssignee={showAssignee}
              selecting={selecting}
              selected={selected.has(item.id)}
              onPress={() =>
                selecting ? toggleSelect(item.id) : router.push(`/leads/${item.id}` as Href)
              }
              onLongPress={() => toggleSelect(item.id)}
              onCall={() => call(item)}
              onWhatsApp={() => whatsapp(item)}
              onSms={() => sms(item)}
              onTemplate={templates.allowed ? (ch) => setTemplateFor({ lead: item, channel: ch }) : undefined}
            />
          )}
        />
      )}

      {/* Floating action bar while marking */}
      {selecting && (
        <View style={styles.floatWrap} pointerEvents="box-none">
          <View style={styles.floatBar}>
            <View style={styles.floatTop}>
              <Pressable
                onPress={() => {
                  setSelected(new Set());
                  setMatchingCache([]);
                }}
                hitSlop={10}
                style={styles.closeBtn}
                accessibilityRole="button"
                accessibilityLabel="Clear marks"
              >
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
              <Text style={styles.floatCount}>{selected.size} marked</Text>
              {markingAll ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Pressable onPress={markAllMatching} hitSlop={10} accessibilityRole="button">
                  <Text style={styles.floatAll}>
                    {allMarked ? 'Unmark all' : `Mark all ${Math.min(totalMatching, MAX_MARK_ALL)}`}
                  </Text>
                </Pressable>
              )}
            </View>

            <View style={styles.floatButtons}>
              {actions.map((a) => (
                <Pressable
                  key={a.field}
                  onPress={() => {
                    if (a.field === 'lost') return setLostVisible(true);
                    if (a.field === 'fee') {
                      const one = markedLeads.length === 1 ? markedLeads[0] : null;
                      if (!one) return showToast('Mark just one lead for Fee & discount.');
                      return setFeeFor({
                        id: one.id,
                        name: one.name,
                        stageKind: one.stage?.kind ?? 'open',
                        courseIds: one.lead_courses.map((c) => c.course?.id ?? '').filter(Boolean),
                      });
                    }
                    setSheetField(a.field);
                  }}
                  disabled={markingAll}
                  style={({ pressed }) => [styles.actionItem, pressed && styles.actionPressed]}
                  accessibilityRole="button"
                  accessibilityLabel={a.field === 'note' ? 'Add a note' : `Change ${a.label}`}
                >
                  <View style={[styles.actionCircle, { backgroundColor: a.color + '1F' }]}>
                    <Ionicons name={a.icon} size={20} color={a.color} />
                  </View>
                  <Text style={styles.actionLabel}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      )}

      {/* Saved message */}
      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {/* Add button (hidden while marking) */}
      {!selecting && (
        <Pressable
          onPress={() => router.push('/leads/edit/new' as Href)}
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          accessibilityRole="button"
          accessibilityLabel="Add lead"
        >
          <Text style={styles.fabText}>＋</Text>
        </Pressable>
      )}

      <LeadSortSheet
        visible={sortSheetVisible}
        value={sort}
        onClose={() => setSortSheetVisible(false)}
        onPick={pickSort}
      />

      <LeadFilterSheet
        visible={filterSheetVisible}
        value={filters}
        onClose={() => setFilterSheetVisible(false)}
        onApply={(next) => {
          setFilterSheetVisible(false);
          applyFilters(next, null);
        }}
        onSavedFilter={(f) => {
          setSavedFilters((list) => [...list, f]);
        }}
      />

      {sheetField && (
        <LeadQuickSheet
          visible={!!sheetField}
          field={sheetField}
          leads={markedLeads}
          onClose={() => setSheetField(null)}
          onSaved={(message) => {
            setSheetField(null);
            setSelected(new Set());
            setMatchingCache([]);
            showToast(message);
            loadFirstPage();
          }}
        />
      )}

      <LostSheet
        visible={lostVisible}
        leads={markedLeads.map((l) => ({ id: l.id, name: l.name }))}
        onClose={() => setLostVisible(false)}
        onSaved={(message) => {
          setLostVisible(false);
          setSelected(new Set());
          setMatchingCache([]);
          showToast(message);
          loadFirstPage();
        }}
      />

      {/* 💰 Fee & discount for one marked lead */}
      <FeeSheet
        lead={feeFor}
        onClose={() => {
          setFeeFor(null);
          setSelected(new Set());
          setMatchingCache([]);
        }}
        onChanged={(message) => {
          if (message) showToast(message);
          loadFirstPage();
          setBoardReload((n) => n + 1);
        }}
      />

      {/* 💬 Templates for WhatsApp / SMS */}
      <TemplateSheet
        visible={!!templateFor}
        lead={templateFor?.lead ?? null}
        channel={templateFor?.channel ?? 'whatsapp'}
        settings={templates.settings}
        onClose={() => setTemplateFor(null)}
        onPlain={() => {
          const t = templateFor;
          if (!t) return;
          if (t.channel === 'whatsapp') openPlainWhatsApp(t.lead);
          else if (t.lead.phone) open(`sms:${t.lead.phone}`);
        }}
        onSent={(name) => showToast(`Sent with “${name}”`)}
      />

      {callLead && (
        <CallResultSheet
          visible={callSheetVisible}
          lead={{ id: callLead.id, name: callLead.name, phone: callLead.phone, rating: callLead.rating }}
          estimatedSec={estimatedSec}
          channel={callChannel}
          onClose={() => setCallSheetVisible(false)}
          onSaved={() => {
            setCallSheetVisible(false);
            showToast(callChannel === 'whatsapp' ? 'WhatsApp saved.' : 'Call saved.');
            loadFirstPage();
          }}
        />
      )}
    </View>
  );
}

// =====================================================================
// One lead card
// =====================================================================
function LeadCard({
  lead,
  showAssignee,
  selecting,
  selected,
  onPress,
  onLongPress,
  onCall,
  onWhatsApp,
  onSms,
  onTemplate,
}: {
  lead: LeadListItem;
  showAssignee: boolean;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onCall: () => void;
  onWhatsApp: () => void;
  onSms: () => void;
  /** Long press on WhatsApp / SMS: pick a message template */
  onTemplate?: (channel: TemplateChannel) => void;
}) {
  const ratingColor = lead.rating ? RATING_COLOR[lead.rating] : null;
  const courses = lead.lead_courses.map((c) => c.course?.name).filter(Boolean).join(', ');
  const followUp = followUpLabel(lead.next_follow_up_at);

  // Admitted / Lost / Cancelled
  const kind = lead.stage?.kind ?? 'open';
  const closed = kind !== 'open' ? CLOSED_BADGE[kind] : null;
  const faded = kind === 'lost' || kind === 'cancelled';

  const metaParts = [
    whatsAppOnly(lead) ? `💬 ${contactLabel(lead)}` : lead.phone,
    kind === 'won' ? lead.student_ref : null,
    courses,
  ].filter(Boolean);

  // 📄 3/5: open leads and admitted students (not lost / cancelled)
  const papers =
    kind === 'open' || kind === 'won'
      ? papersBadge(lead.papers_required ?? 0, (lead.papers_required ?? 0) - (lead.papers_missing ?? 0))
      : null;

  // 🏫 Today 11:00 AM / Visited: open leads only
  const visit = kind === 'open' ? visitBadge(lead.visit_status, lead.visit_at) : null;
  const visitSoon = lead.visit_status === 'planned';
  const visitLate = visitSoon && !!lead.visit_at && new Date(lead.visit_at).getTime() < Date.now();

  // 💰 Negotiating / ⏳ Discount / 💰 −৳3,500
  const fee = kind === 'open' || kind === 'won' ? feeBadge(lead) : null;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.card,
        ratingColor && { borderLeftColor: ratingColor, borderLeftWidth: 4 },
        kind === 'won' && styles.cardWon,
        faded && styles.cardFaded,
        selected && styles.cardSelected,
        pressed && styles.cardPressed,
      ]}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`${lead.name}, ${lead.stage?.name ?? ''}`}
    >
      {selecting && (
        <View style={[styles.check, selected && styles.checkOn]}>
          {selected && <Ionicons name="checkmark" size={16} color={colors.textOnPrimary} />}
        </View>
      )}

      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.name} numberOfLines={1}>
            {lead.name}
          </Text>
          {lead.rating && ratingColor && (
            <Text style={[styles.rating, { color: ratingColor, borderColor: ratingColor }]}>
              {lead.rating.toUpperCase()}
            </Text>
          )}
        </View>

        <Text style={styles.meta} numberOfLines={1}>
          {metaParts.join(' · ')}
        </Text>

        <View style={styles.cardBottom}>
          {closed ? (
            <View style={[styles.stage, { backgroundColor: closed.color + '1F' }]}>
              <Text style={[styles.stageText, { color: closed.color }]}>{closed.label}</Text>
            </View>
          ) : (
            lead.stage && (
              <View style={[styles.stage, { backgroundColor: lead.stage.color + '22' }]}>
                <Text style={[styles.stageText, { color: lead.stage.color }]}>{lead.stage.name}</Text>
              </View>
            )
          )}
          {papers && (
            <View style={[styles.papers, papers.complete ? styles.papersDone : styles.papersMissing]}>
              <Text style={[styles.papersText, { color: papers.complete ? colors.success : colors.warning }]}>
                {papers.text}
              </Text>
            </View>
          )}
          {visit && (
            <View style={[styles.papers, visitSoon ? styles.visitPlanned : styles.visitOther]}>
              <Text
                style={[
                  styles.papersText,
                  { color: visitLate ? colors.danger : visitSoon ? colors.primary : colors.textMuted },
                ]}
              >
                {visit}
              </Text>
            </View>
          )}
          {fee && (
            <View
              style={[
                styles.papers,
                fee.tone === 'wait' || fee.tone === 'bad'
                  ? styles.papersMissing
                  : fee.tone === 'good'
                    ? styles.papersDone
                    : styles.visitOther,
              ]}
            >
              <Text
                style={[
                  styles.papersText,
                  {
                    color:
                      fee.tone === 'bad'
                        ? colors.danger
                        : fee.tone === 'wait'
                          ? colors.warning
                          : fee.tone === 'good'
                            ? colors.success
                            : colors.text,
                  },
                ]}
              >
                {fee.text}
              </Text>
            </View>
          )}
          {followUp && (
            <Text style={[styles.followUp, followUp.overdue && styles.overdue]}>
              {followUp.overdue ? '⚠ ' : '🗓 '}
              {followUp.text}
            </Text>
          )}
          {showAssignee && (
            <Text style={styles.assignee} numberOfLines={1}>
              {lead.assignee?.full_name ?? 'Unassigned'}
            </Text>
          )}
        </View>
      </View>

      {!selecting && (
        <View style={styles.contact}>
          {!!lead.phone && (
            <ContactButton icon="call" color={colors.success} label={`Call ${lead.name}`} onPress={onCall} />
          )}
          <ContactButton
            icon="logo-whatsapp"
            color={WHATSAPP_GREEN}
            label={`WhatsApp ${lead.name}`}
            onPress={onWhatsApp}
            onLongPress={onTemplate && (() => onTemplate('whatsapp'))}
          />
          {!!lead.phone && (
            <ContactButton
              icon="chatbubble-ellipses"
              color={colors.info}
              label={`SMS ${lead.name}`}
              onPress={onSms}
              onLongPress={onTemplate && (() => onTemplate('sms'))}
            />
          )}
        </View>
      )}
    </Pressable>
  );
}

function ContactButton({
  icon,
  color,
  label,
  onPress,
  onLongPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      hitSlop={4}
      style={({ pressed }) => [styles.contactBtn, { backgroundColor: color + '1A' }, pressed && styles.contactPressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={17} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },

  // Search + filter
  searchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  search: { flex: 1, fontSize: fontSize.body, color: colors.text, paddingVertical: 0 },
  filterBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textOnPrimary },

  // Chips
  // The row keeps its full height (Android squeezed it and cut the chips)
  chipsScroll: { flexGrow: 0, flexShrink: 0 },
  chips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },
  chipDivider: { width: 1, height: 20, backgroundColor: colors.border },
  savedChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderColor: colors.primary },
  savedChipOn: { backgroundColor: colors.primary },
  savedChipText: { color: colors.primary },

  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  countText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  countGrow: { flex: 1 },
  viewToggle: {
    flexDirection: 'row',
    marginLeft: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  viewBtn: { paddingVertical: 3, paddingHorizontal: spacing.sm },
  viewBtnOn: { backgroundColor: colors.primary },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: spacing.md, maxWidth: '60%' },
  sortText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, flexShrink: 1 },
  sortTextOn: { color: colors.primary },
  clearFilters: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.danger },

  // List
  list: { paddingHorizontal: spacing.lg, gap: spacing.sm, flexGrow: 1, paddingTop: 0 },
  listSelecting: { paddingTop: 128 }, // room for the floating bar
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardWon: { backgroundColor: colors.successSoft },
  cardFaded: { opacity: 0.7 },
  cardSelected: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.primarySoft, opacity: 1 },
  cardPressed: { opacity: 0.7 },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  cardBody: { flex: 1, gap: 4 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rating: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    paddingVertical: 1,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  cardBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  stage: { paddingVertical: 2, paddingHorizontal: spacing.sm, borderRadius: radius.pill },
  stageText: { fontSize: 11, fontWeight: fontWeight.bold },
  followUp: { fontSize: 11, color: colors.textMuted },
  papers: { paddingVertical: 1, paddingHorizontal: 6, borderRadius: radius.pill, borderWidth: 1 },
  papersDone: { borderColor: colors.success, backgroundColor: colors.successSoft },
  papersMissing: { borderColor: colors.warning, backgroundColor: colors.surface },
  papersText: { fontSize: 11, fontWeight: fontWeight.bold },
  visitPlanned: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  visitOther: { borderColor: colors.border, backgroundColor: colors.surface },
  overdue: { color: colors.danger, fontWeight: fontWeight.bold },
  assignee: { fontSize: 11, color: colors.textMuted },
  contact: { flexDirection: 'row', gap: 6 },
  contactBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactPressed: { opacity: 0.6, transform: [{ scale: 0.92 }] },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.xs },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  footer: { paddingVertical: spacing.lg },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
    marginBottom: spacing.sm,
  },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  // Floating bar
  floatWrap: {
    position: 'absolute',
    top: 44 + spacing.lg + spacing.md, // just under the search box
    left: spacing.lg,
    right: spacing.lg,
  },
  floatBar: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  floatTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  floatCount: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  floatAll: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  floatButtons: { flexDirection: 'row', justifyContent: 'space-around' },
  actionItem: { flex: 1, alignItems: 'center', gap: 4 },
  actionPressed: { opacity: 0.6, transform: [{ scale: 0.95 }] },
  actionCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 11, fontWeight: fontWeight.semibold, color: colors.text },

  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl + 72,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.text,
  },
  toastText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.surface, textAlign: 'center' },
  fab: {
    position: 'absolute',
    right: spacing.xl,
    bottom: spacing.xl,
    width: 60,
    height: 60,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: { opacity: 0.85 },
  fabText: { fontSize: 30, color: colors.textOnPrimary, marginTop: -2 },
});