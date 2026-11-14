import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  CREDIT_KINDS,
  getCreditExtras,
  getCreditSettings,
  saveCreditExtras,
  saveCreditSettings,
  DEFAULT_EXTRAS,
  DEFAULT_MILESTONES,
  type Milestone,
  type CreditExtras,
  type CreditKind,
  type CreditRule,
  type CreditSettings,
} from '@/features/credits/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Credits & leaderboard: how many credits each kind of
//   work is worth, the most per day, and whether a change also
//   recounts the past.
// =====================================================================

const EMPTY: CreditRule = { points: 0, cap: 0, on: false };

export default function CreditSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const [s, setS] = useState<CreditSettings | null>(null);
  // 🔔 notifications, 🔥 streaks, 🎖 badges
  const [x, setX] = useState<CreditExtras>(DEFAULT_EXTRAS);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCreditExtras()
      .then(setX)
      .catch(() => undefined);
    getCreditSettings()
      .then(setS)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, []);

  const setTop = (key: 'enabled' | 'retro', v: boolean) => {
    setS((now) => (now ? { ...now, [key]: v } : now));
    setDirty(true);
  };
  const setRule = (kind: CreditKind, patch: Partial<CreditRule>) => {
    setS((now) =>
      now ? { ...now, rules: { ...now.rules, [kind]: { ...EMPTY, ...now.rules[kind], ...patch } } } : now,
    );
    setDirty(true);
  };

  const save = async () => {
    if (!s) return;
    const ms = x.milestones;
    if (ms.some((m) => !m.name.trim() || m.at <= 0))
      return setError('Every milestone needs a name and credits above 0.');
    if (new Set(ms.map((m) => m.at)).size !== ms.length) return setError('Two milestones have the same credits.');
    setSaving(true);
    setError(null);
    try {
      await saveCreditSettings(s);
      await saveCreditExtras(x);
      setDirty(false);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!canManage)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Credits & leaderboard' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  if (!s)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Credits & leaderboard' }} />
        {error ? <Text style={styles.muted}>{error}</Text> : <ActivityIndicator size="large" color={colors.primary} />}
      </View>
    );

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Credits & leaderboard' }} />
      <Text style={styles.intro}>
        Everyone earns credits for their work and sees their place on the leaderboard (More → Leaderboard). Credits are
        worked out from what is already saved, so past days count too. Who is left out: the Super Admin decides on the
        leaderboard (tap a person).
      </Text>

      <View style={styles.card}>
        <SwitchRow
          title="Credits & leaderboard"
          text={s.enabled ? 'On' : 'Off: no credits, an empty leaderboard'}
          value={s.enabled}
          onChange={(v) => setTop('enabled', v)}
          big
        />
        <SwitchRow
          title="Changes count for past days too"
          text={
            s.retro
              ? 'On: after a change every day is counted again with the new numbers.'
              : 'Off: a change counts from today; past days keep the numbers they had.'
          }
          value={s.retro}
          onChange={(v) => setTop('retro', v)}
        />
      </View>

      <Text style={styles.label}>🔔 NOTIFICATIONS · 🔥 STREAKS · 🎖 BADGES</Text>
      <View style={styles.card}>
        <SwitchRow
          title="👑 Winner of the week"
          text={`${DAYS[x.winner.dow]} at ${hourText(x.winner.hour)}: the winner to everyone, with their own place`}
          value={x.winner.on}
          onChange={(v) => {
            setX({ ...x, winner: { ...x.winner, on: v } });
            setDirty(true);
          }}
        />
        {x.winner.on && (
          <View style={styles.fields}>
            <PickField
              label="Day"
              options={DAYS.map((d, i) => ({ value: i, label: d.slice(0, 3) }))}
              value={x.winner.dow}
              onChange={(v) => {
                setX({ ...x, winner: { ...x.winner, dow: v } });
                setDirty(true);
              }}
            />
            <NumField
              label="Hour (0–23)"
              value={x.winner.hour}
              onChange={(v) => {
                setX({ ...x, winner: { ...x.winner, hour: Math.min(23, v) } });
                setDirty(true);
              }}
            />
          </View>
        )}
        <SwitchRow
          title="🥇 “You are now #2”"
          text="When someone gets into this week’s top 3 (once a day)"
          value={x.rank.on}
          onChange={(v) => {
            setX({ ...x, rank: { on: v } });
            setDirty(true);
          }}
        />
        <SwitchRow
          title="💪 “Only 25 credits to #3”"
          text={`At ${hourText(x.nudge.hour)}, to anyone this close to the next place`}
          value={x.nudge.on}
          onChange={(v) => {
            setX({ ...x, nudge: { ...x.nudge, on: v } });
            setDirty(true);
          }}
        />
        {x.nudge.on && (
          <View style={styles.fields}>
            <NumField
              label="Hour (0–23)"
              value={x.nudge.hour}
              onChange={(v) => {
                setX({ ...x, nudge: { ...x.nudge, hour: Math.min(23, v) } });
                setDirty(true);
              }}
            />
            <NumField
              label="When at most (credits)"
              value={x.nudge.gap}
              onChange={(v) => {
                setX({ ...x, nudge: { ...x.nudge, gap: v } });
                setDirty(true);
              }}
            />
          </View>
        )}
        <View style={styles.fields}>
          <NumField
            label="🔥 A streak day needs (credits)"
            value={x.streak_min}
            onChange={(v) => {
              setX({ ...x, streak_min: v });
              setDirty(true);
            }}
          />
        </View>
        <SwitchRow
          title="🎖 Badges"
          text="14 badges: 💯 100 calls a day · 🎯 50 talked · ⏱ 2 h talk · 🌅 before 9 AM · ⚡ new lead in 10 min · 🆕 10 leads · 📝 30 notes · 💬 50 WhatsApp · 🎓 5 admitted a week · 🏫 5 visits · 💵 ৳50,000 a week · 🔥 7 and ☄️ 30 days in a row · 👑 winner"
          value={x.badges}
          onChange={(v) => {
            setX({ ...x, badges: v });
            setDirty(true);
          }}
        />
      </View>

      <Text style={styles.label}>🏅 MILESTONES (ALL-TIME CREDITS)</Text>
      <Text style={styles.hint}>
        Everyone moves up a level when their credits in all reach a milestone, and gets a notice. Up to 10 levels.
      </Text>
      <View style={styles.card}>
        {x.milestones.map((m, i) => (
          <MilestoneRow
            key={i}
            n={i + 1}
            m={m}
            onChange={(patch) => {
              setX({ ...x, milestones: x.milestones.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
              setDirty(true);
            }}
            onRemove={
              x.milestones.length > 1
                ? () => {
                    setX({ ...x, milestones: x.milestones.filter((_, j) => j !== i) });
                    setDirty(true);
                  }
                : undefined
            }
          />
        ))}
        <View style={styles.row}>
          {x.milestones.length < 10 && (
            <Text
              style={styles.link}
              onPress={() => {
                const last = x.milestones[x.milestones.length - 1];
                setX({ ...x, milestones: [...x.milestones, { at: (last?.at ?? 0) * 2 || 100, icon: '⭐', name: '' }] });
                setDirty(true);
              }}
            >
              + Add a level
            </Text>
          )}
          <View style={styles.flex} />
          <Text
            style={styles.link}
            onPress={() => {
              setX({ ...x, milestones: DEFAULT_MILESTONES });
              setDirty(true);
            }}
          >
            Reset to the 10 levels
          </Text>
        </View>
      </View>

      <Text style={styles.label}>CREDITS FOR EACH KIND OF WORK</Text>
      <Text style={styles.hint}>
        “Credits” for one · “Most a day” stops one kind from taking over (0 = no limit). A minus number takes credits
        away.
      </Text>

      <View style={!s.enabled && styles.dimmed} pointerEvents={s.enabled ? 'auto' : 'none'}>
        {CREDIT_KINDS.map((k) => {
          const r = { ...EMPTY, ...s.rules[k.kind] };
          return (
            <View key={k.kind} style={[styles.rule, !r.on && styles.ruleOff]}>
              <View style={styles.ruleHead}>
                <Text style={styles.ruleIcon}>{k.icon}</Text>
                <View style={styles.flex}>
                  <Text style={styles.ruleTitle}>{k.label}</Text>
                  <Text style={styles.ruleText}>per {k.per}</Text>
                </View>
                <Switch value={r.on} onValueChange={(v) => setRule(k.kind, { on: v })} />
              </View>
              {r.on && (
                <View style={styles.fields}>
                  <NumField
                    label="Credits"
                    value={r.points}
                    onChange={(v) => setRule(k.kind, { points: v })}
                    allowMinus
                  />
                  <NumField label="Most a day" value={r.cap} onChange={(v) => setRule(k.kind, { cap: Math.abs(v) })} />
                  {k.extra && (
                    <NumField
                      label={`${k.extra.label} (${k.extra.unit})`}
                      value={Number(r[k.extra.key] ?? 0)}
                      onChange={(v) => setRule(k.kind, { [k.extra!.key]: Math.abs(v) } as Partial<CreditRule>)}
                    />
                  )}
                </View>
              )}
            </View>
          );
        })}
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
    </KeyboardAwareScrollView>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourText = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

function PickField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: number; label: string }[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={[styles.field, { flex: 2 }]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.pick}>
        {options.map((o) => (
          <Text
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.pickItem, o.value === value && styles.pickOn]}
            accessibilityRole="radio"
          >
            {o.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function NumField({
  label,
  value,
  onChange,
  allowMinus,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  allowMinus?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        value={text}
        onChangeText={(t) => {
          const clean = t.replace(allowMinus ? /[^0-9-]/g : /[^0-9]/g, '');
          setText(clean);
          const n = parseInt(clean, 10);
          if (!Number.isNaN(n)) onChange(n);
          else if (clean === '') onChange(0);
        }}
        keyboardType={allowMinus ? 'numbers-and-punctuation' : 'number-pad'}
        style={styles.input}
      />
    </View>
  );
}

function MilestoneRow({
  n,
  m,
  onChange,
  onRemove,
}: {
  n: number;
  m: Milestone;
  onChange: (patch: Partial<Milestone>) => void;
  onRemove?: () => void;
}) {
  return (
    <View style={styles.msRow}>
      <Text style={styles.msNum}>{n}</Text>
      <TextInput
        value={m.icon}
        onChangeText={(t) => onChange({ icon: t.trim().slice(0, 4) })}
        style={[styles.input, styles.msIcon]}
        accessibilityLabel={`Level ${n} icon`}
      />
      <TextInput
        value={m.name}
        onChangeText={(t) => onChange({ name: t.slice(0, 24) })}
        placeholder="Name"
        placeholderTextColor={colors.textMuted}
        style={[styles.input, styles.flex]}
        accessibilityLabel={`Level ${n} name`}
      />
      <View style={styles.msAt}>
        <NumField label="" value={m.at} onChange={(v) => onChange({ at: v })} />
      </View>
      {onRemove ? (
        <Text style={styles.msX} onPress={onRemove} accessibilityLabel={`Remove level ${n}`}>
          ✕
        </Text>
      ) : null}
    </View>
  );
}

function SwitchRow({
  title,
  text,
  value,
  onChange,
  big,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
  big?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, big && styles.rowTitleBig]}>{title}</Text>
        <Text style={styles.ruleText}>{text}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  flex: { flex: 1 },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  intro: { fontSize: fontSize.small, color: colors.textMuted, lineHeight: 20 },
  card: {
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleBig: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
    color: colors.textMuted,
    marginTop: spacing.md,
  },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  dimmed: { opacity: 0.45 },
  rule: {
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  ruleOff: { opacity: 0.6 },
  ruleHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ruleIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  ruleTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  ruleText: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  fields: { flexDirection: 'row', gap: spacing.sm, paddingLeft: 40 },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 11, color: colors.textMuted },
  input: {
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
  },
  error: { color: colors.danger, fontSize: fontSize.small },
  link: { color: colors.primary, fontWeight: fontWeight.semibold, fontSize: fontSize.small, paddingVertical: 4 },
  msRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: -spacing.sm },
  msNum: { width: 18, fontSize: fontSize.caption, color: colors.textMuted, textAlign: 'center' },
  msIcon: { width: 48, textAlign: 'center', paddingHorizontal: 4 },
  msAt: { width: 92 },
  msX: { fontSize: 16, color: colors.textMuted, paddingHorizontal: 4 },
  pick: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  pickItem: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    overflow: 'hidden',
  },
  pickOn: { backgroundColor: colors.primary, borderColor: colors.primary, color: colors.textOnPrimary },
});
