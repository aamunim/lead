import { useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐 A simple wide table for the website (Team activity, Change log):
//   sticky-looking header, click a heading to sort, zebra rows, hover,
//   a click on a row. Columns say how to show a value and how to sort it.
// =====================================================================

export type WebCol<T> = {
  key: string;
  label: string;
  width?: number;
  flex?: number;
  align?: 'left' | 'right';
  /** what the cell shows */
  render: (row: T) => ReactNode;
  /** a number or text to sort by (no sorting when missing) */
  sortValue?: (row: T) => number | string | null;
  /** text for Excel */
  text?: (row: T) => string | number | null;
};

const T = isDark
  ? { head: '#1B2439', zebra: '#141C2E', hover: '#1D2740', line: '#222B42' }
  : { head: '#F1F4FA', zebra: '#FBFCFE', hover: '#F2F5FC', line: '#EEF1F6' };

export function WebTable<T>({
  cols,
  rows,
  rowKey,
  loading,
  empty,
  onRow,
  activeKey,
  initialSort,
  footer,
}: {
  cols: WebCol<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: string;
  onRow?: (row: T) => void;
  activeKey?: string | null;
  initialSort?: { key: string; desc: boolean };
  footer?: ReactNode;
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const v = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -r : r;
    });
  }, [rows, sort, cols]);

  const minW = cols.reduce((n, c) => n + (c.width ?? 160), 0);
  const cell = (c: WebCol<T>) => [
    styles.cell,
    c.flex ? { flex: c.flex, minWidth: 140 } : { width: c.width ?? 120 },
    c.align === 'right' && styles.right,
  ];

  return (
    <View style={styles.wrap}>
      <ScrollView horizontal contentContainerStyle={{ minWidth: '100%', flexDirection: 'column' }}>
        <View style={{ minWidth: minW, flex: 1 }}>
          <View style={styles.head}>
            {cols.map((c) => {
              const on = sort?.key === c.key;
              return (
                <Pressable
                  key={c.key}
                  disabled={!c.sortValue}
                  onPress={() =>
                    setSort(on ? { key: c.key, desc: !sort!.desc } : { key: c.key, desc: c.align === 'right' })
                  }
                  style={cell(c)}
                  accessibilityRole={c.sortValue ? 'button' : undefined}
                >
                  <Text style={[styles.headText, on && styles.headOn]} numberOfLines={1}>
                    {c.label}
                    {on ? (sort!.desc ? ' ▼' : ' ▲') : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : sorted.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.muted}>{empty ?? 'Nothing here.'}</Text>
            </View>
          ) : (
            sorted.map((r, i) => (
              <Pressable
                key={rowKey(r)}
                onPress={onRow ? () => onRow(r) : undefined}
                disabled={!onRow}
                style={(st) => [
                  styles.row,
                  i % 2 === 1 && { backgroundColor: T.zebra },
                  (st as { hovered?: boolean }).hovered && onRow && { backgroundColor: T.hover },
                  activeKey === rowKey(r) && styles.active,
                ]}
              >
                {cols.map((c) => (
                  <View key={c.key} style={cell(c)}>
                    {c.render(r)}
                  </View>
                ))}
              </Pressable>
            ))
          )}
          {footer}
        </View>
      </ScrollView>
    </View>
  );
}

/** A plain cell text */
export function CellText({
  children,
  tone,
  bold,
  small,
}: {
  children: ReactNode;
  tone?: 'good' | 'bad' | 'muted';
  bold?: boolean;
  small?: boolean;
}) {
  return (
    <Text
      numberOfLines={1}
      style={[
        styles.text,
        small && styles.small,
        bold && styles.bold,
        tone === 'good' && { color: colors.success },
        tone === 'bad' && { color: colors.danger },
        tone === 'muted' && { color: colors.textMuted },
      ]}
    >
      {children}
    </Text>
  );
}

/** Period chips etc. */
export function Chips<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          style={(st) => [
            styles.chip,
            value === o.value && styles.chipOn,
            value !== o.value && (st as { hovered?: boolean }).hovered && styles.chipHover,
          ]}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === o.value }}
        >
          <Text style={[styles.chipText, value === o.value && styles.chipTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Tool({ label, onPress, on }: { label: string; onPress?: () => void; on?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={(st) => [styles.tool, on && styles.toolOn, (st as { hovered?: boolean }).hovered && styles.toolHover]}
      accessibilityRole="button"
    >
      <Text style={[styles.toolText, on && styles.toolTextOn]}>{label}</Text>
    </Pressable>
  );
}

export const webPage = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.md, minHeight: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  h1: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
});

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 0,
    marginBottom: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', backgroundColor: T.head, borderBottomWidth: 1, borderBottomColor: colors.border },
  headText: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  headOn: { color: colors.primary },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: T.line, minHeight: 46 },
  active: { backgroundColor: colors.primarySoft },
  cell: { paddingVertical: 9, paddingHorizontal: spacing.md, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  text: { fontSize: fontSize.small, color: colors.text },
  small: { fontSize: fontSize.caption },
  bold: { fontWeight: fontWeight.bold },
  center: { padding: spacing.xxl, alignItems: 'center' },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
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
});
