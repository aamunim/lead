import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  getAiChanceCounts,
  queueChanceGroup,
  stopChanceQueue,
  usd,
  type AiChanceCounts,
  type AiChanceSettings,
  type ChanceGroup,
} from '@/features/aiChance/api';
import { ask } from '@/features/aiChance/ask';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🔮 Settings → AI: when the AI looks at leads, how much it may spend,
//   and groups an admin can run by hand (with the count and the cost
//   first, and a warning before doing today's ones again).
// =====================================================================

const LIMITS = [50, 100, 300, 500, 1000];
const BUDGETS = [20, 50, 80, 150, 300];
const HOURS = [6, 7, 8, 9, 10, 12, 14, 17, 20];
const OLDER = [7, 15, 30];
const POLL_MS = 15_000;

const hourLabel = (h: number) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);

export function ChanceControls({
  cs,
  patch,
  keySet,
  onNote,
}: {
  cs: AiChanceSettings;
  patch: (p: Partial<AiChanceSettings>) => void;
  keySet: boolean;
  onNote: (n: { ok: boolean; text: string }) => void;
}) {
  const [counts, setCounts] = useState<AiChanceCounts | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [customLimit, setCustomLimit] = useState(
    LIMITS.includes(cs.daily_auto_limit) ? '' : String(cs.daily_auto_limit),
  );
  const [customBudget, setCustomBudget] = useState(
    cs.monthly_budget === 0 || BUDGETS.includes(cs.monthly_budget) ? '' : String(cs.monthly_budget),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const olderDays = cs.daily_run.older_days || 15;

  const load = useCallback(() => {
    getAiChanceCounts(olderDays)
      .then((c) => {
        setCounts(c);
        // something is running: keep the numbers fresh while this screen is open
        if (timer.current) clearTimeout(timer.current);
        if (c.waiting_now + c.working > 0) timer.current = setTimeout(load, POLL_MS);
      })
      .catch(() => undefined);
  }, [olderDays]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const run = (kind: ChanceGroup, opts: { onlyChanged?: boolean; now: boolean }) => {
    setBusy(kind);
    queueChanceGroup(kind, { olderDays, onlyChanged: opts.onlyChanged ?? true, now: opts.now })
      .then((n) =>
        onNote({
          ok: true,
          text:
            n === 0
              ? 'Nothing to add: these are already looked at or waiting.'
              : opts.now
                ? `${n} leads are in the queue. The server works through them (about 5 a minute); you can close this screen.`
                : `${n} leads are in the queue: up to ${cs.daily_auto_limit} a day are looked at, the rest on the next days.`,
        }),
      )
      .catch((e) => onNote({ ok: false, text: e instanceof Error ? e.message : 'Could not start.' }))
      .finally(() => {
        setBusy(null);
        load();
      });
  };

  const cost = (n: number) => usd(n * (counts?.avg_cost ?? 0.03));

  // a group: how many, the cost, then "now" or "within the daily limit"
  const askGroup = (kind: ChanceGroup, n: number, label: string) => {
    if (n === 0) return onNote({ ok: true, text: 'Nothing in this group right now.' });
    if (kind === 'today') {
      const changed = counts?.today_changed ?? 0;
      return ask(
        '⚠️ Looked at today already',
        `${n} leads were looked at today. ${n - changed} of them have nothing new since, so the answer would be about the same.\n\nOnly the ${changed} with a new call or note: about ${cost(changed)}.\nAll ${n}: about ${cost(n)}.`,
        [
          ...(changed > 0
            ? [
                {
                  label: `Only the ${changed} with something new`,
                  run: () => run('today', { onlyChanged: true, now: true }),
                },
              ]
            : []),
          { label: `All ${n} again`, run: () => run('today', { onlyChanged: false, now: true }), danger: true },
        ],
      );
    }
    ask(
      label,
      `${n} leads · about ${cost(n)}.\n\nNow: all of them at once (about ${Math.ceil(n / 5)} minutes).\nWithin the daily limit: up to ${cs.daily_auto_limit} a day.`,
      [
        { label: `Now (${cost(n)})`, run: () => run(kind, { now: true }) },
        { label: 'Within the daily limit', run: () => run(kind, { now: false }) },
      ],
    );
  };

  const stop = () =>
    ask('Stop?', 'Leads waiting in the queue leave it. Answers already given stay.', [
      {
        label: 'Stop',
        danger: true,
        run: () => {
          setBusy('stop');
          stopChanceQueue()
            .then((n) => onNote({ ok: true, text: `Stopped: ${n} leads left the queue.` }))
            .catch((e) => onNote({ ok: false, text: e instanceof Error ? e.message : 'Could not stop.' }))
            .finally(() => {
              setBusy(null);
              load();
            });
        },
      },
    ]);

  const dr = cs.daily_run;
  const setRun = (p: Partial<AiChanceSettings['daily_run']>) => patch({ daily_run: { ...dr, ...p } });
  const waiting = (counts?.waiting_now ?? 0) + (counts?.working ?? 0);
  const budget = cs.monthly_budget;
  const spent = counts?.spent_month ?? 0;
  const disabled = !!busy || !keySet || !cs.enabled;

  return (
    <>
      {/* ⏰ every day */}
      <Text style={styles.sectionLabel}>⏰ EVERY DAY BY ITSELF</Text>
      <View style={styles.card}>
        <Row
          title="Daily run"
          text={
            dr.on
              ? `On: every day at ${hourLabel(dr.hour)} the AI looks at the leads below again.`
              : 'Off: nothing at a set time (calls / notes and “Check” still work).'
          }
          value={dr.on}
          onChange={(v) => setRun({ on: v })}
        />
        {dr.on && (
          <>
            <Text style={styles.small}>At</Text>
            <View style={styles.chips}>
              {HOURS.map((h) => (
                <Chip key={h} label={hourLabel(h)} on={dr.hour === h} onPress={() => setRun({ hour: h })} />
              ))}
            </View>
            <Text style={styles.small}>Which leads</Text>
            <Check
              on={dr.changed}
              label="New call or note since the last look"
              onPress={() => setRun({ changed: !dr.changed })}
            />
            <Check on={dr.never} label="Never looked at yet" onPress={() => setRun({ never: !dr.never })} />
            <Check
              on={dr.older}
              label={`The last look is older than ${dr.older_days} days`}
              onPress={() => setRun({ older: !dr.older })}
            />
            {dr.older && (
              <View style={styles.chips}>
                {OLDER.map((d) => (
                  <Chip
                    key={d}
                    label={`${d} days`}
                    on={dr.older_days === d}
                    onPress={() => setRun({ older_days: d })}
                  />
                ))}
              </View>
            )}
            {!!counts?.last_daily_run && <Text style={styles.hint}>Last run: {counts.last_daily_run}</Text>}
          </>
        )}
        <View style={styles.divider} />
        <Row
          title="Right after a call / note"
          text={
            cs.auto
              ? 'On: a new call or note → looked at again in a few minutes (once a day per lead; a second one waits for the daily run’s hour).'
              : 'Off: only the daily run and “Check”.'
          }
          value={cs.auto}
          onChange={(v) => patch({ auto: v })}
        />
      </View>

      {/* 🔢 how many, 💵 how much */}
      <Text style={styles.sectionLabel}>🔢 THE MOST A DAY BY ITSELF</Text>
      <View style={styles.card}>
        <View style={styles.chips}>
          {LIMITS.map((n) => (
            <Chip
              key={n}
              label={`${n} · ~${usd(n * (counts?.avg_cost ?? 0.03))}/day`}
              on={cs.daily_auto_limit === n && !customLimit}
              onPress={() => {
                setCustomLimit('');
                patch({ daily_auto_limit: n });
              }}
            />
          ))}
        </View>
        <View style={styles.inline}>
          <Text style={styles.small}>Or a number:</Text>
          <TextInput
            value={customLimit}
            onChangeText={(t) => {
              const v = t.replace(/\D/g, '').slice(0, 4);
              setCustomLimit(v);
              if (v) patch({ daily_auto_limit: Math.max(1, Math.min(5000, Number(v))) });
            }}
            keyboardType="number-pad"
            placeholder="e.g. 200"
            placeholderTextColor={colors.textMuted}
            style={styles.numInput}
          />
        </View>
        <Text style={styles.hint}>
          Counts the daily run and the right-after ones. “Check” on a lead and groups run “now” are not counted.
          {counts ? ` Today: ${counts.auto_today} of ${cs.daily_auto_limit}.` : ''}
        </Text>
      </View>

      <Text style={styles.sectionLabel}>💵 MONTHLY BUDGET (ALL AI)</Text>
      <View style={styles.card}>
        <View style={styles.chips}>
          {BUDGETS.map((n) => (
            <Chip
              key={n}
              label={`$${n}`}
              on={budget === n && !customBudget}
              onPress={() => {
                setCustomBudget('');
                patch({ monthly_budget: n });
              }}
            />
          ))}
          <Chip
            label="No limit"
            on={budget === 0}
            onPress={() => {
              setCustomBudget('');
              patch({ monthly_budget: 0 });
            }}
          />
        </View>
        <View style={styles.inline}>
          <Text style={styles.small}>Or $:</Text>
          <TextInput
            value={customBudget}
            onChangeText={(t) => {
              const v = t.replace(/\D/g, '').slice(0, 5);
              setCustomBudget(v);
              if (v) patch({ monthly_budget: Number(v) });
            }}
            keyboardType="number-pad"
            placeholder="e.g. 60"
            placeholderTextColor={colors.textMuted}
            style={styles.numInput}
          />
        </View>
        {counts && (
          <>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${budget > 0 ? Math.min(100, (spent / budget) * 100) : 0}%`,
                    backgroundColor: counts.budget_ok ? colors.primary : colors.danger,
                  },
                ]}
              />
            </View>
            <Text style={[styles.hint, !counts.budget_ok && styles.bad]}>
              This month: {usd(spent)}
              {budget > 0 ? ` of $${budget}` : ''}
              {!counts.budget_ok
                ? ' — reached: Claude waits until next month (or a bigger budget); Gemini (free), if it is on for a feature, goes on. “Check” on a lead still works.'
                : ''}
            </Text>
          </>
        )}
        <Text style={styles.hint}>Both AI features count (chance and admission credit).</Text>
      </View>

      {/* 👤 groups by hand */}
      <Text style={styles.sectionLabel}>▶️ RUN A GROUP NOW</Text>
      <View style={styles.card}>
        {!counts ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <>
            <Group
              icon="🆕"
              label="Never looked at"
              n={counts.never}
              cost={cost(counts.never)}
              disabled={disabled}
              loading={busy === 'never'}
              onPress={() => askGroup('never', counts.never, '🆕 Never looked at')}
            />
            <Group
              icon="📞"
              label="New call / note since the last look"
              n={counts.changed}
              cost={cost(counts.changed)}
              disabled={disabled}
              loading={busy === 'changed'}
              onPress={() => askGroup('changed', counts.changed, '📞 New call / note since the last look')}
            />
            <Group
              icon="🕰"
              label={`Older than ${olderDays} days`}
              n={counts.older}
              cost={cost(counts.older)}
              disabled={disabled}
              loading={busy === 'older'}
              onPress={() => askGroup('older', counts.older, `🕰 Older than ${olderDays} days`)}
            />
            <Group
              icon="⚠️"
              label="Looked at today (again)"
              n={counts.today}
              cost={cost(counts.today)}
              disabled={disabled}
              loading={busy === 'today'}
              onPress={() => askGroup('today', counts.today, '')}
            />
            <View style={styles.divider} />
            <Text style={styles.hint}>
              Open leads: {counts.open} · looked at today: {counts.done_today}
              {counts.waiting_later > 0 ? ` · waiting for later: ${counts.waiting_later}` : ''}
            </Text>
            {waiting > 0 && (
              <View style={styles.progress}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.progressText}>
                  Working: {waiting} waiting · about {Math.max(1, Math.ceil(waiting / 5))} min
                </Text>
                <Pressable onPress={stop} disabled={!!busy} accessibilityRole="button" style={styles.stopBtn}>
                  <Text style={styles.stopText}>⏹ Stop</Text>
                </Pressable>
              </View>
            )}
          </>
        )}
      </View>
    </>
  );
}

function Group(props: {
  icon: string;
  label: string;
  n: number;
  cost: string;
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled || props.n === 0}
      style={({ pressed }) => [
        styles.group,
        (props.disabled || props.n === 0) && styles.dim,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
    >
      <Text style={styles.groupIcon}>{props.icon}</Text>
      <View style={styles.flex}>
        <Text style={styles.groupLabel}>{props.label}</Text>
        <Text style={styles.groupSub}>
          {props.n} leads{props.n > 0 ? ` · about ${props.cost}` : ''}
        </Text>
      </View>
      {props.loading ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.go}>Run ›</Text>}
    </Pressable>
  );
}

function Row({
  title,
  text,
  value,
  onChange,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function Check({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <Text style={[styles.box, on && styles.boxOn]}>{on ? '✓' : ''}</Text>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginLeft: spacing.xs,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  small: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, marginTop: spacing.xs },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  bad: { color: colors.danger },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  numInput: {
    width: 100,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.body,
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    textAlign: 'center',
    lineHeight: 19,
    fontSize: 14,
    fontWeight: fontWeight.bold,
    color: colors.textOnPrimary,
    overflow: 'hidden',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkLabel: { flex: 1, fontSize: fontSize.small, color: colors.text },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.background, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  dim: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  groupIcon: { fontSize: 20 },
  groupLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  groupSub: { fontSize: fontSize.caption, color: colors.textMuted },
  go: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  progressText: { flex: 1, fontSize: fontSize.small, color: colors.text },
  stopBtn: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  stopText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.danger },
});
