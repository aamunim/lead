import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  getLeadCredit,
  redoLeadCredit,
  setLeadCreditByHand,
  type CreditStat,
  type LeadCredit,
} from '@/features/aiCredit/api';
import { PROVIDER_LABEL } from '@/features/aiProviders/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🤝 Admission credit (admitted leads): who did how much, worked out by
//   the AI from the lead's calls, minutes, notes, visits and fee talks.
//   Shown only to the people Settings → AI allows (the server decides;
//   for others it shows nothing). One small request, kept for a minute.
//   Admins: work it out again, or set the shares by hand (with a reason).
//   Claude and Gemini: the badge says which AI's shares Credits use; the
//   other AI's answer (if any) stays and can be opened below.
// =====================================================================

const CONF: Record<string, string> = {
  high: 'Sure',
  medium: 'Fairly sure',
  low: 'Not sure',
};
const POLL_MS = 20_000;
const POLLS = 6;

function statLine(s: CreditStat | undefined): string {
  if (!s) return '';
  const parts = [
    s.calls ? `📞 ${s.calls}${s.answered_calls ? ` (${s.answered_calls} answered)` : ''}` : '',
    s.talk_minutes ? `⏱ ${s.talk_minutes} min` : '',
    s.whatsapp ? `💬 ${s.whatsapp}` : '',
    s.notes ? `📝 ${s.notes}` : '',
    s.visits ? `🏫 ${s.visits}` : '',
    s.fee_actions ? `💰 ${s.fee_actions}` : '',
    s.papers ? `📄 ${s.papers}` : '',
  ].filter(Boolean);
  return parts.join('  ');
}

export function AdmissionCreditCard({
  leadId,
  stateKey,
  nameOf,
}: {
  leadId: string;
  /** changes when the admission changes (e.g. admitted_at) */
  stateKey: string;
  nameOf: (userId: string | null | undefined) => string | null;
}) {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [c, setC] = useState<LeadCredit | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const polls = useRef(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    polls.current = 0;
    const load = (force: boolean) =>
      getLeadCredit(leadId, force)
        .then((d) => {
          if (!alive) return;
          setC(d);
          // still waiting: look again a few times while the page is open
          if (d && (d.status === 'pending' || d.status === 'working') && polls.current < POLLS) {
            polls.current += 1;
            timer = setTimeout(() => load(true), POLL_MS);
          }
        })
        .catch((e) => {
          if (!alive) return;
          setLoadError(e instanceof Error ? e.message : 'Could not load.');
          setC(null);
        });
    load(false);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [leadId, stateKey]);

  // not allowed / older database: nothing at all
  if (c === null && loadError)
    return (
      <View style={styles.card}>
        <Text style={styles.title}>🤝 Admission credit</Text>
        <Text style={styles.bad}>Could not load: {loadError}</Text>
      </View>
    );
  if (c === null) return null;
  if (c === undefined) return null; // no spinner: the card appears when ready

  const redo = async () => {
    setBusy(true);
    setError(null);
    try {
      await redoLeadCredit(leadId);
      polls.current = 0;
      setC({ ...c, status: 'pending' });
      // look again shortly
      setTimeout(
        () =>
          getLeadCredit(leadId, true)
            .then((d) => d && setC(d))
            .catch(() => undefined),
        POLL_MS,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start.');
    } finally {
      setBusy(false);
    }
  };

  const statOf = (userId: string) => c.stats.find((s) => s.user_id === userId);
  const name = (userId: string, fallback: string | null) => fallback ?? nameOf(userId) ?? 'Someone';
  // a hand-set card: every AI's answer is "other"; else the AIs besides the one shown
  const others = c.answers.filter((o) => c.manual || c.status !== 'done' || o.provider !== c.provider);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>🤝 Admission credit</Text>
        {c.status === 'done' && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {c.manual
                ? '✍️ Set by hand'
                : `🤖 ${c.provider ? PROVIDER_LABEL[c.provider] : 'AI'} · ${CONF[c.confidence ?? ''] ?? ''}`}
            </Text>
          </View>
        )}
      </View>

      {(c.status === 'pending' || c.status === 'working' || c.status === 'none') && (
        <View style={styles.waitRow}>
          {c.status !== 'none' && <ActivityIndicator size="small" color={colors.primary} />}
          <Text style={styles.muted}>
            {c.status === 'none'
              ? 'Not worked out yet.'
              : 'The AI is working out who did how much… (it runs in the background; this page need not stay open)'}
          </Text>
        </View>
      )}

      {c.status === 'failed' && (
        <Text style={styles.bad}>Could not be worked out{isAdmin && c.error ? `: ${c.error}` : '.'}</Text>
      )}

      {c.status === 'done' && !editing && (
        <>
          {c.shares.map((s) => (
            <View key={s.user_id} style={styles.share}>
              <View style={styles.shareTop}>
                <Text style={styles.person} numberOfLines={1}>
                  {name(s.user_id, s.name)}
                </Text>
                <Text style={styles.pct}>{Math.round(s.share)}%</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(2, Math.min(100, s.share))}%` }]} />
              </View>
              {!!s.reason && <Text style={styles.reason}>{s.reason}</Text>}
              {!!statLine(statOf(s.user_id)) && <Text style={styles.stats}>{statLine(statOf(s.user_id))}</Text>}
            </View>
          ))}
          {!!c.decisive && (
            <View style={styles.decisive}>
              <Text style={styles.decisiveLabel}>⭐ What turned the student</Text>
              <Text style={styles.decisiveText}>{c.decisive}</Text>
            </View>
          )}
          {c.manual && !!c.edit_reason && (
            <Text style={styles.muted}>
              ✍️ {c.edited_by ?? 'An admin'}: “{c.edit_reason}”
            </Text>
          )}
        </>
      )}

      {/* 🗂 the other AI's answer (kept; Credits use the one above) */}
      {!editing && others.length > 0 && (
        <>
          <Pressable
            onPress={() => setOthersOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: othersOpen }}
            style={styles.link}
          >
            <Text style={styles.linkText}>
              {othersOpen ? '▾' : '▸'} {others.map((o) => PROVIDER_LABEL[o.provider]).join(' · ')}’s answer
            </Text>
          </Pressable>
          {othersOpen &&
            others.map((o) => (
              <View key={o.provider} style={styles.other}>
                <Text style={styles.otherTitle}>
                  🤖 {PROVIDER_LABEL[o.provider]}
                  {o.confidence ? ` · ${CONF[o.confidence] ?? ''}` : ''}
                </Text>
                {o.shares.map((s) => (
                  <Text key={s.user_id} style={styles.otherLine}>
                    {name(s.user_id, s.name)}: {Math.round(s.share)}%{s.reason ? ` — ${s.reason}` : ''}
                  </Text>
                ))}
                {!!o.decisive && <Text style={styles.muted}>⭐ {o.decisive}</Text>}
              </View>
            ))}
        </>
      )}

      {editing && (
        <ManualEditor
          credit={c}
          nameOf={(id) => name(id, c.shares.find((s) => s.user_id === id)?.name ?? null)}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            const d = await getLeadCredit(leadId, true).catch(() => null);
            if (d) setC(d);
          }}
          leadId={leadId}
        />
      )}

      {!!error && <Text style={styles.bad}>{error}</Text>}

      {isAdmin && !editing && (
        <View style={styles.actions}>
          {c.status !== 'pending' && c.status !== 'working' && (
            <Pressable onPress={redo} disabled={busy} accessibilityRole="button" style={styles.link}>
              <Text style={styles.linkText}>{c.status === 'none' ? '🤖 Work it out' : '🔄 Work out again'}</Text>
            </Pressable>
          )}
          {(c.status === 'done' || c.status === 'failed') && (
            <Pressable onPress={() => setEditing(true)} accessibilityRole="button" style={styles.link}>
              <Text style={styles.linkText}>✍️ Change by hand</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
// ✍️ An admin sets the shares by hand (they must add up to 100)
// ---------------------------------------------------------------------
function ManualEditor({
  credit,
  leadId,
  nameOf,
  onCancel,
  onSaved,
}: {
  credit: LeadCredit;
  leadId: string;
  nameOf: (userId: string) => string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  // everyone the AI looked at (stats) and everyone with a share
  const ids = Array.from(
    new Set([...credit.shares.map((s) => s.user_id), ...credit.stats.map((s) => s.user_id ?? '')].filter(Boolean)),
  );
  const [pct, setPct] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ids.map((id) => [id, String(Math.round(credit.shares.find((s) => s.user_id === id)?.share ?? 0))]),
    ),
  );
  const [why, setWhy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = ids.reduce((sum, id) => sum + (Number(pct[id]) || 0), 0);

  const save = async () => {
    if (total !== 100) return setError(`The shares must add up to 100 (now ${total}).`);
    if (!why.trim()) return setError('Please write why.');
    setSaving(true);
    setError(null);
    try {
      await setLeadCreditByHand(
        leadId,
        ids.filter((id) => (Number(pct[id]) || 0) > 0).map((id) => ({ user_id: id, share: Number(pct[id]) })),
        why.trim(),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.editor}>
      {ids.map((id) => (
        <View key={id} style={styles.editRow}>
          <Text style={[styles.person, styles.flex]} numberOfLines={1}>
            {nameOf(id)}
          </Text>
          <TextInput
            value={pct[id]}
            onChangeText={(t) => setPct((p) => ({ ...p, [id]: t.replace(/\D/g, '').slice(0, 3) }))}
            keyboardType="number-pad"
            style={styles.pctInput}
            accessibilityLabel={`${nameOf(id)} percent`}
          />
          <Text style={styles.muted}>%</Text>
        </View>
      ))}
      <Text style={[styles.muted, total !== 100 && styles.bad]}>Total: {total}%</Text>
      <TextInput
        value={why}
        onChangeText={setWhy}
        placeholder="Why the change?"
        placeholderTextColor={colors.textMuted}
        style={styles.whyInput}
        maxLength={300}
      />
      {!!error && <Text style={styles.bad}>{error}</Text>}
      <View style={styles.actions}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onCancel} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title="Save" onPress={save} loading={saving} fullWidth />
        </View>
      </View>
    </View>
  );
}

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
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
  },
  badgeText: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  muted: { flexShrink: 1, fontSize: fontSize.small, color: colors.textMuted },
  bad: { fontSize: fontSize.small, color: colors.danger },
  share: { gap: 4, paddingVertical: spacing.xs },
  shareTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  person: {
    flex: 1,
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  pct: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  reason: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  stats: { fontSize: fontSize.caption, color: colors.textMuted },
  decisive: {
    gap: 2,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  decisiveLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
  },
  decisiveText: {
    fontSize: fontSize.small,
    lineHeight: 20,
    color: colors.text,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    alignItems: 'center',
  },
  link: { paddingVertical: spacing.xs, paddingHorizontal: spacing.xs },
  other: { gap: 4, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background },
  otherTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  otherLine: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  linkText: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  editor: { gap: spacing.sm },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pctInput: {
    width: 64,
    minHeight: 40,
    textAlign: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
    backgroundColor: colors.background,
  },
  whyInput: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.small,
    backgroundColor: colors.background,
  },
});
