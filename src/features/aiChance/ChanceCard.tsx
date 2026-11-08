import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  chanceTone,
  getLeadChance,
  OBJECTION_LABEL,
  requestLeadChance,
  type ChanceLevel,
  type LeadChance,
} from '@/features/aiChance/api';
import { ask } from '@/features/aiChance/ask';
import { PROVIDER_LABEL, type AiProvider } from '@/features/aiProviders/api';
import { scheduleFollowUp } from '@/features/follow-ups/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🔮 Lead page: the AI's chance of admission, why, the doubts it heard,
//   what to do next and what to say. Open leads; one small request, kept
//   for a minute. "Check now" asks the AI again (it answers in about
//   half a minute; the card waits by itself).
//   Claude and Gemini: the tag says which AI answered; when both have
//   answered, tabs show each one's answer (neither is ever deleted).
// =====================================================================

const POLL_MS = 8_000;
const POLLS = 12;

const ago = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'এইমাত্র';
  if (min < 60) return `${min} মিনিট আগে`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ঘণ্টা আগে`;
  return `${Math.round(h / 24)} দিন আগে`;
};

function levelColor(level: ChanceLevel | null) {
  return level === 'hot' ? colors.success : level === 'warm' ? colors.warning : colors.textMuted;
}

export const ChanceCard = memo(function ChanceCard({
  leadId,
  stateKey,
  onChanged,
}: {
  leadId: string;
  /** changes after a call / note (looks again for a fresh answer) */
  stateKey: string;
  onChanged?: (message?: string) => void;
}) {
  const [c, setC] = useState<LeadChance | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  /** which AI's answer is shown (null: the latest one, the one lists use) */
  const [view, setView] = useState<AiProvider | null>(null);
  const polls = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  const load = (force: boolean) =>
    getLeadChance(leadId, force)
      .then((d) => {
        if (!alive.current) return;
        setC(d);
        // asked by a person and not ready yet: look again shortly
        const waiting =
          d && (d.status === 'working' || (d.status === 'pending' && !!d.due_at && new Date(d.due_at) <= new Date()));
        if (waiting && polls.current < POLLS) {
          polls.current += 1;
          timer.current = setTimeout(() => load(true), POLL_MS);
        }
      })
      .catch((e) => {
        if (!alive.current) return;
        // show what went wrong (an empty card helps nobody)
        setLoadError(e instanceof Error ? e.message : 'Could not load.');
        setC(null);
      });

  useEffect(() => {
    alive.current = true;
    polls.current = 0;
    load(false);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, stateKey]);

  if (loadError && !c)
    return (
      <View style={styles.card}>
        <Text style={styles.title}>🔮 ভর্তির সম্ভাবনা</Text>
        <Text style={styles.bad}>AI-এর তথ্য আনা যায়নি: {loadError}</Text>
        <Pressable
          onPress={() => {
            setLoadError(null);
            setC(undefined);
            load(true);
          }}
          accessibilityRole="button"
          style={styles.checkBtn}
        >
          <Text style={styles.checkText}>🔄 আবার চেষ্টা করুন</Text>
        </Pressable>
      </View>
    );
  if (!c) return null; // not allowed / not loaded yet: nothing (no spinner on the page)

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestLeadChance(leadId);
      polls.current = 0;
      setC({ ...c, status: 'pending', due_at: new Date().toISOString(), manual: true });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => load(true), POLL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start.');
    } finally {
      setBusy(false);
    }
  };

  // ⚠️ looked at today and nothing new since: the answer would be about the same
  const checkOrWarn = () => {
    if (!c.fresh_today) return check();
    ask(
      '⚠️ আজই দেখা হয়েছে',
      'এই লিড আজই AI দেখেছে, এরপর নতুন কোনো কল বা নোট হয়নি। আবার দেখলে উত্তর প্রায় একই হবে, কিন্তু খরচ হবে। তবু দেখবেন?',
      [{ label: 'আবার দেখুন', run: check }],
    );
  };

  // 🗂 the other AI's answer, when one is picked in the tabs
  const other = view && view !== c.provider ? (c.answers.find((x) => x.provider === view) ?? null) : null;
  const a = other ?? c;
  const shownBy: AiProvider | null = other ? other.provider : c.provider;
  const tabs = c.answers.length > 1 ? c.answers.map((x) => x.provider) : [];

  const setNextCall = async () => {
    if (a.next_call_days == null) return;
    const d = new Date();
    d.setDate(d.getDate() + a.next_call_days);
    d.setHours(a.next_call_days === 0 ? Math.min(d.getHours() + 2, 20) : 11, 0, 0, 0);
    setBusy(true);
    setError(null);
    try {
      await scheduleFollowUp(leadId, d, a.next_call_why ? `🔮 ${a.next_call_why}` : null);
      onChanged?.('Next call set');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set the next call.');
    } finally {
      setBusy(false);
    }
  };

  const waiting = c.status === 'working' || (c.status === 'pending' && !!c.due_at && new Date(c.due_at) <= new Date());
  const has = a.chance != null;
  const tone = chanceTone(a.level);
  const color = levelColor(a.level);
  const trend = has && !other && c.prev_chance != null ? a.chance! - c.prev_chance : 0;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>🔮 ভর্তির সম্ভাবনা</Text>
        <Text style={styles.aiTag}>{shownBy ? `AI · ${PROVIDER_LABEL[shownBy]}` : 'AI'}</Text>
      </View>

      {tabs.length > 1 && (
        <View style={styles.tabs} accessibilityRole="tablist">
          {tabs.map((p) => {
            const on = p === (shownBy ?? c.provider);
            const x = c.answers.find((y) => y.provider === p);
            return (
              <Pressable
                key={p}
                onPress={() => setView(p === c.provider ? null : p)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[styles.tab, on && styles.tabOn]}
              >
                <Text style={[styles.tabText, on && styles.tabTextOn]}>
                  {PROVIDER_LABEL[p]}
                  {x?.chance != null ? ` ${x.chance}%` : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {has ? (
        <>
          <View style={styles.scoreRow}>
            <Text style={[styles.big, { color }]}>{a.chance}%</Text>
            <View style={styles.flex}>
              <Text style={[styles.level, { color }]}>
                {tone.icon} {tone.label}
                {trend !== 0 && (
                  <Text style={trend > 0 ? styles.up : styles.down}>
                    {'  '}
                    {trend > 0 ? '▲' : '▼'} {Math.abs(trend)}
                  </Text>
                )}
              </Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(3, a.chance!)}%`, backgroundColor: color }]} />
              </View>
            </View>
          </View>
          {!!a.summary && <Text style={styles.summary}>{a.summary}</Text>}

          {a.objections.length > 0 && (
            <View style={styles.chips}>
              {a.objections.map((o, i) => (
                <View key={i} style={styles.chip}>
                  <Text style={styles.chipText}>{OBJECTION_LABEL[o.kind] ?? o.kind}</Text>
                </View>
              ))}
            </View>
          )}

          {a.actions.length > 0 && (
            <View style={styles.block}>
              <Text style={styles.label}>👉 এখন যা করবেন</Text>
              {a.actions.map((act, i) => (
                <View key={i} style={styles.action}>
                  <Text style={styles.num}>{i + 1}</Text>
                  <View style={styles.flex}>
                    <Text style={styles.actionText}>{act.text}</Text>
                    {!!act.why && <Text style={styles.why}>{act.why}</Text>}
                  </View>
                </View>
              ))}
            </View>
          )}

          {(!!a.best_time || a.next_call_days != null) && (
            <View style={styles.timeRow}>
              {!!a.best_time && <Text style={styles.time}>⏰ {a.best_time}</Text>}
              {a.next_call_days != null && (
                <Pressable onPress={setNextCall} disabled={busy} accessibilityRole="button" style={styles.nextBtn}>
                  <Text style={styles.nextText}>
                    📅 {a.next_call_days === 0 ? 'আজই কল সেট করুন' : `${a.next_call_days} দিন পরে কল সেট করুন`}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {a.script.length > 0 && (
            <View style={styles.block}>
              <Pressable
                onPress={() => setScriptOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: scriptOpen }}
                style={styles.toggle}
              >
                <Text style={styles.label}>💬 কী বলবেন ({a.script.length})</Text>
                <Text style={styles.chev}>{scriptOpen ? '▾' : '▸'}</Text>
              </Pressable>
              {scriptOpen &&
                a.script.map((s, i) => (
                  <View key={i} style={styles.script}>
                    <Text style={styles.situation}>{s.situation}</Text>
                    {s.lines.map((line, j) => (
                      <Pressable
                        key={j}
                        onLongPress={() => {
                          Clipboard.setStringAsync(line).catch(() => undefined);
                          onChanged?.('Copied');
                        }}
                        accessibilityHint="Hold to copy"
                      >
                        <Text style={styles.line}>“{line}”</Text>
                      </Pressable>
                    ))}
                  </View>
                ))}
            </View>
          )}

          {(a.good.length > 0 || a.risks.length > 0) && (
            <Pressable onPress={() => setMore((v) => !v)} accessibilityRole="button" style={styles.toggle}>
              <Text style={styles.label}>🔍 কেন এই সম্ভাবনা</Text>
              <Text style={styles.chev}>{more ? '▾' : '▸'}</Text>
            </Pressable>
          )}
          {more && (
            <View style={styles.block}>
              {a.good.map((g, i) => (
                <Text key={`g${i}`} style={styles.good}>
                  ✅ {g}
                </Text>
              ))}
              {a.risks.map((r, i) => (
                <Text key={`r${i}`} style={styles.risk}>
                  ⚠️ {r}
                </Text>
              ))}
            </View>
          )}
        </>
      ) : (
        !waiting && (
          <Text style={styles.muted}>
            {c.status === 'failed'
              ? `AI দেখতে পারেনি${c.error ? `: ${c.error}` : '।'}`
              : 'কল, নোট আর সবার কাজ দেখে AI ভর্তির সম্ভাবনা আর কী বলবেন তা জানাবে।'}
          </Text>
        )
      )}

      {waiting && (
        <View style={styles.waitRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.muted}>AI দেখছে… (আধা মিনিটের মতো লাগে)</Text>
        </View>
      )}
      {!!error && <Text style={styles.bad}>{error}</Text>}
      {/* admins: the other AI could not answer this time */}
      {!waiting && !!c.side_note && <Text style={styles.sideNote}>⚠️ {c.side_note}</Text>}

      <View style={styles.foot}>
        <Text style={styles.when}>
          {a.done_at ? `দেখা হয়েছে ${ago(a.done_at)}` : ''}
          {c.status === 'pending' && !waiting && c.due_at ? ' · নতুন কল/নোট: আবার দেখবে' : ''}
        </Text>
        {!waiting && (
          <Pressable onPress={checkOrWarn} disabled={busy} accessibilityRole="button" style={styles.checkBtn}>
            <Text style={styles.checkText}>{has ? '🔄 আবার দেখুন' : '🔮 AI দিয়ে দেখুন'}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  aiTag: {
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.background,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  big: { fontSize: 34, fontWeight: fontWeight.bold },
  level: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  up: { color: colors.success },
  down: { color: colors.danger },
  track: { height: 6, borderRadius: 3, marginTop: 6, backgroundColor: colors.background, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  summary: { fontSize: fontSize.small, lineHeight: 21, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.dangerSoft },
  chipText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.danger },
  block: { gap: 6 },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  action: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  num: {
    width: 20,
    height: 20,
    borderRadius: 10,
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 20,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textOnPrimary,
    backgroundColor: colors.primary,
  },
  actionText: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  why: { fontSize: fontSize.caption, lineHeight: 17, color: colors.textMuted },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  time: { fontSize: fontSize.small, color: colors.text },
  nextBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  nextText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  chev: { fontSize: fontSize.small, color: colors.textMuted },
  script: { gap: 4, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background },
  situation: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  line: { fontSize: fontSize.small, lineHeight: 21, color: colors.text },
  good: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  risk: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  tabs: { flexDirection: 'row', gap: 6 },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  tabTextOn: { color: colors.textOnPrimary },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  muted: { flexShrink: 1, fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  bad: { fontSize: fontSize.small, color: colors.danger },
  sideNote: { fontSize: fontSize.caption, lineHeight: 17, color: colors.danger },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  when: { flex: 1, fontSize: fontSize.caption, color: colors.textMuted },
  checkBtn: { paddingVertical: 4, paddingHorizontal: spacing.xs },
  checkText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});
