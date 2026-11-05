import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { LeadDetailView } from '@/app/(app)/leads/[id]';
import {
  DEFAULT_APPROVAL_SETTINGS,
  stageBadge,
  canApprove,
  getApprovalSettings,
  type ApprovalSettings,
} from '@/features/approval/api';
import { ApprovalActionSheet, admissionChecks, type ApprovalSheetKind } from '@/features/approval/ApprovalCard';
import { BulkPlacementSheet } from '@/features/approval/BulkPlacementSheet';
import {
  LEAD_BULK,
  LeadRowMenu,
  RowMenu,
  RowNote,
  RowPay,
  RowUpload,
  type RowAction,
} from '@/features/web/students/RowActions';
import { LeadBoard } from '@/features/board/LeadBoard';
import { openWhatsApp } from '@/features/leads/contact';
import { LeadQuickSheet, type QuickField } from '@/features/leads/LeadQuickSheet';
import { LostSheet } from '@/features/pipeline/LostSheet';
import { canHandOver } from '@/features/settings/assignment';
import { canTakePayments, getFeeSettings, type FeeSettings } from '@/features/fees/api';
import { FeeChangeSheet } from '@/features/fees/FeeChangeSheet';
import { LeadPeekSheet } from '@/features/leads/LeadPeekSheet';
import { PapersPopup } from '@/features/web/students/PapersPopup';
import { useAuth } from '@/features/auth/AuthProvider';
import { money } from '@/features/fees/api';
import { writeAndShareSpreadsheet } from '@/features/import-export/excel';
import {
  listAllMatchingLeads,
  listAssignableUsers,
  listLeads,
  type LeadListItem,
  type LeadSort,
  type QuickFilter,
} from '@/features/leads/api';
import { LeadFilterSheet } from '@/features/leads/LeadFilterSheet';
import { countActiveFilters, type LeadFilters } from '@/features/leads/filters';
import { ago, callLineText } from '@/features/leads/lastActivity';
import { StudentsSummary } from '@/features/students/StudentsSummary';
import { dialogOpen, loadPref, onKey, savePref, typingInField } from '@/features/web/prefs';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐🎓 Students on a computer screen
//   A table (sortable columns, choose the columns, tick many, export),
//   filters on top, and the student opens in a panel on the right, so the
//   list stays in view. Narrower screens get the panel over the table.
// =====================================================================

type ColKey =
  | 'ref'
  | 'name'
  | 'phone'
  | 'course'
  | 'fee'
  | 'next_due'
  | 'papers'
  | 'approval'
  | 'nu'
  | 'section'
  | 'last'
  | 'admitted'
  | 'admitted_by'
  // 📋 Leads
  | 'stage'
  | 'rating'
  | 'interest'
  | 'source'
  | 'assignee'
  | 'follow'
  | 'created'
  | 'added_by';

type PopupKind = 'menu' | RowAction;

const APPROVAL_KINDS: ApprovalSheetKind[] = [
  'list',
  'approve',
  'return',
  'resubmit',
  'reg_approve',
  'reg_return',
  'reg_resubmit',
  'place',
  'nu',
  'ref',
];

/** What a row's cells can open */
type Act = {
  officer: boolean;
  /** ৳ paid in total before each approval opens */
  mins: { admission: number; registration: number };
  open: (kind: PopupKind, r: LeadListItem) => void;
  /** 📋 copy a value (College ID, NU ID, phone) */
  copy: (value: string, what: string) => void;
};

type Col = {
  key: ColKey;
  label: string;
  width?: number;
  /** grows to fill the row */
  flex?: number;
  /** a click on the header: these sorts, in turn */
  sorts?: LeadSort[];
};

const COLS: Col[] = [
  { key: 'ref', label: 'College ID', width: 104, sorts: ['student_id'] },
  { key: 'name', label: 'Name', flex: 1.2, sorts: ['name'] },
  { key: 'phone', label: 'Phone', width: 130 },
  { key: 'course', label: 'Course · Batch', flex: 1 },
  { key: 'section', label: 'Section', width: 96 },
  { key: 'fee', label: 'Fee', width: 150, sorts: ['due_most'] },
  { key: 'next_due', label: 'Next installment', width: 130, sorts: ['next_due'] },
  { key: 'papers', label: 'Papers', width: 120, sorts: ['papers_missing'] },
  { key: 'approval', label: 'Approval', width: 230 },
  { key: 'nu', label: 'NU Admission ID', width: 136 },
  { key: 'last', label: 'Last call / note', flex: 1.4 },
  { key: 'admitted', label: 'Admitted', width: 112, sorts: ['admitted_newest', 'admitted_oldest'] },
  { key: 'admitted_by', label: 'Admitted by', width: 130 },
  // 📋 Leads
  { key: 'stage', label: 'Stage', width: 150 },
  { key: 'rating', label: 'Rating', width: 86 },
  { key: 'interest', label: 'Interested in', flex: 1 },
  { key: 'source', label: 'Source', width: 130 },
  { key: 'assignee', label: 'With', width: 130 },
  { key: 'follow', label: 'Next call', width: 140, sorts: ['next_call'] },
  { key: 'created', label: 'Added', width: 112, sorts: ['newest', 'oldest'] },
  { key: 'added_by', label: 'Added by', width: 130 },
];

/** The columns each list can show */
const MODE_COLS: Record<Mode, ColKey[]> = {
  students: [
    'ref',
    'name',
    'phone',
    'course',
    'section',
    'fee',
    'next_due',
    'papers',
    'approval',
    'nu',
    'last',
    'admitted',
    'admitted_by',
  ],
  leads: [
    'name',
    'phone',
    'stage',
    'rating',
    'interest',
    'source',
    'assignee',
    'follow',
    'last',
    'created',
    'added_by',
  ],
};
const MODE_DEFAULT: Record<Mode, ColKey[]> = {
  // (v3: Section shown by default)
  students: ['ref', 'name', 'phone', 'course', 'section', 'fee', 'papers', 'approval', 'nu', 'last', 'admitted'],
  leads: ['name', 'phone', 'stage', 'rating', 'interest', 'assignee', 'follow', 'last', 'created'],
};
const MODE_PANEL: Record<Mode, ColKey[]> = {
  students: ['ref', 'name', 'fee', 'papers', 'approval'],
  leads: ['name', 'stage', 'follow'],
};
const MODE_KEYS: Record<Mode, { cols: string; sort: string; dense: string; view: string }> = {
  students: { cols: 'web_students_cols_v3', sort: 'web_students_sort', dense: 'web_students_compact', view: '' },
  leads: { cols: 'web_leads_cols_v1', sort: 'web_leads_sort', dense: 'web_leads_compact', view: 'web_leads_view' },
};

export type Mode = 'students' | 'leads';

/** Narrowest a growing column gets (then the table scrolls sideways) */
const FLEX_MIN = 150;

const CHECK_W = 40;
/** ⋯ the row's menu */
const MENU_W = 36;

/** Table colours (light / dark website) */
const T = isDark
  ? {
      head: '#1B2439',
      headHover: '#232E48',
      zebra: '#141C2E',
      hover: '#1D2740',
      ticked: '#1C2848',
      line: '#222B42',
      dim: '#5E6883',
      track: '#28324B',
      box: '#4A5573',
      dark: '#080C17',
    }
  : {
      head: '#F1F4FA',
      headHover: '#E6EBF6',
      zebra: '#FBFCFE',
      hover: '#F2F5FC',
      ticked: '#EEF3FF',
      line: '#EEF1F6',
      dim: '#A3ABBD',
      track: '#E8ECF4',
      box: '#B5BED3',
      dark: '#101A33',
    };

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export function WebStudentsScreen({ mode = 'students' }: { mode?: Mode }) {
  const leadsMode = mode === 'leads';
  const KEYS = MODE_KEYS[mode];
  const DEFAULT_COLS = MODE_DEFAULT[mode];
  const PANEL_COLS = MODE_PANEL[mode];
  const MODE_COLSET = MODE_COLS[mode];
  const { profile, hasPermission, assignmentOn, sharedMode, assignment } = useAuth();
  const params = useLocalSearchParams<{ q?: string; quick?: string; open?: string }>();
  const search = typeof params.q === 'string' ? params.q : '';
  const { width, height: winH } = useWindowDimensions();
  // Wide: the panel sits next to the table · else it covers part of it
  const sideBySide = width >= 1360;
  const seesOthers = sharedMode || hasPermission('leads.view_all') || hasPermission('leads.view_team');

  const [approval, setApproval] = useState<ApprovalSettings>(DEFAULT_APPROVAL_SETTINGS);
  const [approvalOn, setApprovalOn] = useState(false);
  useEffect(() => {
    getApprovalSettings().then((s) => {
      setApproval(s);
      setApprovalOn(s.enabled);
    });
  }, []);
  // 🎓 The Admission Officer (or an admin): approve from the row, change the fee
  const officer = canApprove(approval, profile, hasPermission('settings.manage'));
  // 🔀 Move ticked students to another course · batch · section
  const [moveOpen, setMoveOpen] = useState(false);
  // A popup opened from a row
  const [popup, setPopup] = useState<{ kind: PopupKind; row: LeadListItem } | null>(null);
  // 💵 Payments from the row (Settings → Fee: who takes payments)
  const [feeSettings, setFeeSettings] = useState<FeeSettings | null>(null);
  useEffect(() => {
    getFeeSettings()
      .then(setFeeSettings)
      .catch(() => setFeeSettings(null));
  }, []);
  const canPay = !!feeSettings && canTakePayments(feeSettings, profile, hasPermission('settings.manage'));

  // 📋 Leads: hand over (Settings → Lead assignment), board or table
  const mayHandOver = canHandOver(assignment, hasPermission);
  const [view, setView] = useState<'table' | 'board'>(() =>
    leadsMode ? loadPref<'table' | 'board'>(KEYS.view, 'table') : 'table',
  );
  const [boardKey, setBoardKey] = useState(0);
  const [bulk, setBulk] = useState<QuickField | 'lost' | null>(null);
  const [oneBulk, setOneBulk] = useState<{ field: QuickField | 'lost'; row: LeadListItem } | null>(null);

  const leadQuick: { key: QuickFilter; label: string }[] = [
    { key: 'all', label: 'All open' },
    ...(assignmentOn && seesOthers ? [{ key: 'mine' as QuickFilter, label: 'Mine' }] : []),
    { key: 'new', label: '🆕 New' },
    { key: 'hot', label: '🔥 Hot' },
    ...(assignmentOn && seesOthers ? [{ key: 'unassigned' as QuickFilter, label: 'Unassigned' }] : []),
    { key: 'closed', label: 'Closed' },
  ];
  const quickFilters: { key: QuickFilter; label: string }[] = leadsMode
    ? leadQuick
    : [
        { key: 'all', label: 'All' },
        ...(assignmentOn && seesOthers ? [{ key: 'mine' as QuickFilter, label: 'Mine' }] : []),
        { key: 'new_students', label: 'New this month' },
        { key: 'due', label: '💵 Due' },
        { key: 'overdue', label: '⚠ Overdue' },
        { key: 'paid', label: '✓ Paid' },
        { key: 'papers', label: '📄 Papers missing' },
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
      ];

  const [quick, setQuick] = useState<QuickFilter>((params.quick as QuickFilter) || 'all');
  useEffect(() => {
    if (params.quick) setQuick(params.quick as QuickFilter);
  }, [params.quick]);
  const [filters, setFilters] = useState<LeadFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [sort, setSort] = useState<LeadSort>(() =>
    loadPref<LeadSort>(KEYS.sort, leadsMode ? 'next_call' : 'admitted_newest'),
  );
  const [cols, setCols] = useState<ColKey[]>(() =>
    loadPref<ColKey[]>(KEYS.cols, DEFAULT_COLS).filter((k) => MODE_COLSET.includes(k)),
  );
  const [colsOpen, setColsOpen] = useState(false);
  // Row height: comfortable or compact (more students on one screen)
  const [dense, setDense] = useState(() => loadPref(KEYS.dense, false));

  // Search waits a moment while typing
  const [debounced, setDebounced] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [rows, setRows] = useState<LeadListItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const [openId, setOpenId] = useState<string | null>(typeof params.open === 'string' ? params.open : null);
  useEffect(() => {
    if (typeof params.open === 'string' && params.open) setOpenId(params.open);
  }, [params.open]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    listAssignableUsers({ includeInactive: true })
      .then((u) => setNames(new Map(u.map((p) => [p.id, p.full_name ?? '']))))
      .catch(() => undefined);
  }, []);
  const nameOf = useCallback((id: string | null | undefined) => (id ? (names.get(id) ?? null) : null), [names]);

  const query = useMemo(
    () => ({
      search: debounced,
      quick,
      filters,
      sort,
      students: !leadsMode,
      userId: profile?.id,
      closedMode: leadsMode ? ('hide' as const) : ('show' as const),
    }),
    [debounced, quick, filters, sort, profile?.id, leadsMode],
  );

  // Latest request wins (typing fast sends many)
  const reqNo = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      const no = ++reqNo.current;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const r = await listLeads({ ...query, page: 0 });
        if (no !== reqNo.current) return;
        setRows(r.items);
        setTotal(r.total);
        setHasMore(r.hasMore);
        setPage(0);
      } catch (e) {
        if (no === reqNo.current) setError(e instanceof Error ? e.message : `Could not load the ${mode}.`);
      } finally {
        if (no === reqNo.current) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    load();
    setTicked(new Set());
  }, [load]);

  // Back from a student's full page: fresh numbers
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      load(true);
    }, [load]),
  );

  const loadMore = async () => {
    if (!hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const r = await listLeads({ ...query, page: page + 1 });
      setRows((old) => {
        const seen = new Set(old.map((x) => x.id));
        return [...old, ...r.items.filter((x) => !seen.has(x.id))];
      });
      setHasMore(r.hasMore);
      setPage(page + 1);
    } catch {
      // the next scroll tries again
    } finally {
      setLoadingMore(false);
    }
  };

  // The open student in the address too (a reload or a shared link opens it)
  const openStudent = (id: string | null) => {
    setOpenId(id);
    router.setParams({ open: id ?? undefined });
  };
  const closePanel = () => {
    openStudent(null);
    load(true);
  };

  const pickSort = (c: Col) => {
    if (!c.sorts) return;
    const i = c.sorts.indexOf(sort);
    const next = c.sorts[(i + 1) % c.sorts.length];
    setSort(next);
    savePref(KEYS.sort, next);
  };

  const toggleTick = (id: string) =>
    setTicked((old) => {
      const n = new Set(old);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allTicked = rows.length > 0 && rows.every((r) => ticked.has(r.id));

  // ⌨ J/K or ↓/↑ move · Enter full page · X tick · Esc close
  const stateRef = useRef({ rows, openId });
  stateRef.current = { rows, openId };
  useEffect(
    () =>
      onKey((e) => {
        if (typingInField(e) || dialogOpen()) return;
        const { rows: list, openId: current } = stateRef.current;
        const at = list.findIndex((r) => r.id === current);
        const k = e.key;
        if (k === 'j' || k === 'J' || k === 'ArrowDown') {
          e.preventDefault();
          const next = list[Math.min(list.length - 1, at + 1)];
          if (next) openStudent(next.id);
        } else if (k === 'k' || k === 'K' || k === 'ArrowUp') {
          e.preventDefault();
          const prev = list[Math.max(0, at - 1)];
          if (prev) openStudent(prev.id);
        } else if (k === 'Enter' && current) {
          router.push(`/leads/${current}` as Href);
        } else if ((k === 'x' || k === 'X') && current) {
          toggleTick(current);
        } else if (k === 'Escape' && current) {
          closePanel();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // In this list's own order (Leads and Students differ)
  const modeCols = MODE_COLSET.map((k) => COLS.find((c) => c.key === k)!);
  const chosen = modeCols.filter((c) => cols.includes(c.key));
  const compact = !!openId && sideBySide;
  const shown = compact ? chosen.filter((c) => PANEL_COLS.includes(c.key)) : chosen;
  // Too many columns for the screen: the table scrolls sideways
  const [tableW, setTableW] = useState(0);
  const minW = CHECK_W + MENU_W + shown.reduce((sum, c) => sum + (c.width ?? FLEX_MIN), 0);
  const innerW = Math.max(tableW, minW);

  const doExport = async () => {
    setExporting(true);
    try {
      const list = ticked.size > 0 ? rows.filter((r) => ticked.has(r.id)) : await listAllMatchingLeads(query);
      if (list.length === 0) throw new Error(`No ${mode} to export.`);
      const headers = chosen.map((c) => c.label);
      const data = list.map((r) => chosen.map((c) => cellText(c.key, r, nameOf)));
      const stamp = new Date().toISOString().slice(0, 10);
      await writeAndShareSpreadsheet(`${mode}-${stamp}.xlsx`, headers, data, leadsMode ? 'Leads' : 'Students');
      showToast(`⬇ ${list.length} ${leadsMode ? 'lead' : 'student'}${list.length > 1 ? 's' : ''} exported.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not export.');
    } finally {
      setExporting(false);
    }
  };

  const nFilters = countActiveFilters(filters);
  const act: Act = {
    officer,
    mins: { admission: approval.admission_min_paid, registration: approval.registration_min_paid },
    open: (kind, r) => setPopup({ kind, row: r }),
    copy: (value, what) => {
      navigator.clipboard
        ?.writeText(value)
        .then(() => showToast(`📋 ${what} copied: ${value}`))
        .catch(() => showToast('Could not copy.'));
    },
  };
  const moveSheet = moveOpen ? (
    <BulkPlacementSheet
      students={rows
        .filter((r) => ticked.has(r.id))
        .map((r) => ({
          id: r.id,
          courseId: r.admitted_course?.id ?? null,
          batchId: r.admitted_batch?.id ?? null,
          sectionId: r.admitted_section?.id ?? null,
          place: [r.admitted_course?.name, r.admitted_batch?.name, r.admitted_section ? `Section ${r.admitted_section.name}` : null]
            .filter(Boolean)
            .join(' · '),
        }))}
      onClose={() => setMoveOpen(false)}
      onDone={(message) => {
        setMoveOpen(false);
        setTicked(new Set());
        showToast(message);
        load(true);
      }}
    />
  ) : null;
  const popupDone = (message: string) => {
    setPopup(null);
    showToast(message);
    load(true);
  };

  const table = (
    <View style={styles.tableWrap} onLayout={(e) => setTableW(e.nativeEvent.layout.width - 2)}>
      <ScrollView horizontal style={styles.flex} contentContainerStyle={{ width: innerW, flexDirection: 'column' }}>
        {/* Header */}
        <View style={styles.headRow}>
          <Pressable
            style={[styles.cell, { width: CHECK_W }]}
            onPress={() => setTicked(allTicked ? new Set() : new Set(rows.map((r) => r.id)))}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: allTicked }}
            accessibilityLabel="Tick all"
          >
            <Box on={allTicked} />
          </Pressable>
          <View style={[styles.cell, { width: MENU_W }]} />
          {shown.map((c) => {
            const on = !!c.sorts?.includes(sort);
            return (
              <Pressable
                key={c.key}
                onPress={c.sorts ? () => pickSort(c) : undefined}
                disabled={!c.sorts}
                style={(state) => [
                  styles.cell,
                  colStyle(c),
                  c.sorts && (state as { hovered?: boolean }).hovered && styles.headHover,
                ]}
                accessibilityRole={c.sorts ? 'button' : undefined}
                accessibilityLabel={c.sorts ? `Sort by ${c.label}` : undefined}
              >
                <Text style={[styles.headText, on && styles.headTextOn]} numberOfLines={1}>
                  {c.label}
                  {on
                    ? sort === 'admitted_oldest' ||
                      sort === 'student_id' ||
                      sort === 'name' ||
                      sort === 'next_due' ||
                      sort === 'next_call' ||
                      sort === 'oldest'
                      ? ' ▲'
                      : ' ▼'
                    : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Could not load</Text>
            <Text style={styles.muted}>{error}</Text>
            <Pressable onPress={() => load()} style={styles.btn} accessibilityRole="button">
              <Text style={styles.btnText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => r.id}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={styles.bigIcon}>{leadsMode ? '📋' : '🎓'}</Text>
                <Text style={styles.emptyTitle}>
                  {search || quick !== 'all' || nFilters ? `No ${mode} match` : `No ${mode} yet`}
                </Text>
              </View>
            }
            ListFooterComponent={
              loadingMore ? <ActivityIndicator style={styles.more} color={colors.primary} /> : undefined
            }
            renderItem={({ item: r, index }) => (
              <Row
                row={r}
                shown={shown}
                zebra={index % 2 === 1}
                open={r.id === openId}
                ticked={ticked.has(r.id)}
                nameOf={nameOf}
                act={act}
                dense={dense}
                onOpen={() => openStudent(r.id)}
                onTick={() => toggleTick(r.id)}
              />
            )}
          />
        )}
      </ScrollView>
    </View>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.body}>
        <View style={styles.listSide}>
          {/* Title row */}
          <View style={styles.titleRow}>
            <Text style={styles.h1}>{leadsMode ? 'Leads' : 'Students'}</Text>
            {total != null && (
              <View style={styles.count}>
                <Text style={styles.countText}>{total.toLocaleString('en-IN')}</Text>
              </View>
            )}
            {!!search && <Text style={styles.muted}>matching “{search}”</Text>}
            <View style={styles.flex} />
            {leadsMode && (
              <>
                <ToolButton label="➕ Add lead" on onPress={() => router.push('/leads/edit/new' as Href)} />
                <ToolButton label="📥 Import" onPress={() => router.push('/import' as Href)} />
                <View style={styles.seg}>
                  {(['table', 'board'] as const).map((v) => (
                    <Pressable
                      key={v}
                      onPress={() => {
                        setView(v);
                        savePref(KEYS.view, v);
                      }}
                      style={[styles.segBtn, view === v && styles.segOn]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: view === v }}
                    >
                      <Text style={[styles.segText, view === v && styles.segTextOn]}>
                        {v === 'table' ? '☰ Table' : '▥ Board'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <ToolButton
              label={nFilters ? `⚙ Filters · ${nFilters}` : '⚙ Filters'}
              on={nFilters > 0}
              onPress={() => setFilterOpen(true)}
            />
            {view === 'table' && <ToolButton label="▦ Columns" onPress={() => setColsOpen(true)} />}
            <ToolButton
              label={dense ? '☰ Compact' : '☰ Comfortable'}
              a11y="Row height"
              onPress={() => {
                setDense(!dense);
                savePref(KEYS.dense, !dense);
              }}
            />
            <ToolButton
              label={exporting ? 'Exporting…' : ticked.size ? `⬇ Export ${ticked.size}` : '⬇ Export'}
              onPress={exporting ? undefined : doExport}
            />
            <ToolButton
              label="↻"
              onPress={() => {
                load();
                setBoardKey((n) => n + 1);
              }}
              a11y="Refresh"
            />
          </View>

          {/* Totals: a tap picks that group */}
          {!leadsMode && <StudentsSummary onPick={(q) => setQuick(q)} />}

          {/* Quick filters */}
          <View style={styles.chips}>
            {quickFilters.map((f) => {
              const on = quick === f.key;
              return (
                <Pressable
                  key={f.key}
                  onPress={() => setQuick(f.key)}
                  style={(state) => [
                    styles.chip,
                    on && styles.chipOn,
                    !on && (state as { hovered?: boolean }).hovered && styles.chipHover,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
                </Pressable>
              );
            })}
            {nFilters > 0 && (
              <Pressable onPress={() => setFilters({})} style={styles.chipClear} accessibilityRole="button">
                <Text style={styles.chipClearText}>✕ Clear filters</Text>
              </Pressable>
            )}
          </View>

          {/* Ticked: what to do with them */}
          {ticked.size > 0 && (
            <View style={styles.bulk}>
              <Text style={styles.bulkText}>{ticked.size} ticked</Text>
              {leadsMode &&
                LEAD_BULK.filter((b) => b.field !== 'assign' || mayHandOver).map((b) => (
                  <Pressable
                    key={b.field}
                    onPress={() => setBulk(b.field)}
                    style={styles.bulkBtn}
                    accessibilityRole="button"
                  >
                    <Text style={styles.bulkBtnText}>{b.label}</Text>
                  </Pressable>
                ))}
              {!leadsMode && officer && (
                <Pressable onPress={() => setMoveOpen(true)} style={styles.bulkBtn} accessibilityRole="button">
                  <Text style={styles.bulkBtnText}>🔀 Course · Batch · Section</Text>
                </Pressable>
              )}
              <Pressable onPress={doExport} style={styles.bulkBtn} accessibilityRole="button">
                <Text style={styles.bulkBtnText}>⬇ Export</Text>
              </Pressable>
              <Pressable onPress={() => setTicked(new Set())} style={styles.bulkBtn} accessibilityRole="button">
                <Text style={styles.bulkBtnText}>Clear</Text>
              </Pressable>
            </View>
          )}

          {view === 'board' && leadsMode ? (
            <View style={[styles.boardWrap, { height: Math.max(420, winH - 230) }]}>
              <LeadBoard
                query={query}
                closedColumns={false}
                showAssignee={seesOthers}
                reloadKey={boardKey}
                onCall={(l) => openStudent(l.id)}
                onWhatsApp={(l) => openWhatsApp(l)}
                onSms={(l) => openStudent(l.id)}
                onChanged={(m) => showToast(m)}
                search={debounced}
                detailed
                staleDays={0}
                nameOf={nameOf}
                onPeek={(l) => setPopup({ kind: 'notes', row: l })}
                onPlayVoice={(l) => openStudent(l.id)}
                selected={ticked}
                onToggle={(l) => toggleTick(l.id)}
              />
            </View>
          ) : (
            table
          )}
        </View>

        {/* The open student */}
        {openId && sideBySide && (
          <View style={styles.panel}>
            <PanelHead id={openId} onClose={closePanel} title={leadsMode ? 'Lead' : 'Student'} />
            <View style={styles.flex}>
              <LeadDetailView key={openId} id={openId} embedded onClosed={closePanel} />
            </View>
          </View>
        )}
      </View>

      {openId && !sideBySide && (
        <Modal visible transparent animationType="fade" onRequestClose={closePanel}>
          <View style={styles.drawerBack}>
            <Pressable style={styles.flex} onPress={closePanel} accessibilityLabel="Close panel" />
            <View style={styles.drawer}>
              <PanelHead id={openId} onClose={closePanel} title={leadsMode ? 'Lead' : 'Student'} />
              <View style={styles.flex}>
                <LeadDetailView key={openId} id={openId} embedded onClosed={closePanel} />
              </View>
            </View>
          </View>
        </Modal>
      )}

      {popup?.kind === 'papers' && (
        <PapersPopup
          leadId={popup.row.id}
          name={popup.row.name}
          onClose={() => setPopup(null)}
          onOpen={() => {
            setPopup(null);
            openStudent(popup.row.id);
          }}
        />
      )}
      {popup?.kind === 'notes' && (
        <LeadPeekSheet
          all
          lead={popup.row}
          nameOf={nameOf}
          onClose={() => setPopup(null)}
          onOpen={() => {
            setPopup(null);
            openStudent(popup.row.id);
          }}
          onAddNote={() => {
            setPopup(null);
            openStudent(popup.row.id);
          }}
        />
      )}
      {popup?.kind === 'fee' && (
        <FeeChangeSheet leadId={popup.row.id} name={popup.row.name} onClose={() => setPopup(null)} onDone={popupDone} />
      )}
      {popup?.kind === 'menu' && leadsMode && (
        <LeadRowMenu
          row={popup.row}
          mayHandOver={mayHandOver}
          onClose={() => setPopup(null)}
          onPick={(a) => {
            const row = popup.row;
            if (a === 'open' || a === 'admit') {
              setPopup(null);
              openStudent(row.id);
              if (a === 'admit') showToast('🎓 Admit from the lead’s Pipeline card (right).');
            } else if (a === 'whatsapp') {
              setPopup(null);
              openWhatsApp(row);
            } else if (a === 'notes') setPopup({ kind: 'notes', row });
            else if (a === 'upload') setPopup({ kind: 'upload', row });
            else {
              setPopup(null);
              setOneBulk({ field: a as QuickField | 'lost', row });
            }
          }}
        />
      )}
      {popup?.kind === 'menu' && !leadsMode && (
        <RowMenu
          row={popup.row}
          officer={officer}
          canPay={canPay}
          mins={{ admission: approval.admission_min_paid, registration: approval.registration_min_paid }}
          onClose={() => setPopup(null)}
          onPick={(a) => {
            const row = popup.row;
            if (a === 'open') {
              setPopup(null);
              openStudent(row.id);
            } else setPopup({ kind: a, row });
          }}
        />
      )}
      {popup?.kind === 'pay' && feeSettings && (
        <RowPay
          row={popup.row}
          settings={feeSettings}
          isAdmin={hasPermission('settings.manage')}
          onClose={() => setPopup(null)}
          onDone={popupDone}
        />
      )}
      {popup?.kind === 'note' && <RowNote row={popup.row} onClose={() => setPopup(null)} onDone={popupDone} />}
      {popup?.kind === 'upload' && <RowUpload row={popup.row} onClose={() => setPopup(null)} onDone={popupDone} />}
      {popup && APPROVAL_KINDS.includes(popup.kind as ApprovalSheetKind) && (
        <ApprovalActionSheet
          kind={popup.kind as ApprovalSheetKind}
          lead={approvalLead(popup.row)}
          checks={approvalChecks(popup.row)}
          warnings={approvalChecks(popup.row).filter((c) => !c.ok).length}
          onClose={() => setPopup(null)}
          onDone={popupDone}
        />
      )}

      {/* 📋 Leads: the phone's sheets, for one row or the ticked ones */}
      {(bulk || oneBulk) && (bulk ?? oneBulk!.field) !== 'lost' && (
        <LeadQuickSheet
          visible
          field={(bulk ?? oneBulk!.field) as QuickField}
          leads={bulk ? rows.filter((r) => ticked.has(r.id)) : [oneBulk!.row]}
          onClose={() => {
            setBulk(null);
            setOneBulk(null);
          }}
          onSaved={(message) => {
            setBulk(null);
            setOneBulk(null);
            if (bulk) setTicked(new Set());
            showToast(message);
            load(true);
            setBoardKey((n) => n + 1);
          }}
        />
      )}
      <LostSheet
        visible={(bulk ?? oneBulk?.field) === 'lost'}
        leads={(bulk ? rows.filter((r) => ticked.has(r.id)) : oneBulk ? [oneBulk.row] : []).map((l) => ({
          id: l.id,
          name: l.name,
        }))}
        onClose={() => {
          setBulk(null);
          setOneBulk(null);
        }}
        onSaved={(message) => {
          if (bulk) setTicked(new Set());
          setBulk(null);
          setOneBulk(null);
          showToast(message);
          load(true);
          setBoardKey((n) => n + 1);
        }}
      />

      <LeadFilterSheet
        visible={filterOpen}
        value={filters}
        onClose={() => setFilterOpen(false)}
        onApply={(f) => {
          setFilters(f);
          setFilterOpen(false);
        }}
        students={!leadsMode}
        hiddenFields={leadsMode ? [] : ['stage', 'lost_reason', 'visit']}
      />

      {colsOpen && (
        <ColumnsDialog
          all={modeCols}
          defaults={DEFAULT_COLS}
          value={cols}
          onClose={() => setColsOpen(false)}
          onChange={(next) => {
            setCols(next);
            savePref(KEYS.cols, next);
          }}
        />
      )}

      {moveSheet}

      {toast && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------
function Row({
  row: r,
  shown,
  zebra,
  open,
  ticked,
  nameOf,
  act,
  dense,
  onOpen,
  onTick,
}: {
  dense: boolean;
  row: LeadListItem;
  shown: Col[];
  zebra: boolean;
  open: boolean;
  ticked: boolean;
  nameOf: (id: string | null) => string | null;
  act: Act;
  onOpen: () => void;
  onTick: () => void;
}) {
  return (
    <Pressable
      onPress={onOpen}
      style={(state) => [
        styles.row,
        dense && styles.rowDense,
        zebra && styles.rowZebra,
        (state as { hovered?: boolean }).hovered && styles.rowHover,
        ticked && styles.rowTicked,
        open && styles.rowOpen,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${r.name}`}
    >
      {(state) => (
        <>
          <Pressable
            style={[styles.cell, { width: CHECK_W }]}
            onPress={onTick}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ticked }}
            accessibilityLabel={`Tick ${r.name}`}
          >
            <Box on={ticked} />
          </Pressable>
          {/* ⋯ the everyday work on this student */}
          <Pressable
            style={(st) => [
              styles.cell,
              styles.menuCell,
              { width: MENU_W },
              (st as { hovered?: boolean }).hovered && styles.hitHover,
            ]}
            onPress={() => act.open('menu', r)}
            accessibilityRole="button"
            accessibilityLabel={`Actions for ${r.name}`}
          >
            <Text style={styles.menuDots}>⋯</Text>
          </Pressable>
          {shown.map((c) => (
            <View key={c.key} style={[styles.cell, dense && styles.cellDense, colStyle(c)]}>
              <Cell
                col={c.key}
                r={r}
                nameOf={nameOf}
                act={act}
                dense={dense}
                hovered={!!(state as { hovered?: boolean }).hovered}
              />
            </View>
          ))}
        </>
      )}
    </Pressable>
  );
}

/** A part of a cell that opens something (not the whole row) */
function Hit({ onPress, label, children }: { onPress: () => void; label: string; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      style={(state) => [styles.hit, (state as { hovered?: boolean }).hovered && styles.hitHover]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  );
}

function Cell({
  col,
  r,
  nameOf,
  act,
  dense = false,
  hovered = false,
}: {
  col: ColKey;
  r: LeadListItem;
  nameOf: (id: string | null) => string | null;
  act: Act;
  dense?: boolean;
  hovered?: boolean;
}) {
  // 📋 shown on a hovered row next to IDs and the phone
  const copyBtn = (value: string | null | undefined, what: string) =>
    hovered && value ? (
      <Pressable
        onPress={() => act.copy(value, what)}
        hitSlop={6}
        style={(state) => [styles.copy, (state as { hovered?: boolean }).hovered && styles.copyHover]}
        accessibilityRole="button"
        accessibilityLabel={`Copy ${what}`}
      >
        <Text style={styles.copyText}>📋</Text>
      </Pressable>
    ) : null;
  const admitted = r.stage?.kind === 'won';
  switch (col) {
    case 'ref':
      return (
        <View style={styles.withCopy}>
          <Text style={[styles.mono, styles.shrink, !r.student_ref && styles.dim]} numberOfLines={1}>
            {r.student_ref ?? '—'}
          </Text>
          {copyBtn(r.student_ref, 'College ID')}
        </View>
      );
    case 'name': {
      const cancelled = r.stage?.kind === 'cancelled';
      return (
        <View style={styles.nameCell}>
          <Text style={[styles.name, cancelled && styles.struck]} numberOfLines={1}>
            {r.name}
          </Text>
          {cancelled && <Text style={styles.cancelTag}>Cancelled</Text>}
        </View>
      );
    }
    case 'phone': {
      const phone = r.phone ?? r.whatsapp_number ?? (r.whatsapp_username ? '@' + r.whatsapp_username : null);
      return (
        <View style={styles.withCopy}>
          <Text style={[styles.text, styles.shrink]} numberOfLines={1}>
            {phone ?? '—'}
          </Text>
          {copyBtn(phone, 'Phone')}
        </View>
      );
    }
    case 'course':
      return (
        <Text style={styles.text} numberOfLines={1}>
          {[r.admitted_course?.name, r.admitted_batch?.name].filter(Boolean).join(' · ') || '—'}
        </Text>
      );
    case 'fee': {
      const due = Number(r.fee_due ?? 0);
      const final = Number(r.fee_final ?? 0);
      if (!final && !due) return <Text style={styles.dim}>—</Text>;
      const paidPart = final > 0 ? Math.min(1, Number(r.fee_paid ?? 0) / final) : 0;
      const body = (
        <View style={styles.feeCell}>
          <Text style={[styles.text, due > 0 ? styles.bad : styles.good]} numberOfLines={1}>
            {due > 0 ? `${money(due)} due` : '✓ Paid'}
            {act.officer && admitted ? <Text style={styles.editMark}> ✏️</Text> : null}
          </Text>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(paidPart * 100)}%` }, due <= 0 && styles.barDone]} />
          </View>
        </View>
      );
      // 💰 The Admission Officer: change the discount / final fee
      return act.officer && admitted ? (
        <Hit onPress={() => act.open('fee', r)} label={`Change ${r.name}'s fee`}>
          {body}
        </Hit>
      ) : (
        body
      );
    }
    case 'next_due':
      return (
        <Text style={[styles.text, !r.fee_next_due && styles.dim]}>{r.fee_next_due ? day(r.fee_next_due) : '—'}</Text>
      );
    case 'papers': {
      const req = r.papers_required ?? 0;
      if (!req) return <Text style={styles.dim}>—</Text>;
      const miss = r.papers_missing ?? 0;
      return (
        <Hit onPress={() => act.open('papers', r)} label={`${r.name}'s papers`}>
          <Text style={[styles.text, miss ? styles.warn : styles.good]} numberOfLines={1}>
            {miss ? `${req - miss}/${req} · ${miss} missing` : `✓ ${req}/${req}`}
          </Text>
        </Hit>
      );
    }
    case 'approval': {
      const b = admitted ? stageBadge(r.approval_status, r.registration_status, r.listed_at) : null;
      if (!b) return <Text style={styles.dim}>—</Text>;
      const paid = Number(r.fee_paid ?? 0);
      // ✅ The Admission Officer approves (or sends back) right here:
      //    the admission first (৳ needed), then the registration (৳ needed in total)
      const step =
        r.approval_status === 'waiting'
          ? { approve: 'approve' as const, back: 'return' as const, label: 'Approve', need: act.mins.admission }
          : r.approval_status === 'approved' && (r.registration_status ?? 'waiting') === 'waiting'
            ? {
                approve: 'reg_approve' as const,
                back: 'reg_return' as const,
                label: 'Register',
                need: act.mins.registration,
              }
            : null;
      if (act.officer && step) {
        const ready = paid >= step.need;
        // 📋 No money yet: list without pay (section + NU ID) right here
        if (step.approve === 'approve' && !ready && !r.listed_at) {
          return (
            <View>
              <View style={styles.approveRow}>
                <Pressable
                  onPress={() => act.open('list', r)}
                  style={(state) => [styles.listBtn, (state as { hovered?: boolean }).hovered && styles.approveHover]}
                  accessibilityRole="button"
                  accessibilityLabel={`List ${r.name} without pay`}
                >
                  <Text style={styles.listText}>📋 List</Text>
                </Pressable>
                <Pressable
                  onPress={() => act.open('return', r)}
                  style={(state) => [styles.returnBtn, (state as { hovered?: boolean }).hovered && styles.returnHover]}
                  accessibilityRole="button"
                  accessibilityLabel={`Send ${r.name} back`}
                >
                  <Text style={styles.returnText}>↩</Text>
                </Pressable>
              </View>
              <Text style={styles.needText} numberOfLines={1}>
                Approve needs {money(step.need)} · paid {money(paid)}
              </Text>
            </View>
          );
        }
        return (
          <View>
            <View style={styles.approveRow}>
              <Pressable
                onPress={ready ? () => act.open(step.approve, r) : undefined}
                disabled={!ready}
                style={(state) => [
                  styles.approveBtn,
                  !ready && styles.approveOff,
                  ready && (state as { hovered?: boolean }).hovered && styles.approveHover,
                ]}
                accessibilityRole="button"
                accessibilityState={{ disabled: !ready }}
                accessibilityLabel={`${step.label} ${r.name}`}
              >
                <Text style={[styles.approveText, !ready && styles.approveOffText]}>
                  {ready ? (step.approve === 'approve' ? '✅ ' : '📝 ') : '🔒 '}
                  {step.label}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => act.open(step.back, r)}
                style={(state) => [styles.returnBtn, (state as { hovered?: boolean }).hovered && styles.returnHover]}
                accessibilityRole="button"
                accessibilityLabel={`Send ${r.name} back`}
              >
                <Text style={styles.returnText}>↩</Text>
              </Pressable>
            </View>
            {!ready && (
              <Text style={styles.needText} numberOfLines={1}>
                Needs {money(step.need)} · paid {money(paid)}
              </Text>
            )}
          </View>
        );
      }
      const tone = b.color === 'good' ? styles.pillGood : b.color === 'bad' ? styles.pillBad : styles.pillWait;
      return (
        <View style={[styles.pill, tone]}>
          <Text style={[styles.pillText, tone]} numberOfLines={1}>
            {b.text}
          </Text>
        </View>
      );
    }
    case 'section':
      return r.admitted_section ? (
        <Text style={styles.text} numberOfLines={1}>
          {r.admitted_section.name}
        </Text>
      ) : admitted && r.approval_status ? (
        <Text style={[styles.text, styles.warn]}>⚠ none</Text>
      ) : (
        <Text style={styles.dim}>—</Text>
      );
    case 'nu':
      return (
        <View style={styles.withCopy}>
          <Text style={[styles.mono, styles.shrink, !r.nu_admission_id && styles.dim]} numberOfLines={1}>
            {r.nu_admission_id ?? '—'}
          </Text>
          {copyBtn(r.nu_admission_id, 'NU Admission ID')}
        </View>
      );
    case 'last': {
      const last = r.last;
      const call = last ? callLineText(last, nameOf) : null;
      const note = last?.note_at ? (last.note_kind === 'voice' ? '🎙 Voice note' : last.note_text) : null;
      if (!call && !note) return <Text style={styles.dim}>—</Text>;
      // 📝 A click: every call and note of this student
      return (
        <Hit onPress={() => act.open('notes', r)} label={`All notes of ${r.name}`}>
          {!!call && !(dense && note) && (
            <Text style={styles.small} numberOfLines={1}>
              {call}
            </Text>
          )}
          {!!note && (
            <Text style={styles.smallMuted} numberOfLines={1}>
              📝 {note}
              {last?.note_at ? ` · ${ago(last.note_at)}` : ''}
            </Text>
          )}
        </Hit>
      );
    }
    case 'admitted':
      return <Text style={styles.text}>{day(r.admitted_at)}</Text>;
    case 'admitted_by':
      return (
        <Text style={styles.text} numberOfLines={1}>
          {nameOf(r.admitted_by) ?? '—'}
        </Text>
      );
    case 'stage':
      return r.stage ? (
        <View style={[styles.pill, { backgroundColor: (r.stage.color || '#64748B') + '22' }]}>
          <Text style={[styles.pillText, { color: r.stage.color || colors.text }]} numberOfLines={1}>
            {r.stage.name}
          </Text>
        </View>
      ) : (
        <Text style={styles.dim}>—</Text>
      );
    case 'rating': {
      const c = r.rating ? RATING[r.rating] : null;
      return c ? (
        <View style={[styles.pill, { backgroundColor: c + '22' }]}>
          <Text style={[styles.pillText, { color: c }]}>{r.rating!.toUpperCase()}</Text>
        </View>
      ) : (
        <Text style={styles.dim}>—</Text>
      );
    }
    case 'interest':
      return (
        <Text style={styles.text} numberOfLines={1}>
          {r.lead_courses
            .map((c) => c.course?.name)
            .filter(Boolean)
            .join(', ') || '—'}
        </Text>
      );
    case 'source':
      return (
        <Text style={styles.text} numberOfLines={1}>
          {r.source?.name ?? '—'}
        </Text>
      );
    case 'assignee':
      return (
        <Text style={[styles.text, !r.assignee && styles.dim]} numberOfLines={1}>
          {r.assignee?.full_name ?? 'Unassigned'}
        </Text>
      );
    case 'follow': {
      if (!r.next_follow_up_at) return <Text style={styles.dim}>—</Text>;
      const late = new Date(r.next_follow_up_at).getTime() < Date.now();
      return (
        <Text style={[styles.text, late && styles.bad]} numberOfLines={1}>
          {late ? '⚠ ' : ''}
          {when(r.next_follow_up_at)}
        </Text>
      );
    }
    case 'created':
      return <Text style={styles.text}>{day(r.created_at)}</Text>;
    case 'added_by':
      return (
        <Text style={styles.text} numberOfLines={1}>
          {nameOf(r.created_by) ?? '—'}
        </Text>
      );
  }
}

const RATING: Record<string, string> = { hot: '#E4572E', warm: '#D98E04', cold: '#64748B' };

/** 3 Nov, 4:30 pm (today: just the time) */
function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const t = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (d.toDateString() === today.toDateString()) return `Today ${t}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${t}`;
}

/** The approval dialog's view of a row */
function approvalLead(r: LeadListItem) {
  return {
    id: r.id,
    student_ref: r.student_ref,
    approval_status: r.approval_status,
    approval_by: null,
    approval_at: null,
    approval_note: null,
    nu_admission_id: r.nu_admission_id,
    papers_required: r.papers_required,
    papers_missing: r.papers_missing,
    fee_due: r.fee_due,
    fee_paid: r.fee_paid,
    admitted_course_id: r.admitted_course?.id ?? null,
    admitted_batch_id: r.admitted_batch?.id ?? null,
    admitted_section_id: r.admitted_section_id,
    registration_status: r.registration_status,
    registration_by: null,
    registration_at: null,
    registration_note: null,
  };
}

/** What to look at before approving (same as the student's approval card) */
function approvalChecks(r: LeadListItem): { ok: boolean; text: string }[] {
  return admissionChecks(r);
}

/** The same values as text, for the Excel file */
function cellText(col: ColKey, r: LeadListItem, nameOf: (id: string | null) => string | null): string | number | null {
  switch (col) {
    case 'ref':
      return r.student_ref;
    case 'name':
      return r.name;
    case 'phone':
      return r.phone ?? r.whatsapp_number ?? (r.whatsapp_username ? '@' + r.whatsapp_username : null);
    case 'course':
      return [r.admitted_course?.name, r.admitted_batch?.name].filter(Boolean).join(' · ');
    case 'fee':
      return r.fee_due == null ? null : Number(r.fee_due);
    case 'next_due':
      return r.fee_next_due ? day(r.fee_next_due) : null;
    case 'papers':
      return r.papers_required ? `${r.papers_missing ?? 0} missing of ${r.papers_required}` : null;
    case 'approval':
      return stageBadge(r.approval_status, r.registration_status, r.listed_at)?.text.replace(/^\S+\s/, '') ?? null;
    case 'section':
      return r.admitted_section?.name ?? null;
    case 'nu':
      return r.nu_admission_id;
    case 'last':
      return [r.last ? callLineText(r.last, nameOf) : null, r.last?.note_text].filter(Boolean).join(' | ');
    case 'admitted':
      return r.admitted_at ? day(r.admitted_at) : null;
    case 'admitted_by':
      return nameOf(r.admitted_by);
    case 'stage':
      return r.stage?.name ?? null;
    case 'rating':
      return r.rating;
    case 'interest':
      return r.lead_courses
        .map((c) => c.course?.name)
        .filter(Boolean)
        .join(', ');
    case 'source':
      return r.source?.name ?? null;
    case 'assignee':
      return r.assignee?.full_name ?? null;
    case 'follow':
      return r.next_follow_up_at ? when(r.next_follow_up_at) : null;
    case 'created':
      return day(r.created_at);
    case 'added_by':
      return nameOf(r.created_by);
  }
}

function colStyle(c: Col) {
  return c.flex ? { flex: c.flex, minWidth: FLEX_MIN } : { width: c.width };
}

function Box({ on }: { on: boolean }) {
  return <View style={[styles.box, on && styles.boxOn]}>{on && <Text style={styles.boxTick}>✓</Text>}</View>;
}

function ToolButton({
  label,
  onPress,
  on,
  a11y,
}: {
  label: string;
  onPress?: () => void;
  on?: boolean;
  a11y?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={(state) => [
        styles.tool,
        on && styles.toolOn,
        (state as { hovered?: boolean }).hovered && styles.toolHover,
      ]}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
    >
      <Text style={[styles.toolText, on && styles.toolTextOn]}>{label}</Text>
    </Pressable>
  );
}

function PanelHead({ id, onClose, title }: { id: string; onClose: () => void; title: string }) {
  return (
    <View style={styles.panelHead}>
      <Text style={styles.panelTitle}>{title}</Text>
      <View style={styles.flex} />
      <ToolButton label="✏️ Edit" onPress={() => router.push(`/leads/edit/${id}` as Href)} />
      <ToolButton label="↗ Full page" onPress={() => router.push(`/leads/${id}` as Href)} />
      <ToolButton label="✕" onPress={onClose} a11y="Close" />
    </View>
  );
}

function ColumnsDialog({
  all,
  defaults,
  value,
  onChange,
  onClose,
}: {
  all: Col[];
  defaults: ColKey[];
  value: ColKey[];
  onChange: (cols: ColKey[]) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.dialogBack} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.dialog} onPress={() => undefined}>
          <Text style={styles.dialogTitle}>▦ Columns</Text>
          <Text style={styles.muted}>Pick what the table shows. Remembered in this browser.</Text>
          <ScrollView style={styles.dialogList}>
            {all.map((c) => {
              const on = value.includes(c.key);
              const locked = c.key === 'name';
              return (
                <Pressable
                  key={c.key}
                  disabled={locked}
                  onPress={() =>
                    onChange(
                      on
                        ? value.filter((k) => k !== c.key)
                        : all.map((x) => x.key).filter((k) => k === c.key || value.includes(k)),
                    )
                  }
                  style={(state) => [styles.colRow, (state as { hovered?: boolean }).hovered && styles.rowHover]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: locked }}
                >
                  <Box on={on} />
                  <Text style={[styles.text, locked && styles.dim]}>{c.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.dialogButtons}>
            <Pressable onPress={() => onChange(defaults)} style={styles.btnGhost} accessibilityRole="button">
              <Text style={styles.btnGhostText}>Reset</Text>
            </Pressable>
            <Pressable onPress={onClose} style={styles.btn} accessibilityRole="button">
              <Text style={styles.btnText}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, flexDirection: 'row', minHeight: 0 },
  listSide: { flex: 1, minWidth: 0, paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.md },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  h1: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  count: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.primarySoft },
  countText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },

  tool: {
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  toolOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  toolHover: { borderColor: colors.primary },
  toolText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  toolTextOn: { color: colors.primary },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  seg: {
    flexDirection: 'row',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  segBtn: { height: 34, justifyContent: 'center', paddingHorizontal: spacing.md, backgroundColor: colors.surface },
  segOn: { backgroundColor: colors.primarySoft },
  segText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  segTextOn: { color: colors.primary },
  boardWrap: { marginBottom: spacing.md },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipHover: { borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  chipClear: { paddingVertical: 6, paddingHorizontal: spacing.sm },
  chipClearText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },

  bulk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: T.dark,
  },
  bulkText: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: '#fff' },
  bulkBtn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  bulkBtnText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: '#fff' },

  tableWrap: {
    flex: 1,
    minHeight: 0,
    marginBottom: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 42,
    backgroundColor: T.head,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headHover: { backgroundColor: T.headHover },
  headText: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  headTextOn: { color: colors.primary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderBottomWidth: 1,
    borderBottomColor: T.line,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  rowZebra: { backgroundColor: T.zebra },
  rowHover: { backgroundColor: T.hover },
  rowTicked: { backgroundColor: T.ticked },
  rowOpen: { backgroundColor: colors.primarySoft, borderLeftColor: colors.primary },
  rowDense: { minHeight: 36 },
  cellDense: { paddingVertical: 2 },
  withCopy: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  shrink: { flexShrink: 1 },
  copy: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 },
  copyHover: { backgroundColor: colors.primarySoft },
  copyText: { fontSize: 12 },
  cell: { paddingHorizontal: spacing.sm, paddingVertical: 6, justifyContent: 'center', alignSelf: 'stretch' },

  text: { fontSize: fontSize.small, color: colors.text },
  small: { fontSize: fontSize.caption, color: colors.text },
  smallMuted: { fontSize: fontSize.caption, color: colors.textMuted },
  mono: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  },
  dim: { fontSize: fontSize.small, color: T.dim },
  nameCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },
  cancelTag: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.danger },
  good: { color: colors.success },
  warn: { color: colors.warning },
  bad: { color: colors.danger },
  feeCell: { gap: 4 },
  menuCell: { alignItems: 'center' },
  listBtn: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.primary },
  listText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  menuDots: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.textMuted, lineHeight: 22 },
  hit: { marginHorizontal: -6, paddingHorizontal: 6, paddingVertical: 4, borderRadius: radius.sm },
  hitHover: { backgroundColor: 'rgba(53,87,212,0.08)' },
  editMark: { fontSize: 11 },
  approveRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  approveBtn: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.success },
  approveHover: { opacity: 0.85 },
  approveOff: { backgroundColor: colors.border },
  approveOffText: { color: colors.textMuted },
  needText: { marginTop: 2, fontSize: 11, color: colors.warning },
  approveText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: '#fff' },
  returnBtn: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  returnHover: { borderColor: colors.danger },
  returnText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.danger },
  bar: { height: 4, borderRadius: 2, backgroundColor: T.track, overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: colors.accent },
  barDone: { backgroundColor: colors.success },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  pillText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, backgroundColor: 'transparent' },
  pillWait: { backgroundColor: colors.warningSoft, color: colors.warning },
  pillGood: { backgroundColor: colors.successSoft, color: colors.success },
  pillBad: { backgroundColor: colors.dangerSoft, color: colors.danger },

  box: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: T.box,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  boxTick: { color: '#fff', fontSize: 12, fontWeight: fontWeight.bold, lineHeight: 14 },

  panel: { width: 560, borderLeftWidth: 1, borderLeftColor: colors.border, backgroundColor: colors.background },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  panelTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  drawerBack: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(16,26,51,0.35)' },
  drawer: { width: 560, maxWidth: '92%', backgroundColor: colors.background },

  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  more: { marginVertical: spacing.lg },
  bigIcon: { fontSize: 40 },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },

  btn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  btnGhost: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.sm },
  btnGhostText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textMuted },

  dialogBack: {
    flex: 1,
    backgroundColor: 'rgba(16,26,51,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '85%',
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  dialogTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  dialogList: { marginVertical: spacing.sm },
  colRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  dialogButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },

  toast: {
    position: 'absolute',
    bottom: spacing.xl,
    alignSelf: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: T.dark,
  },
  toastText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: '#fff' },
});
