import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🔥 Admission chance (0-100): worked out by the database from the lead's
//   own data (no AI, no cost). Settings → Lead score sets the points.
//   Admitted = 100, Lost / Cancelled = 0.
// =====================================================================

export type ScoreRuleKey =
  | 'visited'
  | 'visit_planned'
  | 'fee_talk'
  | 'answered'
  | 'interested_stage'
  | 'ready_stage'
  | 'referral'
  | 'hot'
  | 'cold'
  | 'silent_7'
  | 'silent_30'
  | 'missed_3'
  | 'wrong_number';

export const SCORE_RULES: { key: ScoreRuleKey; icon: string; label: string; text: string }[] = [
  { key: 'visited', icon: '🏫', label: 'Came to the campus', text: 'A campus visit is marked Visited' },
  { key: 'visit_planned', icon: '📅', label: 'Visit planned', text: 'A campus visit is planned' },
  { key: 'fee_talk', icon: '💬', label: 'Fee talked about', text: 'Fee or discount was discussed' },
  { key: 'answered', icon: '📞', label: 'Answered the last call', text: 'The latest call was answered' },
  {
    key: 'interested_stage',
    icon: '👍',
    label: 'Interested or later',
    text: 'Stage Interested, Campus visit, Follow-up…',
  },
  { key: 'ready_stage', icon: '📄', label: 'Papers / Ready', text: 'Stage Papers pending or Ready for admission' },
  { key: 'referral', icon: '🎓', label: 'Referred', text: 'Referred by an alumnus, or a Referral source' },
  { key: 'hot', icon: '🔥', label: 'Rated Hot', text: 'Rating is Hot' },
  { key: 'cold', icon: '🧊', label: 'Rated Cold', text: 'Rating is Cold' },
  { key: 'silent_7', icon: '⏳', label: 'No contact 7+ days', text: 'Nobody talked to them for a week or more' },
  { key: 'silent_30', icon: '💤', label: 'No contact 30+ days', text: 'A month or more (on top of the 7 days)' },
  { key: 'missed_3', icon: '📵', label: 'Last 3 calls not answered', text: 'The last three calls went unanswered' },
  { key: 'wrong_number', icon: '❌', label: 'Wrong number', text: 'The latest call was a wrong number' },
];

const RULE = new Map(SCORE_RULES.map((r) => [r.key, r]));

export type ScoreSettings = { enabled: boolean; base: number; rules: Record<ScoreRuleKey, number> };

export const DEFAULT_SCORE_SETTINGS: ScoreSettings = {
  enabled: true,
  base: 30,
  rules: {
    visited: 25,
    visit_planned: 10,
    fee_talk: 15,
    answered: 15,
    interested_stage: 10,
    ready_stage: 10,
    referral: 10,
    hot: 10,
    cold: -10,
    silent_7: -15,
    silent_30: -15,
    missed_3: -20,
    wrong_number: -40,
  },
};

// On or off (Settings → Lead score): cards read this; the lists keep it fresh
let scoreOn = true;

export async function getScoreSettings(): Promise<ScoreSettings> {
  const saved = await getSetting<Partial<ScoreSettings>>('lead_score').catch(() => null);
  scoreOn = saved?.enabled ?? true;
  return {
    ...DEFAULT_SCORE_SETTINGS,
    ...(saved ?? {}),
    rules: { ...DEFAULT_SCORE_SETTINGS.rules, ...(saved?.rules ?? {}) },
  };
}

export async function saveScoreSettings(s: ScoreSettings): Promise<void> {
  await updateSetting('lead_score', s as unknown as Json);
  scoreOn = s.enabled;
}

/** Lists and the lead page: is the score switched on? (re-renders when it changes) */
export function useScoreOn(): boolean {
  const [on, setOn] = useState(scoreOn);
  useEffect(() => {
    getScoreSettings()
      .then((s) => setOn(s.enabled))
      .catch(() => undefined);
  }, []);
  return on;
}

/** Admins: work every lead's score out again (after changing the points) */
export async function recalcScores(): Promise<number> {
  const { data, error } = await supabase.rpc('recalc_lead_scores' as never);
  if (error) {
    throw new Error(
      /could not find the function/i.test(error.message) ? 'The database is not updated yet.' : error.message,
    );
  }
  return (data as unknown as number) ?? 0;
}

export type ScoreReason = { key: string; points: number };

/** 🔥 70+ · 🙂 40-69 · ❄️ below 40 */
export function scoreTone(score: number): { color: string; icon: string; text: string } {
  if (score >= 70) return { color: colors.success, icon: '🔥', text: 'Likely' };
  if (score >= 40) return { color: colors.warning, icon: '🙂', text: 'Maybe' };
  return { color: colors.textMuted, icon: '❄️', text: 'Unlikely' };
}

/** Is there a score to show? (open leads only; 0 before the database update) */
export function showScore(lead: {
  score?: number | null;
  stage?: { kind?: string | null } | null;
}): lead is { score: number; stage?: { kind?: string | null } | null } {
  return scoreOn && typeof lead.score === 'number' && (lead.stage?.kind ?? 'open') === 'open';
}

/** The small chip on cards */
export function ScoreChip({ score, compact }: { score: number; compact?: boolean }) {
  const t = scoreTone(score);
  return (
    <View style={[styles.chip, { borderColor: t.color }]} accessibilityLabel={`Admission chance ${score} percent`}>
      <Text style={[styles.chipText, { color: t.color }]}>
        {compact ? '' : `${t.icon} `}
        {score}%
      </Text>
    </View>
  );
}

/** Lead page: the score, tap → why */
export function LeadScoreRow({ score, reasons }: { score: number; reasons: ScoreReason[] | null | undefined }) {
  const [open, setOpen] = useState(false);
  const t = scoreTone(score);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.row}
        accessibilityRole="button"
        accessibilityHint="Shows why"
      >
        <Text style={styles.rowLabel}>Admission chance</Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${score}%`, backgroundColor: t.color }]} />
        </View>
        <Text style={[styles.rowValue, { color: t.color }]}>
          {t.icon} {score}%
        </Text>
        <Text style={styles.why}>Why ›</Text>
      </Pressable>
      {open && <WhySheet score={score} reasons={reasons ?? []} onClose={() => setOpen(false)} />}
    </>
  );
}

function WhySheet({ score, reasons, onClose }: { score: number; reasons: ScoreReason[]; onClose: () => void }) {
  const t = scoreTone(score);
  const plus = reasons.filter((r) => r.points > 0);
  const minus = reasons.filter((r) => r.points < 0);
  const special = reasons.find((r) => r.key === 'admitted' || r.key === 'closed');
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <Text style={styles.sheetTitle}>
            {t.icon} Admission chance: {score}%
          </Text>
          <Text style={styles.muted}>
            {special
              ? special.key === 'admitted'
                ? 'Admitted.'
                : 'Closed (lost or cancelled).'
              : 'Worked out from this lead’s calls, visits, fee talk, stage and rating. It changes by itself.'}
          </Text>
          {plus.map((r) => (
            <Reason key={r.key} r={r} />
          ))}
          {minus.map((r) => (
            <Reason key={r.key} r={r} />
          ))}
          {!special && reasons.length === 0 && <Text style={styles.muted}>Nothing yet: only the start value.</Text>}
          <Button title="Close" variant="secondary" onPress={onClose} fullWidth />
        </ScrollView>
      </View>
    </Modal>
  );
}

function Reason({ r }: { r: ScoreReason }) {
  const info = RULE.get(r.key as ScoreRuleKey);
  return (
    <View style={styles.reason}>
      <Text style={styles.reasonIcon}>{info?.icon ?? '•'}</Text>
      <Text style={styles.reasonText}>{info?.label ?? r.key}</Text>
      <Text style={[styles.points, { color: r.points > 0 ? colors.success : colors.danger }]}>
        {r.points > 0 ? `+${r.points}` : r.points}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { paddingVertical: 1, paddingHorizontal: 6, borderRadius: radius.pill, borderWidth: 1 },
  chipText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  rowLabel: { width: 120, fontSize: fontSize.small, color: colors.textMuted },
  bar: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  rowValue: { fontSize: fontSize.small, fontWeight: fontWeight.bold, minWidth: 54, textAlign: 'right' },
  why: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '80%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    ...(Platform.OS === 'web' ? { width: '100%', maxWidth: 520, alignSelf: 'center' } : {}),
  },
  sheetBody: { padding: spacing.lg, gap: spacing.sm },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  reasonIcon: { width: 24, fontSize: 16, textAlign: 'center' },
  reasonText: { flex: 1, fontSize: fontSize.small, color: colors.text },
  points: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
});
