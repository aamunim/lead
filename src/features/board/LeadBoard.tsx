import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type FlatListProps,
} from 'react-native';

import { listLeads, type LeadListItem, type LeadQuery } from '@/features/leads/api';
import { LeadCard } from '@/features/leads/LeadCard';
import { listPipelineStages, type PipelineStage } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📋 Pipeline board: one column per stage, the same lead cards as the list
//   Uses the same search / quick chip / filters / sort as the list, and the
//   same card: tap opens, long press marks (the list's bar then moves,
//   tags, assigns… the marked leads), last call / note, 👁 peek.
//   Columns load when they come into view (and the next one), a page at a time.
// =====================================================================

const GAP = spacing.md;
const CARD_GAP = spacing.sm;

type Column = {
  items: LeadListItem[];
  total: number | null;
  page: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
};

const EMPTY: Column = { items: [], total: null, page: 0, hasMore: true, loading: false, loaded: false };

type Props = {
  /** Search, quick chip, filters and sort (the stage comes from each column) */
  query: Omit<LeadQuery, 'stageId'>;
  /** Settings → Pipeline board: Admitted and Lost columns at the end */
  closedColumns: boolean;
  showAssignee: boolean;
  /** Changes when the screen comes back into view or is pulled to refresh */
  reloadKey: number;
  onCall: (lead: LeadListItem) => void;
  onWhatsApp: (lead: LeadListItem) => void;
  onSms: (lead: LeadListItem) => void;
  /** Long press on WhatsApp / SMS: pick a message template */
  onTemplate?: (lead: LeadListItem, channel: 'whatsapp' | 'sms') => void;
  /** Something went wrong: show a short message */
  onChanged: (message: string) => void;
  // --- the list's card, the same here ---
  search: string;
  detailed: boolean;
  staleDays: number;
  nameOf: (id: string | null) => string | null;
  onPeek: (lead: LeadListItem) => void;
  onPlayVoice: (lead: LeadListItem, fileId: string, seconds: number | null) => void;
  /** Marked leads (long press), shared with the list's bar */
  selected: Set<string>;
  onToggle: (lead: LeadListItem) => void;
};

export function LeadBoard({
  query,
  closedColumns,
  showAssignee,
  reloadKey,
  onCall,
  onWhatsApp,
  onSms,
  onTemplate,
  onChanged,
  search,
  detailed,
  staleDays,
  nameOf,
  onPeek,
  onPlayVoice,
  selected,
  onToggle,
}: Props) {
  const { width } = useWindowDimensions();
  const colWidth = Math.min(320, Math.round(width - spacing.lg * 2 - 36)); // the next column peeks in

  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const [cols, setCols] = useState<Record<string, Column>>({});
  const [height, setHeight] = useState(0);
  const selecting = selected.size > 0;

  useEffect(() => {
    listPipelineStages()
      .then(setStages)
      .catch((e) => setStagesError(e instanceof Error ? e.message : 'Could not load the stages.'));
  }, []);

  // Columns: open stages, then Admitted / Lost (setting). "Closed" chip → only closed columns.
  const columns = useMemo(() => {
    const open = stages.filter((s) => s.kind === 'open');
    const closed = stages.filter((s) => s.kind === 'won' || s.kind === 'lost' || s.kind === 'cancelled');
    if (query.quick === 'closed') return closed;
    return closedColumns ? [...open, ...closed.filter((s) => s.kind !== 'cancelled')] : open;
  }, [stages, closedColumns, query.quick]);

  // --- loading ----------------------------------------------------------
  const queryKey = `${JSON.stringify(query)}|${reloadKey}`;
  const keyRef = useRef(queryKey);
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const queryRef = useRef(query);
  queryRef.current = query;
  // The parent may pass a new function each render: keep loading stable
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const loadColumn = useCallback(async (stageId: string, page: number) => {
    const key = keyRef.current;
    setCols((c) => ({ ...c, [stageId]: { ...(c[stageId] ?? EMPTY), loading: true } }));
    try {
      const r = await listLeads({ ...queryRef.current, stageId, page });
      if (keyRef.current !== key) return; // filters changed meanwhile
      setCols((c) => {
        const now = c[stageId] ?? EMPTY;
        return {
          ...c,
          [stageId]: {
            items: page === 0 ? r.items : [...now.items, ...r.items],
            total: page === 0 ? r.total : now.total,
            page,
            hasMore: r.hasMore,
            loading: false,
            loaded: true,
          },
        };
      });
    } catch (e) {
      if (keyRef.current !== key) return;
      setCols((c) => ({ ...c, [stageId]: { ...(c[stageId] ?? EMPTY), loading: false, loaded: true, hasMore: false } }));
      onChangedRef.current(e instanceof Error ? e.message : 'Could not load the leads.');
    }
  }, []);

  const ensureLoaded = useCallback(
    (stageId: string | undefined) => {
      if (!stageId) return;
      const c = colsRef.current[stageId];
      if (c?.loaded || c?.loading) return;
      loadColumn(stageId, 0);
    },
    [loadColumn],
  );

  // Visible columns (and the next one) load first
  const visibleRef = useRef<number[]>([0]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const loadVisible = useCallback(() => {
    const idx = visibleRef.current.length > 0 ? visibleRef.current : [0];
    const want = new Set<number>();
    idx.forEach((i) => {
      want.add(i);
      want.add(i + 1);
    });
    want.forEach((i) => ensureLoaded(columnsRef.current[i]?.id));
  }, [ensureLoaded]);

  // Search / filters / sort changed, or a reload: start again
  useEffect(() => {
    keyRef.current = queryKey;
    setCols({});
    colsRef.current = {};
    loadVisible();
  }, [queryKey, columns, loadVisible]);

  const loadVisibleRef = useRef(loadVisible);
  loadVisibleRef.current = loadVisible;
  const onViewable = useRef<NonNullable<FlatListProps<PipelineStage>['onViewableItemsChanged']>>(({ viewableItems }) => {
    visibleRef.current = viewableItems.map((v) => v.index ?? 0);
    loadVisibleRef.current();
  }).current;

  const refreshColumn = (stageId: string) => {
    if (colsRef.current[stageId]?.loaded) loadColumn(stageId, 0);
  };

  // --- render -------------------------------------------------------------
  if (stagesError) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{stagesError}</Text>
      </View>
    );
  }
  if (stages.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.board} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {height > 0 && (
        <FlatList
          horizontal
          data={columns}
          keyExtractor={(s) => s.id}
          showsHorizontalScrollIndicator={false}
          snapToInterval={colWidth + GAP}
          decelerationRate="fast"
          contentContainerStyle={styles.columns}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 30 }}
          initialNumToRender={2}
          windowSize={3}
          getItemLayout={(_, index) => ({ length: colWidth + GAP, offset: (colWidth + GAP) * index, index })}
          renderItem={({ item: stage }) => {
            const col = cols[stage.id] ?? EMPTY;
            return (
              <View style={[styles.column, { width: colWidth, height: height - spacing.md }]}>
                <View style={styles.colHeader}>
                  <View style={[styles.dot, { backgroundColor: stage.color }]} />
                  <Text style={styles.colTitle} numberOfLines={1}>
                    {stage.name}
                    {stage.askDate ? ' 📅' : ''}
                  </Text>
                  <Text style={[styles.colCount, { color: stage.color }]}>{col.total ?? '…'}</Text>
                </View>
                <FlatList
                  data={col.items}
                  keyExtractor={(l) => l.id}
                  extraData={selected}
                  contentContainerStyle={styles.cards}
                  ItemSeparatorComponent={CardGap}
                  onEndReached={() => {
                    if (col.loaded && col.hasMore && !col.loading) loadColumn(stage.id, col.page + 1);
                  }}
                  onEndReachedThreshold={0.5}
                  renderItem={({ item: lead }) => (
                    <LeadCard
                      lead={lead}
                      search={search}
                      detailed={detailed}
                      staleDays={staleDays}
                      nameOf={nameOf}
                      onPeek={() => onPeek(lead)}
                      onPlayVoice={(fileId, seconds) => onPlayVoice(lead, fileId, seconds)}
                      showAssignee={showAssignee}
                      selecting={selecting}
                      selected={selected.has(lead.id)}
                      onPress={() => (selecting ? onToggle(lead) : router.push(`/leads/${lead.id}` as Href))}
                      onLongPress={() => onToggle(lead)}
                      onCall={() => onCall(lead)}
                      onWhatsApp={() => onWhatsApp(lead)}
                      onSms={() => onSms(lead)}
                      onTemplate={onTemplate && ((ch) => onTemplate(lead, ch))}
                    />
                  )}
                  ListEmptyComponent={
                    col.loading || !col.loaded ? (
                      <ActivityIndicator color={stage.color} style={styles.colLoader} />
                    ) : (
                      <Text style={styles.empty}>No leads here</Text>
                    )
                  }
                  ListFooterComponent={
                    col.loading && col.items.length > 0 ? (
                      <ActivityIndicator color={stage.color} style={styles.colLoader} />
                    ) : undefined
                  }
                />
              </View>
            );
          }}
        />
      )}

    </View>
  );
}

function CardGap() {
  return <View style={{ height: CARD_GAP }} />;
}

const styles = StyleSheet.create({
  board: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  columns: { paddingHorizontal: spacing.lg, gap: GAP, paddingBottom: spacing.md },
  column: {
    borderRadius: radius.lg,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  colHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  colTitle: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  colCount: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  cards: { padding: spacing.sm, paddingBottom: 96 },
  colLoader: { paddingVertical: spacing.xl },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.xl },
});
