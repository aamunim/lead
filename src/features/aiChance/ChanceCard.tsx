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
import { scheduleFollowUp } from '@/features/follow-ups/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🔮 Lead page: the AI's chance of admission, why, the doubts it heard,
//   what to do next and what to say. Open leads; one small request, kept
//   for a minute. "Check now" asks the AI again (it answers in about
//   half a minute; the card waits by itself).
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
  const [more, setMore] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
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
      .catch(() => alive.current && setC(null));

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

  const setNextCall = async () => {
    if (c.next_call_days == null) return;
    const d = new Date();
    d.setDate(d.getDate() + c.next_call_days);
    d.setHours(c.next_call_days === 0 ? Math.min(d.getHours() + 2, 20) : 11, 0, 0, 0);
    setBusy(true);
    setError(null);
    try {
      await scheduleFollowUp(leadId, d, c.next_call_why ? `🔮 ${c.next_call_why}` : null);
      onChanged?.('Next call set');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set the next call.');
    } finally {
      setBusy(false);
    }
  };

  const waiting = c.status === 'working' || (c.status === 'pending' && !!c.due_at && new Date(c.due_at) <= new Date());
  const has = c.chance != null;
  const tone = chanceTone(c.level);
  const color = levelColor(c.level);
  const trend = has && c.prev_chance != null ? c.chance! - c.prev_chance : 0;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>🔮 ভর্তির সম্ভাবনা</Text>
        <Text style={styles.aiTag}>AI</Text>
      </View>

      {has ? (
        <>
          <View style={styles.scoreRow}>
            <Text style={[styles.big, { color }]}>{c.chance}%</Text>
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
                <View style={[styles.fill, { width: `${Math.max(3, c.chance!)}%`, backgroundColor: color }]} />
              </View>
            </View>
          </View>
          {!!c.summary && <Text style={styles.summary}>{c.summary}</Text>}

          {c.objections.length > 0 && (
            <View style={styles.chips}>
              {c.objections.map((o, i) => (
                <View key={i} style={styles.chip}>
                  <Text style={styles.chipText}>{OBJECTION_LABEL[o.kind] ?? o.kind}</Text>
                </View>
              ))}
            </View>
          )}

          {c.actions.length > 0 && (
            <View style={styles.block}>
              <Text style={styles.label}>👉 এখন যা করবেন</Text>
              {c.actions.map((a, i) => (
                <View key={i} style={styles.action}>
                  <Text style={styles.num}>{i + 1}</Text>
                  <View style={styles.flex}>
                    <Text style={styles.actionText}>{a.text}</Text>
                    {!!a.why && <Text style={styles.why}>{a.why}</Text>}
                  </View>
                </View>
              ))}
            </View>
          )}

          {(!!c.best_time || c.next_call_days != null) && (
            <View style={styles.timeRow}>
              {!!c.best_time && <Text style={styles.time}>⏰ {c.best_time}</Text>}
              {c.next_call_days != null && (
                <Pressable onPress={setNextCall} disabled={busy} accessibilityRole="button" style={styles.nextBtn}>
                  <Text style={styles.nextText}>
                    📅 {c.next_call_days === 0 ? 'আজই কল সেট করুন' : `${c.next_call_days} দিন পরে কল সেট করুন`}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {c.script.length > 0 && (
            <View style={styles.block}>
              <Pressable
                onPress={() => setScriptOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: scriptOpen }}
                style={styles.toggle}
              >
                <Text style={styles.label}>💬 কী বলবেন ({c.script.length})</Text>
                <Text style={styles.chev}>{scriptOpen ? '▾' : '▸'}</Text>
              </Pressable>
              {scriptOpen &&
                c.script.map((s, i) => (
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

          {(c.good.length > 0 || c.risks.length > 0) && (
            <Pressable onPress={() => setMore((v) => !v)} accessibilityRole="button" style={styles.toggle}>
              <Text style={styles.label}>🔍 কেন এই সম্ভাবনা</Text>
              <Text style={styles.chev}>{more ? '▾' : '▸'}</Text>
            </Pressable>
          )}
          {more && (
            <View style={styles.block}>
              {c.good.map((g, i) => (
                <Text key={`g${i}`} style={styles.good}>
                  ✅ {g}
                </Text>
              ))}
              {c.risks.map((r, i) => (
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

      <View style={styles.foot}>
        <Text style={styles.when}>
          {c.done_at ? `দেখা হয়েছে ${ago(c.done_at)}` : ''}
          {c.status === 'pending' && !waiting && c.due_at ? ' · নতুন কল/নোট: আবার দেখবে' : ''}
        </Text>
        {!waiting && (
          <Pressable onPress={check} disabled={busy} accessibilityRole="button" style={styles.checkBtn}>
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
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  muted: { flexShrink: 1, fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  bad: { fontSize: fontSize.small, color: colors.danger },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  when: { flex: 1, fontSize: fontSize.caption, color: colors.textMuted },
  checkBtn: { paddingVertical: 4, paddingHorizontal: spacing.xs },
  checkText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
});
