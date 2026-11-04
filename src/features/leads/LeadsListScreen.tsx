import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, useLocalSearchParams, useNavigation, type Href } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Keyboard,
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
import { openWhatsApp } from '@/features/leads/contact';
import type { TemplateChannel } from '@/features/templates/api';
import { TemplateSheet } from '@/features/templates/TemplateSheet';
import { canTakePayments, canUseFees, getFeeSettings, money, recordPayment, type FeeSettings } from '@/features/fees/api';
import { PaySheet } from '@/features/fees/PaymentsSection';
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
import { confirmCall } from '@/features/calls/doubleCall';
import { getActiveLocks, type ActiveLock } from '@/features/calls/callLock';
import { LeadFilterSheet } from '@/features/leads/LeadFilterSheet';
import { AddedChips } from '@/features/leads/AddedChips';
import {
  NO_ADDED,
  addedQuery,
  addedRange,
  getLeadsAdded,
  listLeadCreators,
  type AddedChoice,
  type AddedDay,
  type LeadCreator,
  type LeadsAddedRow,
} from '@/features/leads/added';
import { canHandOver } from '@/features/settings/assignment';
import { LeadQuickSheet, type QuickField } from '@/features/leads/LeadQuickSheet';
import {
  LeadSortSheet,
  defaultSortFor,
  loadKeepInPlace,
  loadLeadSort,
  saveKeepInPlace,
  saveLeadSort,
  sortLabel,
} from '@/features/leads/LeadSortSheet';
import { StudentsSummary } from '@/features/students/StudentsSummary';
import {
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
import { LostSheet } from '@/features/pipeline/LostSheet';
import { getAdmissionSettings } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import {
  addRecentSearch,
  clearRecentSearches,
  loadRecentSearches,
  removeRecentSearch,
} from '@/features/leads/search';
import { getCardSettings, loadDetailed, saveDetailed } from '@/features/leads/lastActivity';
import { LeadCard } from '@/features/leads/LeadCard';
import { getApprovalSettings } from '@/features/approval/api';
import { LeadPeekSheet } from '@/features/leads/LeadPeekSheet';
import { listAssignableUsers } from '@/features/leads/api';
import { VoicePlayer } from '@/features/voice/VoiceNote';
import { isWeb } from '@/features/web/api';
import { countLeads, listLeadIds, listLeadsByIds, matchingLeadIds, PAGE_SIZE as LIST_PAGE } from '@/features/leads/api';
import {
  GROUP_LABEL,
  loadGroupByTime,
  saveGroupByTime,
  saveListDesign,
  timeGroup,
  useListDesign,
  type TimeGroup,
} from '@/features/leads/design';
import { ModernLeadCard } from '@/features/leads/ModernLeadCard';
import { ListMenu, ModernActionSheet, ModernChip, ModernTopBar, type ModernAction } from '@/features/leads/ModernParts';

// ✨ New list: a group heading (Overdue, Today…) or a lead
type ListRow =
  | { type: 'head'; key: string; group: TimeGroup; count: number | null }
  | { type: 'lead'; key: string; lead: LeadListItem };
import { MIcon, md } from '@/features/home/md';
import type { PlayableFile } from '@/features/voice/VoicePlayerSheet';


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


// =====================================================================
// 👥 Leads list, and the 🎓 Students list (the same screen, only admitted students)
// =====================================================================
export function LeadsListScreen({ mode = 'leads' }: { mode?: 'leads' | 'students' }) {
  const students = mode === 'students';
  const { profile, hasPermission, assignmentOn, sharedMode, assignment, refreshProfile } = useAuth();
  // Everyone may give leads to someone (Settings → Lead assignment → Hand over)
  const mayHandOver = canHandOver(assignment, hasPermission);

  // Can this user see other people's leads? (by role, or because everyone sees all)
  const seesOthers = sharedMode || hasPermission('leads.view_all') || hasPermission('leads.view_team');
  const isAdmin = hasPermission('settings.manage');

  // 🎨 The new design or the classic one (each person's choice: More → List design)
  // 🌐 The website keeps the classic look (its own top bar has the name)
  const designChoice = useListDesign();
  const modern = designChoice === 'new' && !isWeb;
  const navigation = useNavigation();
  // The new design has its own top bar
  useLayoutEffect(() => {
    // 🌐 the website hides the tab header anyway
    if (!isWeb) navigation.setOptions({ headerShown: !modern });
  }, [navigation, modern]);
  const [menuOpen, setMenuOpen] = useState(false);
  const switchToClassic = async () => {
    setMenuOpen(false);
    if (!profile?.id) return;
    try {
      await saveListDesign(profile.id, 'classic');
      await refreshProfile();
    } catch (e) {
      Alert.alert('Could not change', e instanceof Error ? e.message : '');
    }
  };

  // 🎓 Admission approval chips (Students only, when it is on)
  const [approvalOn, setApprovalOn] = useState(false);
  useEffect(() => {
    if (students) getApprovalSettings().then((s) => setApprovalOn(s.enabled));
  }, [students]);

  // "Mine" and "Unassigned" only make sense while assignment is on
  const quickFilters: { key: QuickFilter; label: string }[] = students
    ? [
        { key: 'all', label: 'All' },
        ...(assignmentOn && seesOthers ? [{ key: 'mine' as QuickFilter, label: 'Mine' }] : []),
        { key: 'due', label: '💵 Due' },
        { key: 'overdue', label: '⚠ Overdue' },
        { key: 'paid', label: '✓ Paid' },
        { key: 'papers', label: '📄 Papers missing' },
        { key: 'new_students', label: 'New this month' },
        // 🎓 Admission approval (Settings → Admission approval)
        ...(approvalOn
          ? [
              { key: 'approval_waiting' as QuickFilter, label: '⏳ Admission waiting' },
              { key: 'listed' as QuickFilter, label: '📋 Listed' },
              { key: 'registration_waiting' as QuickFilter, label: '📝 Registration waiting' },
              { key: 'registered' as QuickFilter, label: '✅ Registered' },
              { key: 'approval_returned' as QuickFilter, label: '↩ Sent back' },
              { key: 'no_section' as QuickFilter, label: '🏫 No section' },
              { key: 'no_nu_id' as QuickFilter, label: '🆔 No NU ID' },
            ]
          : []),
      ]
    : // Leads: "All", then who added them and when (➕ chips below)
      [{ key: 'all', label: 'All' }];

  // Many leads lost at once: only for people who edit their team's or all leads
  const canBulkLost = hasPermission('leads.edit_team') || hasPermission('leads.edit_all');

  // 💰 Fee & discount (one marked lead), when the feature is on for this person
  const [feeOn, setFeeOn] = useState(false);
  const [feeFor, setFeeFor] = useState<FeeSheetLead | null>(null);
  // 💵 Students list: quick payment from the card
  const [paySettings, setPaySettings] = useState<FeeSettings | null>(null);
  const [payFor, setPayFor] = useState<LeadListItem | null>(null);
  useEffect(() => {
    getFeeSettings()
      .then((s) => {
        setFeeOn(canUseFees(s, profile, isAdmin || hasPermission('discounts.approve')));
        setPaySettings(canTakePayments(s, profile, isAdmin) ? s : null);
      })
      .catch(() => {
        setFeeOn(false);
        setPaySettings(null);
      });
  }, [profile, isAdmin, hasPermission]);

  const actions = ACTIONS.filter(
    (a) =>
      (a.field !== 'assign' || mayHandOver) &&
      (a.field !== 'lost' || canBulkLost) &&
      (a.field !== 'fee' || feeOn) &&
      // Students are admitted already: no stage / lost from here
      (!students || (a.field !== 'stage' && a.field !== 'lost')),
  );
  const showAssignee = assignmentOn && seesOthers;

  const [quick, setQuick] = useState<QuickFilter>('all');
  // 📞📝 Cards: last call / last note lines (Detailed) or not (Compact), on this phone
  const [detailed, setDetailed] = useState(true);
  const [staleDays, setStaleDays] = useState(0);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [peekLead, setPeekLead] = useState<LeadListItem | null>(null);
  // Leads marked on the board (the board loads its own columns)
  const [boardPicked, setBoardPicked] = useState<Map<string, LeadListItem>>(new Map());

  const [noteFor, setNoteFor] = useState<LeadListItem | null>(null);
  const [playing, setPlaying] = useState<PlayableFile | null>(null);
  useEffect(() => {
    loadDetailed().then(setDetailed);
    getCardSettings().then((s) => setStaleDays(s.stale_days));
    listAssignableUsers({ includeInactive: true })
      .then((u) => setNames(new Map(u.map((p) => [p.id, (p.full_name ?? '').split(' ')[0] || 'Someone']))))
      .catch(() => undefined);
  }, []);
  const nameOf = useCallback((id: string | null) => (id ? (names.get(id) ?? null) : null), [names]);
  // ➕ Leads added by (👤) and when (Today, Yesterday, …): the Leads tab only
  const [added, setAdded] = useState<AddedChoice>(NO_ADDED);
  const [creators, setCreators] = useState<LeadCreator[]>([]);
  const [addedCounts, setAddedCounts] = useState<LeadsAddedRow[]>([]);
  // Admins (and "see all leads") may see everyone's: no "added by" limit for "All users"
  const seesAllAdded = isAdmin || hasPermission('leads.view_all');
  const addedQ = useMemo(
    () =>
      students
        ? null
        : addedQuery(added, seesAllAdded, creators.length > 0 ? creators.map((c) => c.id) : profile?.id ? [profile.id] : []),
    [students, added, seesAllAdded, creators, profile?.id],
  );
  useEffect(() => {
    if (students) return;
    listLeadCreators()
      .then(setCreators)
      .catch(() => setCreators([]));
  }, [students]);
  // "All users" and a period: how many each person added
  useEffect(() => {
    const range = students || added.userId ? null : addedRange(added);
    if (!range) {
      setAddedCounts([]);
      return;
    }
    let live = true;
    getLeadsAdded(range.from, range.to)
      .then((rows) => live && setAddedCounts(rows))
      .catch(() => live && setAddedCounts([]));
    return () => {
      live = false;
    };
  }, [students, added]);
  // Opened from a notification about many leads: show just those
  const [idsFilter, setIdsFilter] = useState<string[] | null>(null);

  // List or Board (Settings → Pipeline board decides who may use the board)
  const [view, setView] = useState<LeadsView>('list');
  const [boardSettings, setBoardSettings] = useState<BoardSettings>(DEFAULT_BOARD);
  const boardAllowed = !students && canUseBoard(boardSettings, profile, isAdmin);
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
  const sortDefault = defaultSortFor(students);
  const [sort, setSort] = useState<LeadSort>(sortDefault);
  const [sortSheetVisible, setSortSheetVisible] = useState(false);
  useEffect(() => {
    loadLeadSort(students).then((saved) => {
      if (saved !== sortDefault) {
        setLoading(true);
        setSort(saved);
      }
    });
  }, []);
  // 📌 Keep in place (phone only): the order is taken when the list loads; after a
  //   call, note or change only that card is updated, where it is
  const [keepSetting, setKeepSetting] = useState(true);
  useEffect(() => {
    loadKeepInPlace().then(setKeepSetting);
  }, []);
  const keepOn = keepSetting && !isWeb;
  const changeKeep = (on: boolean) => {
    setKeepSetting(on);
    saveKeepInPlace(on);
  };
  /** The ids in the order the list had when it loaded */
  const keepOrder = useRef<string[] | null>(null);
  /** The list (search, chips, filters, sort) that keepOrder belongs to */
  const keepKey = useRef<string | null>(null);
  /** ⏱ The time group each lead had when it loaded (so it does not move to another group) */
  const keepGroup = useRef<Map<string, TimeGroup>>(new Map());
  /** Leads opened from the list: updated when coming back */
  const touched = useRef<Set<string>>(new Set());
  /** No longer match the list: dimmed, they leave on the next sort */
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  /** Something changed since the list was sorted: show ↻ Re-sort */
  const [stale, setStale] = useState(false);
  // 📵 Who is on a call with a lead right now (checked every 15 seconds while the list is open)
  const [locks, setLocks] = useState<Map<string, ActiveLock>>(new Map());
  const pickSort = (next: LeadSort) => {
    setSortSheetVisible(false);
    if (next === sort) return;
    saveLeadSort(next, students);
    setLoading(true);
    setSort(next);
  };
  const [search, setSearch] = useState('');
  // 🔍 Search box: focused (shows the recent searches), and the recent ones on this phone
  const [searchFocused, setSearchFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    loadRecentSearches(students).then(setRecent);
  }, [students]);
  const rememberSearch = (text: string) => {
    addRecentSearch(students, text).then(setRecent);
  };
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
  // Nothing marked any more: forget the board's marked leads
  useEffect(() => {
    if (selected.size === 0) setBoardPicked(new Map());
  }, [selected]);

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
  const listQuery = useMemo(
    () => ({
      search: debouncedSearch,
      quick,
      userId: profile?.id,
      filters: effectiveFilters,
      closedMode,
      sort,
      students,
      ids: idsFilter,
      added: addedQ,
    }),
    [debouncedSearch, quick, profile?.id, effectiveFilters, closedMode, sort, students, idsFilter, addedQ],
  );
  const queryKey = useMemo(() => JSON.stringify(listQuery), [listQuery]);

  const loadFirstPage = useCallback(async () => {
    const myRequest = ++requestId.current;
    try {
      setError(null);
      const [result, order] = await Promise.all([
        listLeads({ ...listQuery, page: 0 }),
        keepOn ? listLeadIds(listQuery).catch(() => null) : Promise.resolve(null),
      ]);
      if (myRequest !== requestId.current) return;
      setLeads(result.items);
      setTotal(result.total);
      setPage(0);
      keepOrder.current = order;
      keepKey.current = keepOn ? queryKey : null;
      const now = new Date();
      keepGroup.current = new Map(result.items.map((l) => [l.id, timeGroup(l.next_follow_up_at, now)]));
      touched.current.clear();
      setDoneIds(new Set());
      setStale(false);
      setHasMore(order ? order.length > result.items.length : result.hasMore);
    } catch (e) {
      if (myRequest !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load leads.');
    } finally {
      if (myRequest === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [listQuery, queryKey, keepOn]);

  // 📌 Only these cards change, where they are (a lead that no longer matches is dimmed)
  const refreshInPlace = useCallback(
    async (ids: string[]) => {
      const list = [...new Set(ids)];
      if (list.length === 0) return;
      try {
        const [rows, still] = await Promise.all([listLeadsByIds(list), matchingLeadIds(listQuery, list)]);
        const fresh = new Map(rows.map((r) => [r.id, r]));
        setLeads((now) =>
          now
            .filter((l) => !list.includes(l.id) || fresh.has(l.id)) // deleted: gone
            .map((l) => fresh.get(l.id) ?? l),
        );
        setDoneIds((now) => {
          const next = new Set(now);
          list.forEach((id) => (still.has(id) ? next.delete(id) : next.add(id)));
          return next;
        });
        setStale(true);
      } catch {
        // offline or failed: the card shows the old details until the next refresh
      }
    },
    [listQuery],
  );

  const loadSavedFilters = useCallback(async () => {
    try {
      setSavedFilters(await listSavedFilters());
    } catch {
      // the list still works without saved filters
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // 📌 Back on the same list: only the leads opened from it are updated
      if (keepOn && keepKey.current === queryKey) {
        const ids = [...touched.current];
        touched.current.clear();
        if (ids.length > 0) refreshInPlace(ids);
      } else loadFirstPage();
      loadSavedFilters();
    }, [loadFirstPage, loadSavedFilters, keepOn, queryKey, refreshInPlace]),
  );

  // ✨ New design: the chips (Leads get Mine / Hot / Not called / Unassigned back) and how many each has
  const modernChips = useMemo<{ key: QuickFilter; label: string }[]>(
    () =>
      students
        ? quickFilters
        : [
            { key: 'all', label: 'All' },
            ...(assignmentOn ? [{ key: 'mine' as QuickFilter, label: 'Mine' }] : []),
            { key: 'hot', label: '🔥 Hot' },
            { key: 'new', label: '🆕 Not called' },
            ...(assignmentOn && seesOthers ? [{ key: 'unassigned' as QuickFilter, label: 'Unassigned' }] : []),
          ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [students, assignmentOn, seesOthers, approvalOn],
  );
  const chipKeys = modernChips.map((c) => c.key).join(',');
  const [chipCounts, setChipCounts] = useState<Map<string, number | null>>(new Map());
  const countsId = useRef(0);
  const loadChipCounts = useCallback(() => {
    if (!modern) return;
    const mine = ++countsId.current;
    const base = {
      search: debouncedSearch,
      userId: profile?.id,
      filters: effectiveFilters,
      closedMode,
      students,
      ids: idsFilter,
      added: addedQ,
    };
    Promise.all(modernChips.map((c) => countLeads({ ...base, quick: c.key }).catch(() => null))).then((list) => {
      if (mine !== countsId.current) return;
      setChipCounts(new Map(modernChips.map((c, i) => [c.key, list[i]])));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modern, debouncedSearch, profile?.id, effectiveFilters, closedMode, students, idsFilter, addedQ, chipKeys]);
  useFocusEffect(
    useCallback(() => {
      loadChipCounts();
    }, [loadChipCounts]),
  );

  // ⏱ Next call sort: Overdue / Today / Tomorrow … groups (a quick button turns them off)
  const [groupOn, setGroupOn] = useState(true);
  useEffect(() => {
    loadGroupByTime().then(setGroupOn);
  }, []);
  const toggleGroup = () => {
    setGroupOn((g) => {
      saveGroupByTime(!g);
      return !g;
    });
  };

  // 🔍 Phone's Back button: first clears the search, then leaves as usual
  useFocusEffect(
    useCallback(() => {
      if (!search) return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        setLoading(true);
        setSearch('');
        setDebouncedSearch('');
        return true;
      });
      return () => sub.remove();
    }, [search]),
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
  }, [debouncedSearch, quick, effectiveFilters, addedQ]);

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
      // 📌 The next ones from the order taken when the list loaded (none twice, none missed)
      const order = keepOn && keepKey.current === queryKey ? keepOrder.current : null;
      if (order) {
        const have = new Set(leads.map((l) => l.id));
        const left = order.filter((id) => !have.has(id));
        const part = left.slice(0, LIST_PAGE);
        const items = await listLeadsByIds(part);
        const now = new Date();
        items.forEach((l) => {
          if (!keepGroup.current.has(l.id)) keepGroup.current.set(l.id, timeGroup(l.next_follow_up_at, now));
        });
        setLeads((list) => [...list, ...items.filter((l) => !have.has(l.id))]);
        setHasMore(left.length > part.length);
        return;
      }
      const next = page + 1;
      const result = await listLeads({
        search: debouncedSearch,
        quick,
        userId: profile?.id,
        filters: effectiveFilters,
        closedMode,
        sort,
        students,
        ids: idsFilter,
        added: addedQ,
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
  const {
    stage: stageParam,
    ids: idsParam,
    addedBy,
    addedDay,
    addedFrom,
    addedTo,
    quick: quickParam,
  } = useLocalSearchParams<{
    stage?: string;
    ids?: string;
    addedBy?: string;
    addedDay?: string;
    addedFrom?: string;
    addedTo?: string;
    quick?: string;
  }>();
  // Opened with a chip chosen (e.g. Home → 🎓 Approval waiting)
  useEffect(() => {
    if (!quickParam) return;
    setLoading(true);
    setQuick(String(quickParam) as QuickFilter);
    router.setParams({ quick: undefined });
  }, [quickParam]);
  // Opened from Team activity / Home: leads added by someone, in a period
  useEffect(() => {
    if (!addedBy && !addedDay) return;
    setLoading(true);
    setAdded({
      userId: addedBy ? String(addedBy) : null,
      day: addedDay ? (String(addedDay) as AddedDay) : null,
      from: addedFrom ? String(addedFrom) : undefined,
      to: addedTo ? String(addedTo) : undefined,
    });
    router.setParams({ addedBy: undefined, addedDay: undefined, addedFrom: undefined, addedTo: undefined });
  }, [addedBy, addedDay, addedFrom, addedTo]);
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
    // ⚠️ Someone else talked to this lead a moment ago: ask first (Settings → Double-call warning)
    if (!(await confirmCall(lead.id, () => setPeekLead(lead)))) return;
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
        students,
        ids: idsFilter,
        added: addedQ,
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
    for (const l of boardPicked.values()) map.set(l.id, l);
    for (const l of matchingCache) map.set(l.id, l);
    for (const l of leads) map.set(l.id, l);
    return map;
  }, [leads, matchingCache, boardPicked]);

  const markedLeads = [...selected].map((id) => pool.get(id)).filter(Boolean) as LeadListItem[];

  const listIsFiltered = filterCount > 0 || quick !== 'all' || !!debouncedSearch || !!addedQ;

  // After a change from a sheet or the bar: the list and the board show it
  const reloadAll = () => {
    loadFirstPage();
    loadChipCounts();
    setBoardReload((n) => n + 1);
  };
  /** After a change to these leads: 📌 update them where they are, else load the list again */
  const afterChange = (ids: string[]) => {
    if (!keepOn || ids.length === 0 || ids.length > 100 || showBoard) return reloadAll();
    refreshInPlace(ids);
    loadChipCounts();
    setBoardReload((n) => n + 1);
  };

  // --- 🔍 search ------------------------------------------------------------
  const clearSearch = () => {
    if (debouncedSearch) setLoading(true);
    setSearch('');
    setDebouncedSearch('');
  };
  const runSearch = (text: string) => {
    setLoading(true);
    setSearch(text);
    setDebouncedSearch(text);
    rememberSearch(text);
    Keyboard.dismiss();
  };
  // Anything besides the search that makes the list smaller
  const narrowed = filterCount > 0 || quick !== 'all' || !!addedQ || !!idsFilter;
  const searchEverywhere = () => {
    setLoading(true);
    applyFilters({}, null);
    setQuick('all');
    setAdded(NO_ADDED);
    setIdsFilter(null);
  };

  const overlays = (
    <>
      <LeadSortSheet
        visible={sortSheetVisible}
        value={sort}
        onClose={() => setSortSheetVisible(false)}
        onPick={pickSort}
        students={students}
        keep={keepSetting}
        onKeep={isWeb ? undefined : changeKeep}
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
        students={students}
        hiddenFields={students ? ['stage', 'lost_reason', 'visit'] : []}
      />

      {/* 👁 The last calls and notes of one lead */}
      {peekLead && (
        <LeadPeekSheet
          lead={peekLead}
          nameOf={nameOf}
          onClose={() => setPeekLead(null)}
          onOpen={() => {
            const id = peekLead.id;
            touched.current.add(id);
            setPeekLead(null);
            router.push(`/leads/${id}` as Href);
          }}
          onAddNote={() => {
            setNoteFor(peekLead);
            setPeekLead(null);
          }}
        />
      )}
      {noteFor && (
        <LeadQuickSheet
          visible
          field="note"
          leads={[noteFor]}
          onClose={() => setNoteFor(null)}
          onSaved={(message) => {
            setNoteFor(null);
            showToast(message);
            afterChange([noteFor.id]);
          }}
        />
      )}
      <VoicePlayer file={playing} onClose={() => setPlaying(null)} />

      {/* 💵 Quick payment from a student's card */}
      {payFor && paySettings && (
        <PaySheet
          visible
          leadId={payFor.id}
          due={Number(payFor.fee_due ?? 0)}
          next={null}
          settings={paySettings}
          isAdmin={isAdmin}
          onClose={() => setPayFor(null)}
          onSave={async (input) => {
            const res = await recordPayment({ leadId: payFor.id, ...input });
            showToast(`💵 ${money(input.amount)} received from ${payFor.name} · ${res.receipt_no}`);
            setPayFor(null);
            afterChange([payFor.id]);
          }}
        />
      )}

      {sheetField && (
        <LeadQuickSheet
          visible={!!sheetField}
          field={sheetField}
          leads={markedLeads}
          onClose={() => setSheetField(null)}
          onSaved={(message) => {
            const ids = markedLeads.map((l) => l.id);
            setSheetField(null);
            setSelected(new Set());
            setMatchingCache([]);
            showToast(message);
            afterChange(ids);
          }}
        />
      )}

      <LostSheet
        visible={lostVisible}
        leads={markedLeads.map((l) => ({ id: l.id, name: l.name }))}
        onClose={() => setLostVisible(false)}
        onSaved={(message) => {
          const ids = markedLeads.map((l) => l.id);
          setLostVisible(false);
          setSelected(new Set());
          setMatchingCache([]);
          showToast(message);
          afterChange(ids);
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
          if (feeFor) afterChange([feeFor.id]);
          else reloadAll();
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
          onClose={() => {
            setCallSheetVisible(false);
            // 📌 A call saved from the phone's call log still shows on the card
            if (keepOn) refreshInPlace([callLead.id]);
          }}
          onSaved={() => {
            setCallSheetVisible(false);
            showToast(callChannel === 'whatsapp' ? 'WhatsApp saved.' : 'Call saved.');
            afterChange([callLead.id]);
          }}
        />
      )}
    </>
  );

  // =====================================================================
  // ✨ The new design (the classic one is below, as it always was)
  // =====================================================================
  const grouped = modern && sort === 'next_call' && groupOn;
  const rows = useMemo<ListRow[]>(() => {
    if (!grouped) return leads.map((l) => ({ type: 'lead', key: l.id, lead: l }));
    const now = new Date();
    const groups = leads.map((l) =>
      keepOn ? (keepGroup.current.get(l.id) ?? timeGroup(l.next_follow_up_at, now)) : timeGroup(l.next_follow_up_at, now),
    );
    const sizes = new Map<TimeGroup, number>();
    groups.forEach((g) => sizes.set(g, (sizes.get(g) ?? 0) + 1));
    // A group's number is sure once the next group has started (or everything is loaded)
    const lastGroup = groups[groups.length - 1];
    const out: ListRow[] = [];
    let current: TimeGroup | null = null;
    leads.forEach((l, i) => {
      const g = groups[i];
      if (g !== current) {
        current = g;
        out.push({ type: 'head', key: `head-${g}`, group: g, count: !hasMore || g !== lastGroup ? (sizes.get(g) ?? 0) : null });
      }
      out.push({ type: 'lead', key: l.id, lead: l });
    });
    return out;
  }, [grouped, leads, hasMore, keepOn]);

  // 📵 "Rahim is on a call" on the cards
  const leadIdsKey = leads
    .slice(0, 300)
    .map((l) => l.id)
    .join(',');
  useFocusEffect(
    useCallback(() => {
      if (!leadIdsKey) return;
      let live = true;
      const ids = leadIdsKey.split(',');
      const tick = () =>
        getActiveLocks(ids)
          .then((m) => live && setLocks(m))
          .catch(() => undefined);
      const first = setTimeout(tick, 400);
      const timer = setInterval(tick, 15000);
      return () => {
        live = false;
        clearTimeout(first);
        clearInterval(timer);
      };
    }, [leadIdsKey]),
  );

  // 📌 Cards changed where they are: one tap sorts the list again
  const resortBar =
    keepOn && stale && !loading ? (
      <Pressable
        onPress={() => {
          setRefreshing(true);
          loadFirstPage();
          loadChipCounts();
        }}
        style={({ pressed }) => [styles.resort, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Sort the list again"
      >
        <Text style={styles.resortText}>📌 Kept in place</Text>
        <Text style={styles.resortBtn}>↻ Re-sort</Text>
      </Pressable>
    ) : null;
  /** 📌 No longer matches the list: dimmed, with a short line */
  const doneWrap = (id: string, card: ReactNode) => {
    const inner = doneIds.has(id) ? (
      <View style={styles.done}>
        <View style={styles.doneDim}>{card}</View>
        <Text style={styles.doneText}>✓ Done · leaves on refresh</Text>
      </View>
    ) : (
      card
    );
    const lock = locks.get(id);
    if (!lock) return inner;
    const min = Math.max(0, Math.round((Date.now() - lock.startedAt.getTime()) / 60000));
    return (
      <View>
        <Text style={styles.lockLine}>
          {lock.channel === 'whatsapp' ? '💬' : '📞'} {lock.name} is on a call{min > 0 ? ` · ${min} min` : ''}
        </Text>
        {inner}
      </View>
    );
  };

  if (modern) {
    const n = total ?? leads.length;
    const noun = students ? (n === 1 ? 'student' : 'students') : n === 1 ? 'lead' : 'leads';
    const modernActions: (ModernAction & { field: FloatAction })[] = [
      { key: 'note', field: 'note', label: 'Note', icon: 'edit-note' },
      { key: 'followup', field: 'followup', label: 'Next call', icon: 'alarm' },
      { key: 'stage', field: 'stage', label: 'Stage', icon: 'flag' },
      { key: 'assign', field: 'assign', label: 'Give to', icon: 'person-add' },
      { key: 'tags', field: 'tags', label: 'Tag', icon: 'sell' },
      { key: 'rating', field: 'rating', label: 'Rating', icon: 'local-fire-department' },
      { key: 'fee', field: 'fee', label: 'Fee', icon: 'payments' },
      { key: 'lost', field: 'lost', label: 'Lost', icon: 'block', danger: true },
    ].filter((a) => a.field === 'rating' || actions.some((x) => x.field === a.field)) as (ModernAction & {
      field: FloatAction;
    })[];
    const runAction = (field: FloatAction) => {
      if (field === 'lost') return setLostVisible(true);
      if (field === 'fee') {
        const one = markedLeads.length === 1 ? markedLeads[0] : null;
        if (!one) return showToast('Mark just one lead for Fee & discount.');
        return setFeeFor({
          id: one.id,
          name: one.name,
          stageKind: one.stage?.kind ?? 'open',
          courseIds: one.lead_courses.map((c) => c.course?.id ?? '').filter(Boolean),
        });
      }
      setSheetField(field);
    };
    const openLead = (item: LeadListItem) => {
      if (selecting) return toggleSelect(item.id);
      if (debouncedSearch.trim()) rememberSearch(debouncedSearch);
      touched.current.add(item.id);
      router.push(`/leads/${item.id}` as Href);
    };

    return (
      <View style={styles.screen}>
        <ModernTopBar
          title={students ? 'Students' : 'Leads'}
          count={loading ? null : n}
          selecting={selecting}
          selectedCount={selected.size}
          onClearSelection={() => {
            setSelected(new Set());
            setMatchingCache([]);
          }}
          markingAll={markingAll}
          markAllLabel={allMarked ? 'Unmark all' : `All ${Math.min(totalMatching, MAX_MARK_ALL)}`}
          onMarkAll={markAllMatching}
          actions={[
            ...(boardAllowed
              ? [
                  {
                    icon: showBoard ? ('view-agenda' as const) : ('view-kanban' as const),
                    label: showBoard ? 'List view' : 'Pipeline board',
                    onPress: () => switchView(showBoard ? 'list' : 'board'),
                    on: showBoard,
                  },
                ]
              : []),
            {
              icon: 'swap-vert' as const,
              label: `Sort: ${sortLabel(sort, students)}${keepOn ? ', kept in place' : ''}. Change`,
              onPress: () => setSortSheetVisible(true),
              on: sort !== sortDefault,
            },
            { icon: 'more-vert' as const, label: 'More options', onPress: () => setMenuOpen(true) },
          ]}
        />

        {/* 🎓 Students: totals, tap one to show those */}
        {students && !selecting && (
          <StudentsSummary
            onPick={(q) => {
              setLoading(true);
              setQuick(q);
            }}
          />
        )}

        {/* 🔍 Search pill + filters */}
        <View style={m.search}>
          <MIcon name="search" size={21} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onSubmitEditing={() => search.trim() && rememberSearch(search)}
            returnKeyType="search"
            placeholder={students ? 'Search name, phone, student ID…' : 'Search name, phone, area…'}
            placeholderTextColor={colors.textMuted}
            style={m.searchInput}
            autoCorrect={false}
          />
          {search.length > 0 && (
            <Pressable onPress={clearSearch} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
              <MIcon name="close" size={20} color={colors.textMuted} />
            </Pressable>
          )}
          <Pressable
            onPress={() => setFilterSheetVisible(true)}
            style={[m.filterBtn, filterCount > 0 && m.filterBtnOn]}
            accessibilityRole="button"
            accessibilityLabel={filterCount > 0 ? `Filters, ${filterCount} on` : 'Filters'}
          >
            <MIcon name="tune" size={20} color={filterCount > 0 ? md.onPrimaryC : colors.text} />
            {filterCount > 0 && (
              <View style={m.badge}>
                <Text style={m.badgeText}>{filterCount}</Text>
              </View>
            )}
          </Pressable>
        </View>

        {/* 🔍 Recent searches */}
        {!selecting && searchFocused && !search && recent.length > 0 && (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={m.chips}
            style={styles.chipsScroll}
          >
            <MIcon name="history" size={18} color={colors.textMuted} />
            {recent.map((t) => (
              <ModernChip
                key={t}
                label={t}
                selected={false}
                onPress={() => runSearch(t)}
                onLongPress={() => removeRecentSearch(students, t).then(setRecent)}
              />
            ))}
            <Pressable onPress={() => clearRecentSearches(students).then(setRecent)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.clearFilters}>Clear</Text>
            </Pressable>
          </ScrollView>
        )}

        {/* Chips with how many each has · ➕ added by / when · saved filters */}
        {!selecting && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={m.chips} style={styles.chipsScroll}>
            {modernChips.map((f) => {
              const on = f.key === quick && (f.key !== 'all' || !addedQ);
              return (
                <ModernChip
                  key={f.key}
                  label={f.label}
                  count={chipCounts.get(f.key)}
                  selected={on}
                  onPress={() => {
                    setLoading(true);
                    // a second tap on a chip goes back to All
                    setQuick(on && f.key !== 'all' ? 'all' : f.key);
                    if (f.key === 'all') setAdded(NO_ADDED);
                  }}
                />
              );
            })}
            {!students && (
              <AddedChips
                choice={added}
                creators={creators}
                myId={profile?.id ?? null}
                onChange={(next) => {
                  setLoading(true);
                  setAdded(next);
                }}
              />
            )}
            {savedFilters.map((f) => (
              <ModernChip
                key={f.id}
                label={f.name}
                icon={f.is_shared ? 'groups' : 'bookmark'}
                selected={activeSavedId === f.id}
                onPress={() => pressSavedFilter(f)}
                onLongPress={() => longPressSavedFilter(f)}
              />
            ))}
          </ScrollView>
        )}

        {/* 248 leads · 2 filters        ⏱ Groups   Next call */}
        {!selecting && (
          <View style={m.meta}>
            <Text style={m.metaText} numberOfLines={1}>
              {loading ? ' ' : (
                <>
                  <Text style={m.metaStrong}>{n.toLocaleString('en-IN')}</Text> {noun}
                  {idsFilter ? ' from a notification' : ''}
                  {filterCount > 0 ? ` · ${filterCount} filter${filterCount === 1 ? '' : 's'}` : ''}
                </>
              )}
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
                <Text style={styles.clearFilters}>Clear</Text>
              </Pressable>
            )}
            {sort === 'next_call' && !showBoard && (
              <Pressable
                onPress={toggleGroup}
                hitSlop={6}
                style={[m.groupBtn, groupOn && m.groupBtnOn]}
                accessibilityRole="switch"
                accessibilityState={{ checked: groupOn }}
                accessibilityLabel="Group by time: Overdue, Today, Tomorrow"
              >
                <MIcon name="view-agenda" size={14} color={groupOn ? md.onPrimaryC : colors.textMuted} />
                <Text style={[m.groupText, groupOn && m.groupTextOn]}>Groups</Text>
              </Pressable>
            )}
            <Pressable onPress={() => setSortSheetVisible(true)} hitSlop={8} style={m.sortBtn} accessibilityRole="button">
              <MIcon name="schedule" size={15} color={colors.primary} />
              <Text style={m.sortText} numberOfLines={1}>
                {keepOn ? '📌 ' : ''}
                {sortLabel(sort, students)}
              </Text>
            </Pressable>
          </View>
        )}

        {/* ➕ How many each person added in the chosen period */}
        {!selecting && !students && addedCounts.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll} contentContainerStyle={styles.addedCounts}>
            {addedCounts.map((c) => (
              <Pressable
                key={c.user_id}
                onPress={() => {
                  setLoading(true);
                  setAdded((a) => ({ ...a, userId: c.user_id }));
                }}
                hitSlop={6}
                accessibilityRole="button"
              >
                <Text style={styles.addedCount}>
                  {c.user_id === profile?.id ? 'Me' : (c.name ?? 'No name')} <Text style={styles.addedCountNum}>{c.total}</Text>
                  {c.imported > 0 ? ` (${c.imported} imported)` : ''}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {showBoard ? (
          <LeadBoard
            query={{ search: debouncedSearch, quick, userId: profile?.id, filters: effectiveFilters, closedMode, sort, ids: idsFilter, added: addedQ }}
            closedColumns={boardSettings.closed_columns}
            showAssignee={showAssignee}
            reloadKey={boardReload}
            onCall={call}
            onWhatsApp={whatsapp}
            onSms={sms}
            onTemplate={templates.allowed ? (lead, ch) => setTemplateFor({ lead, channel: ch }) : undefined}
            onChanged={(message) => showToast(message)}
            search={debouncedSearch}
            detailed={detailed}
            staleDays={staleDays}
            nameOf={nameOf}
            onPeek={setPeekLead}
            onPlayVoice={(lead, fileId, seconds) => setPlaying({ id: fileId, name: `Voice note · ${lead.name}`, duration_sec: seconds })}
            selected={selected}
            onToggle={(lead) => {
              setBoardPicked((mp) => new Map(mp).set(lead.id, lead));
              toggleSelect(lead.id);
            }}
          />
        ) : loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => r.key}
            extraData={selected}
            contentContainerStyle={[m.list, { paddingBottom: selecting ? 230 : 100 }]}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  loadFirstPage();
                  loadChipCounts();
                }}
              />
            }
            ListHeaderComponent={
              <>
                {resortBar}
                {error ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}
              </>
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <MIcon name={students ? 'school' : 'groups'} size={40} color={md.outline} />
                <Text style={styles.emptyTitle}>{listIsFiltered ? `No matching ${students ? 'students' : 'leads'}` : 'No leads yet'}</Text>
                <Text style={styles.emptyText}>
                  {listIsFiltered ? 'Try another search or change the filters.' : 'Tap “Add lead” to add your first lead.'}
                </Text>
                {!!debouncedSearch && narrowed && (
                  <Pressable onPress={searchEverywhere} style={styles.searchAllBtn} accessibilityRole="button">
                    <Text style={styles.searchAllText}>
                      🔍 Search all {students ? 'students' : 'leads'} for “{debouncedSearch}”
                    </Text>
                  </Pressable>
                )}
              </View>
            }
            ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footer} color={colors.primary} /> : undefined}
            renderItem={({ item: row }) =>
              row.type === 'head' ? (
                <Text style={[m.group, row.group === 'late' && m.groupLate]}>
                  {GROUP_LABEL[row.group]}
                  {row.count != null ? ` · ${row.count}` : ''}
                </Text>
              ) : (
                <View style={m.cardGap}>
                  {doneWrap(
                    row.lead.id,
                    <ModernLeadCard
                      lead={row.lead}
                      search={debouncedSearch}
                      detailed={detailed}
                      staleDays={staleDays}
                      nameOf={nameOf}
                      onPeek={() => setPeekLead(row.lead)}
                      onPlayVoice={(fileId, seconds) =>
                        setPlaying({ id: fileId, name: `Voice note · ${row.lead.name}`, duration_sec: seconds })
                      }
                      student={students}
                      showAssignee={showAssignee}
                      selecting={selecting}
                      selected={selected.has(row.lead.id)}
                      onPress={() => openLead(row.lead)}
                      onLongPress={() => toggleSelect(row.lead.id)}
                      onCall={() => call(row.lead)}
                      onWhatsApp={() => whatsapp(row.lead)}
                      onSms={() => sms(row.lead)}
                      onTemplate={templates.allowed ? (ch) => setTemplateFor({ lead: row.lead, channel: ch }) : undefined}
                      onPay={
                        students && paySettings && row.lead.stage?.kind === 'won' && Number(row.lead.fee_due ?? 0) > 0
                          ? () => setPayFor(row.lead)
                          : undefined
                      }
                    />,
                  )}
                </View>
              )
            }
          />
        )}

        {/* Marked: what to do with them */}
        {selecting && (
          <ModernActionSheet
            title={`${selected.size} ${students ? (selected.size === 1 ? 'student' : 'students') : selected.size === 1 ? 'lead' : 'leads'} · what to do?`}
            actions={modernActions}
            disabled={markingAll}
            onPick={(key) => runAction(modernActions.find((a) => a.key === key)!.field)}
          />
        )}

        {toast && (
          <View style={[styles.toast, selecting && { bottom: 210 }]} pointerEvents="none">
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        )}

        {/* Add lead (extended FAB) */}
        {!selecting && !students && (
          <Pressable
            onPress={() => router.push('/leads/edit/new' as Href)}
            android_ripple={{ color: md.ripple, foreground: true }}
            style={({ pressed }) => [m.fab, pressed && styles.fabPressed]}
            accessibilityRole="button"
            accessibilityLabel="Add lead"
          >
            <MIcon name="person-add-alt-1" size={22} color={md.onPrimaryC} />
            <Text style={m.fabText}>Add lead</Text>
          </Pressable>
        )}

        <ListMenu
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={[
            {
              icon: 'notes',
              label: 'Show the latest on cards',
              hint: 'Last note or call under each name',
              on: detailed,
              onPress: () =>
                setDetailed((d) => {
                  saveDetailed(!d);
                  return !d;
                }),
            },
            ...(sort === 'next_call'
              ? [
                  {
                    icon: 'view-agenda' as const,
                    label: 'Group by time',
                    hint: 'Overdue · Today · Tomorrow …',
                    on: groupOn,
                    onPress: toggleGroup,
                  },
                ]
              : []),
            {
              icon: 'history' as const,
              label: 'Switch to the classic design',
              hint: 'Come back any time: More → List design',
              onPress: switchToClassic,
            },
          ]}
        />

        {overlays}
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* 🎓 Students: totals, tap one to show those */}
      {students && !selecting && (
        <StudentsSummary
          onPick={(q) => {
            setLoading(true);
            setQuick(q);
          }}
        />
      )}

      {/* Search + Filter button */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onSubmitEditing={() => search.trim() && rememberSearch(search)}
            returnKeyType="search"
            placeholder={students ? 'Search name, phone, student ID, guardian…' : 'Search name, phone, guardian, area…'}
            placeholderTextColor={colors.textMuted}
            style={styles.search}
            autoCorrect={false}
          />
          {/* ✕ One tap clears it (Android has no clear button of its own) */}
          {search.length > 0 && (
            <Pressable onPress={clearSearch} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={20} color={colors.textMuted} />
            </Pressable>
          )}
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

      {/* 🔍 Recent searches: shown while the empty search box is tapped */}
      {!selecting && searchFocused && !search && recent.length > 0 && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsScroll}
        >
          <Ionicons name="time-outline" size={16} color={colors.textMuted} />
          {recent.map((t) => (
            <Pressable
              key={t}
              onPress={() => runSearch(t)}
              onLongPress={() => removeRecentSearch(students, t).then(setRecent)}
              style={styles.chip}
              accessibilityRole="button"
              accessibilityHint="Searches again. Press and hold to remove it"
            >
              <Text style={styles.chipText}>{t}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => clearRecentSearches(students).then(setRecent)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.clearFilters}>Clear</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* Quick filters + saved filters (hidden while marking) */}
      {!selecting && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsScroll}
        >
          {quickFilters.map((f) => {
            const on = f.key === quick && (f.key !== 'all' || !addedQ);
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  setLoading(true);
                  setQuick(f.key);
                  if (f.key === 'all') setAdded(NO_ADDED);
                }}
                style={[styles.chip, on && styles.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
              </Pressable>
            );
          })}

          {/* ➕ Added by / when */}
          {!students && (
            <AddedChips
              choice={added}
              creators={creators}
              myId={profile?.id ?? null}
              onChange={(next) => {
                setLoading(true);
                setAdded(next);
              }}
            />
          )}

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
              : `${total ?? leads.length} ${
                  students
                    ? (total ?? leads.length) === 1
                      ? 'student'
                      : 'students'
                    : (total ?? leads.length) === 1
                      ? 'lead'
                      : 'leads'
                }${
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
          {/* 📞📝 Compact (as before) / Detailed (last call and note): list and board */}
          <View style={styles.viewToggle}>
            <Pressable
              onPress={() => {
                setDetailed((d) => {
                  saveDetailed(!d);
                  return !d;
                });
              }}
              hitSlop={8}
              style={[styles.viewBtn, detailed && styles.viewBtnOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: detailed }}
              accessibilityLabel={detailed ? 'Detailed cards: showing the last call and note. Switch to compact' : 'Compact cards. Show the last call and note'}
            >
              <Ionicons name={detailed ? 'reader' : 'reader-outline'} size={14} color={detailed ? colors.textOnPrimary : colors.textMuted} />
            </Pressable>
          </View>
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
            accessibilityLabel={`Sort: ${sortLabel(sort, students)}. Change`}
          >
            <Ionicons name="swap-vertical" size={14} color={sort === sortDefault ? colors.textMuted : colors.primary} />
            <Text style={[styles.sortText, sort !== sortDefault && styles.sortTextOn]} numberOfLines={1}>
              {keepOn ? '📌 ' : ''}
              {sortLabel(sort, students)}
            </Text>
            <Ionicons name="chevron-down" size={12} color={sort === sortDefault ? colors.textMuted : colors.primary} />
          </Pressable>
        </View>
      )}

      {/* ➕ How many each person added in the chosen period (tap one to show theirs) */}
      {!selecting && !students && addedCounts.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.addedCounts}
        >
          {addedCounts.map((c) => (
            <Pressable
              key={c.user_id}
              onPress={() => {
                setLoading(true);
                setAdded((a) => ({ ...a, userId: c.user_id }));
              }}
              hitSlop={6}
              accessibilityRole="button"
            >
              <Text style={styles.addedCount}>
                {c.user_id === profile?.id ? 'Me' : (c.name ?? 'No name')} <Text style={styles.addedCountNum}>{c.total}</Text>
                {c.imported > 0 ? ` (${c.imported} imported)` : ''}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {showBoard ? (
        <LeadBoard
          query={{ search: debouncedSearch, quick, userId: profile?.id, filters: effectiveFilters, closedMode, sort, ids: idsFilter, added: addedQ }}
          closedColumns={boardSettings.closed_columns}
          showAssignee={showAssignee}
          reloadKey={boardReload}
          onCall={call}
          onWhatsApp={whatsapp}
          onSms={sms}
          onTemplate={templates.allowed ? (lead, ch) => setTemplateFor({ lead, channel: ch }) : undefined}
          onChanged={(message) => showToast(message)}
          search={debouncedSearch}
          detailed={detailed}
          staleDays={staleDays}
          nameOf={nameOf}
          onPeek={setPeekLead}
          onPlayVoice={(lead, fileId, seconds) => setPlaying({ id: fileId, name: `Voice note · ${lead.name}`, duration_sec: seconds })}
          selected={selected}
          onToggle={(lead) => {
            // Marked on the board: the bar below works on it like on the list
            setBoardPicked((m) => new Map(m).set(lead.id, lead));
            toggleSelect(lead.id);
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
            <>
              {resortBar}
              {error ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{listIsFiltered ? 'No matching leads' : 'No leads yet'}</Text>
              <Text style={styles.emptyText}>
                {listIsFiltered ? 'Try another search or change the filters.' : 'Tap + to add your first lead.'}
              </Text>
              {/* 🔍 Searched inside a filter: try all leads */}
              {!!debouncedSearch && narrowed && (
                <Pressable onPress={searchEverywhere} style={styles.searchAllBtn} accessibilityRole="button">
                  <Text style={styles.searchAllText}>
                    🔍 Search all {students ? 'students' : 'leads'} for “{debouncedSearch}”
                  </Text>
                </Pressable>
              )}
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator style={styles.footer} color={colors.primary} /> : null
          }
          renderItem={({ item }) =>
            doneWrap(
              item.id,
              <LeadCard
                lead={item}
                search={debouncedSearch}
                detailed={detailed}
                staleDays={staleDays}
                nameOf={nameOf}
                onPeek={() => setPeekLead(item)}
                onPlayVoice={(fileId, seconds) => setPlaying({ id: fileId, name: `Voice note · ${item.name}`, duration_sec: seconds })}
                student={students}
                showAssignee={showAssignee}
                selecting={selecting}
                selected={selected.has(item.id)}
                onPress={() => {
                  if (selecting) return toggleSelect(item.id);
                  // 🔍 A search that found what was needed: keep it in the recent ones
                  if (debouncedSearch.trim()) rememberSearch(debouncedSearch);
                  touched.current.add(item.id);
                  router.push(`/leads/${item.id}` as Href);
                }}
                onLongPress={() => toggleSelect(item.id)}
                onCall={() => call(item)}
                onWhatsApp={() => whatsapp(item)}
                onSms={() => sms(item)}
                onTemplate={templates.allowed ? (ch) => setTemplateFor({ lead: item, channel: ch }) : undefined}
                onPay={
                  students && paySettings && item.stage?.kind === 'won' && Number(item.fee_due ?? 0) > 0
                    ? () => setPayFor(item)
                    : undefined
                }
              />,
            )
          }
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

      {/* Add button (hidden while marking; students come from admissions) */}
      {!selecting && !students && (
        <Pressable
          onPress={() => router.push('/leads/edit/new' as Href)}
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          accessibilityRole="button"
          accessibilityLabel="Add lead"
        >
          <Text style={styles.fabText}>＋</Text>
        </Pressable>
      )}

      {overlays}
    </View>
  );
}

// =====================================================================
// One lead card
// =====================================================================
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // 📌 Keep in place
  resort: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#FFF4D6',
  },
  resortText: { fontSize: 13, color: '#7A4B00' },
  resortBtn: { fontSize: 13, fontWeight: fontWeight.bold, color: '#7A4B00' },
  done: { gap: 2 },
  lockLine: {
    alignSelf: 'flex-start',
    marginLeft: spacing.md,
    marginBottom: 2,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#FDE7E7',
    color: '#B42318',
    fontSize: 11.5,
    fontWeight: fontWeight.bold,
  },
  doneDim: { opacity: 0.5 },
  doneText: { fontSize: 11.5, fontWeight: fontWeight.semibold, color: md.onOkC, marginLeft: spacing.md, marginBottom: 4 },
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
  matchLine: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  lastRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  lastDot: { width: 7, height: 7, borderRadius: 4 },
  lastText: { flexShrink: 1, fontSize: fontSize.caption, color: colors.textMuted },
  lastStale: { color: colors.warning, fontWeight: fontWeight.semibold },
  lastNote: { flexShrink: 1, fontSize: fontSize.caption, color: colors.text, fontStyle: 'italic' },
  lastVoice: { flexShrink: 1, fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },
  lastMuted: { fontStyle: 'normal', fontWeight: fontWeight.regular, color: colors.textMuted },
  searchAllBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  searchAllText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
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
  addedCounts: { flexDirection: 'row', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  addedCount: { fontSize: fontSize.caption, color: colors.textMuted },
  addedCountNum: { fontWeight: fontWeight.bold, color: colors.text },
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
// ✨ The new design
const m = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 48,
    marginHorizontal: 16,
    marginTop: 2,
    paddingLeft: 16,
    paddingRight: 6,
    borderRadius: 24,
    backgroundColor: md.surface2,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 0 },
  filterBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnOn: { backgroundColor: md.primaryC },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 9.5, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 16, paddingRight: 24, paddingTop: 10, paddingBottom: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2, minHeight: 30 },
  metaText: { flex: 1, fontSize: 12.5, color: colors.textMuted },
  metaStrong: { fontWeight: fontWeight.semibold, color: colors.text },
  groupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: md.outline,
  },
  groupBtnOn: { backgroundColor: md.primaryC, borderColor: md.primaryC },
  groupText: { fontSize: 11.5, fontWeight: fontWeight.semibold, color: colors.textMuted },
  groupTextOn: { color: md.onPrimaryC },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '45%' },
  sortText: { fontSize: 12.5, fontWeight: fontWeight.semibold, color: colors.primary, flexShrink: 1 },
  list: { paddingHorizontal: 12, flexGrow: 1 },
  cardGap: { marginBottom: 6 },
  group: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
    color: colors.textMuted,
    paddingTop: 12,
    paddingBottom: 6,
    paddingHorizontal: 6,
  },
  groupLate: { color: md.onErrorC },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 20,
    borderRadius: 16,
    backgroundColor: md.primaryC,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  fabText: { fontSize: 14.5, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
});
