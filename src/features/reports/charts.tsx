import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pct, type HeatCell, type PipelineStep } from '@/features/reports/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// Small charts for Reports (plain views, no chart library)
//   One hue for magnitude (the brand blue), numbers written next to the
//   marks, so nothing is told by colour alone.
// =====================================================================

const BAR = colors.primary;
const TRACK = colors.border;

// --- Stat tile ------------------------------------------------------------
export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}: ${value}${hint ? `, ${hint}` : ''}`}>
      <Text style={styles.tileValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
      {hint && (
        <Text style={styles.tileHint} numberOfLines={1}>
          {hint}
        </Text>
      )}
    </View>
  );
}

// --- Pipeline now ------------------------------------------------------------
/** Each lead once, in the stage it is in now (same numbers as the board) */
export function PipelineBars({
  steps,
  mode,
  compact = false,
  onPressStep,
}: {
  steps: PipelineStep[];
  mode: 'all' | 'period';
  /** Home card: thinner bars, open stages and Admitted only */
  compact?: boolean;
  onPressStep?: (step: PipelineStep) => void;
}) {
  const shown = compact ? steps.filter((s) => s.kind !== 'lost') : steps;
  const total = shown.reduce((sum, s) => sum + s[mode], 0);
  const max = Math.max(1, ...shown.map((s) => s[mode]));

  return (
    <View style={styles.funnel}>
      {shown.map((s) => {
        const n = s[mode];
        const icon = s.kind === 'won' ? '🎓 ' : s.kind === 'lost' ? '✕ ' : '';
        return (
          <Pressable
            key={s.stage_id}
            onPress={onPressStep && n > 0 ? () => onPressStep(s) : undefined}
            disabled={!onPressStep || n === 0}
            style={({ pressed }) => [styles.fRow, pressed && styles.pressed]}
            accessibilityRole={onPressStep ? 'button' : 'text'}
            accessibilityLabel={`${s.name}: ${n} leads now${onPressStep && n > 0 ? '. Open them' : ''}`}
          >
            <View style={styles.fTop}>
              <Text style={[styles.fName, compact && styles.fNameCompact]} numberOfLines={1}>
                {icon}
                {s.name}
              </Text>
              <Text style={styles.fCount}>{n}</Text>
              <Text style={styles.fPct}>{pct(n, total)}</Text>
            </View>
            <View style={[styles.track, compact && styles.trackCompact]}>
              <View
                style={[styles.bar, compact && styles.trackCompact, { width: `${Math.max((n / max) * 100, n > 0 ? 2 : 0)}%` }]}
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// --- Bar list (sources, lost reasons…) ----------------------------------------
export type BarRow = { key: string; name: string; value: number; right?: string };

export function BarList({ rows, empty }: { rows: BarRow[]; empty: string }) {
  if (rows.length === 0) return <Text style={styles.empty}>{empty}</Text>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <View style={styles.funnel}>
      {rows.map((r) => (
        <View key={r.key} style={styles.fRow} accessible accessibilityLabel={`${r.name}: ${r.value}${r.right ? `, ${r.right}` : ''}`}>
          <View style={styles.fTop}>
            <Text style={styles.fName} numberOfLines={1}>
              {r.name}
            </Text>
            <Text style={styles.fCount}>{r.value}</Text>
            {r.right !== undefined && <Text style={styles.fPct}>{r.right}</Text>}
          </View>
          <View style={[styles.track, styles.trackCompact]}>
            <View style={[styles.bar, styles.trackCompact, { width: `${Math.max((r.value / max) * 100, r.value > 0 ? 2 : 0)}%` }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

// --- Best time to call (day × hour) -------------------------------------------
const DAYS = [
  { dow: 6, label: 'Sat' },
  { dow: 0, label: 'Sun' },
  { dow: 1, label: 'Mon' },
  { dow: 2, label: 'Tue' },
  { dow: 3, label: 'Wed' },
  { dow: 4, label: 'Thu' },
  { dow: 5, label: 'Fri' },
];
const HOURS = Array.from({ length: 14 }, (_, i) => 8 + i); // 8 am – 9 pm

// Five steps of the same blue, light → dark (answer rate)
const STEPS = [0.14, 0.32, 0.5, 0.72, 1];
/** #3557D4 + 0.5 → rgba(53, 87, 212, 0.5) */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;

export function Heatmap({ cells }: { cells: HeatCell[] }) {
  const [picked, setPicked] = useState<HeatCell | null>(null);
  const map = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const total = cells.reduce((s, c) => s + c.attempts, 0);

  if (total === 0) return <Text style={styles.empty}>No calls from the app in this period.</Text>;

  // Best cell with at least 3 calls (so one lucky call doesn't win)
  const best = cells
    .filter((c) => c.attempts >= 3)
    .sort((a, b) => b.connected / b.attempts - a.connected / a.attempts)[0];

  return (
    <View style={styles.heat}>
      {best && (
        <Text style={styles.heatBest}>
          ⭐ Best: {DAYS.find((d) => d.dow === best.dow)?.label} {hourLabel(best.hour)}–{hourLabel(best.hour + 1)} ·{' '}
          {pct(best.connected, best.attempts)} answered
        </Text>
      )}

      <View style={styles.heatRow}>
        <View style={styles.heatDay} />
        {HOURS.map((h) => (
          <Text key={h} style={styles.heatHour}>
            {h % 2 === 0 ? hourLabel(h) : ''}
          </Text>
        ))}
      </View>

      {DAYS.map((d) => (
        <View key={d.dow} style={styles.heatRow}>
          <Text style={styles.heatDay}>{d.label}</Text>
          {HOURS.map((h) => {
            const c = map.get(`${d.dow}-${h}`);
            const rate = c && c.attempts > 0 ? c.connected / c.attempts : null;
            const step = rate === null ? null : STEPS[Math.min(4, Math.floor(rate * 5))];
            const on = picked?.dow === d.dow && picked?.hour === h;
            return (
              <Pressable
                key={h}
                onPress={() => setPicked(c ?? { dow: d.dow, hour: h, attempts: 0, connected: 0 })}
                style={[
                  styles.cell,
                  step === null ? styles.cellEmpty : { backgroundColor: withAlpha(BAR, step) },
                  on && styles.cellOn,
                ]}
                accessibilityLabel={`${d.label} ${hourLabel(h)}: ${c ? `${c.connected} of ${c.attempts} answered` : 'no calls'}`}
              />
            );
          })}
        </View>
      ))}

      <View style={styles.legend}>
        <Text style={styles.legendText}>Fewer answered</Text>
        {STEPS.map((o) => (
          <View key={o} style={[styles.legendBox, { backgroundColor: withAlpha(BAR, o) }]} />
        ))}
        <Text style={styles.legendText}>More</Text>
      </View>

      <Text style={styles.heatPicked}>
        {picked
          ? `${DAYS.find((d) => d.dow === picked.dow)?.label} ${hourLabel(picked.hour)}–${hourLabel(picked.hour + 1)}: ${
              picked.attempts > 0
                ? `${picked.connected} of ${picked.attempts} calls answered (${pct(picked.connected, picked.attempts)})`
                : 'no calls'
            }`
          : 'Tap a box to see the numbers.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.md },

  tile: {
    flexGrow: 1,
    flexBasis: '30%',
    minWidth: 96,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    gap: 2,
  },
  tileValue: { fontSize: 22, fontWeight: fontWeight.bold, color: colors.text },
  tileLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  tileHint: { fontSize: 11, color: colors.textMuted },

  funnel: { gap: spacing.md },
  fRow: { gap: 4 },
  fTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  fName: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  fNameCompact: { fontSize: fontSize.caption },
  fCount: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text, minWidth: 28, textAlign: 'right' },
  fPct: { fontSize: fontSize.caption, color: colors.textMuted, minWidth: 40, textAlign: 'right' },
  track: { height: 10, borderRadius: 4, backgroundColor: TRACK, overflow: 'hidden' },
  trackCompact: { height: 6 },
  bar: { height: 10, borderRadius: 4, backgroundColor: BAR },

  heat: { gap: 3 },
  heatBest: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm },
  heatRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  heatDay: { width: 30, fontSize: 11, color: colors.textMuted },
  heatHour: { flex: 1, fontSize: 9, color: colors.textMuted, textAlign: 'left' },
  cell: { flex: 1, aspectRatio: 1, borderRadius: 3 },
  cellEmpty: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  cellOn: { borderWidth: 2, borderColor: colors.text },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
  legendText: { fontSize: 11, color: colors.textMuted },
  legendBox: { width: 14, height: 14, borderRadius: 3 },
  heatPicked: { fontSize: fontSize.caption, color: colors.text, marginTop: spacing.xs },
});
