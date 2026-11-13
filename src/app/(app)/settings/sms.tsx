import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { Chip, s as ui } from '@/features/alumni/ui';
import { Sheet } from '@/features/alumni/sheets';
import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import {
  checkBalance,
  DEFAULT_SMS_SETTINGS,
  deleteProvider,
  deleteSender,
  getSmsAdmin,
  KIND_LABEL,
  phoneFormatReport,
  removeProviderKey,
  saveProvider,
  saveSender,
  saveSmsSettings,
  sendTest,
  smsLength,
  STATUS_LABEL,
  type NumberFormat,
  type PhoneReport,
  type ProviderInput,
  type SenderKind,
  type SmsBatchDetail,
  type SmsProvider,
  type SmsRule,
  type SmsSender,
  type SmsSettings,
} from '@/features/sms/api';
import { supabase } from '@/shared/lib/supabase';

import { smsAppHash } from '../../../../modules/sms-code';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → SMS
//   · SMS on/off, who may send, how fast
//   · SMS companies: send address ({api_key} {sender_id} {number} {message}),
//     API key (kept on the server), balance address; one is in use
//   · sender IDs of each: masking / non-masking, on/off, a default of each
//   · a test SMS and the balance
// =====================================================================

const say = (title: string, msg: string) =>
  Platform.OS === 'web' ? window.alert(`${title}\n\n${msg}`) : Alert.alert(title, msg);
const ask = (title: string, msg: string, ok: string, run: () => void) => {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${msg}`)) run();
  } else
    Alert.alert(title, msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: ok, style: 'destructive', onPress: run },
    ]);
};
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

const FORMATS: { key: NumberFormat; label: string }[] = [
  { key: '0', label: '01XXXXXXXXX' },
  { key: '880', label: '8801XXXXXXXXX' },
  { key: '+880', label: '+8801XXXXXXXXX' },
];

export default function SmsSettingsScreen() {
  const { hasPermission } = useAuth();
  const [settings, setSettings] = useState<SmsSettings>(DEFAULT_SMS_SETTINGS);
  const [providers, setProviders] = useState<SmsProvider[]>([]);
  const [pgNet, setPgNet] = useState(true);
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editProvider, setEditProvider] = useState<SmsProvider | 'new' | null>(null);
  const [editSender, setEditSender] = useState<{ provider: SmsProvider; sender: SmsSender | null } | null>(null);

  const load = useCallback(async () => {
    const a = await getSmsAdmin();
    setProviders(a.providers);
    setPgNet(a.pg_net);
    return a;
  }, []);

  useEffect(() => {
    Promise.all([
      load(),
      supabase.from('roles').select('key, name, rank').order('rank'),
      listAssignableUsers().catch(() => []),
    ])
      .then(([a, r, u]) => {
        setSettings({
          ...DEFAULT_SMS_SETTINGS,
          ...(a.settings ?? {}),
          send: { ...DEFAULT_SMS_SETTINGS.send, ...(a.settings?.send ?? {}) },
        });
        setRoles(((r.data ?? []) as { key: string; name: string }[]).filter((x) => x.key !== 'super_admin'));
        setUsers(u.filter((p) => p.role_key !== 'super_admin' && p.is_active));
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [load]);

  const set = (next: SmsSettings) => {
    setSettings(next);
    setDirty(true);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSmsSettings({
        ...settings,
        per_minute: Math.min(500, Math.max(1, Math.round(settings.per_minute || 60))),
        max_per_send: Math.min(20000, Math.max(1, Math.round(settings.max_per_send || 5000))),
      });
      setDirty(false);
      say('Saved', 'SMS settings saved.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      say('Could not do it', errText(e));
    }
  };

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'SMS' }} />
        <Text style={ui.muted}>Only admins can change this.</Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'SMS' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const active = providers.find((p) => p.is_active) ?? null;
  const ready = settings.enabled && !!active?.key_set && (active?.senders.some((s) => s.is_active) ?? false);

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'SMS' }} />

      {/* status */}
      <View style={[styles.banner, ready ? styles.bannerOk : styles.bannerWarn]}>
        <Text style={styles.bannerText}>
          {ready
            ? `✅ SMS is ready: ${active?.name}`
            : !active
              ? '⚠️ No SMS company is in use. Add one below (or fill in Bulk SMS Dhaka) and turn on “In use”.'
              : !active.key_set
                ? `⚠️ ${active.name}: save the API key.`
                : !active.senders.some((s) => s.is_active)
                  ? `⚠️ ${active.name}: add a sender ID.`
                  : '⚠️ SMS is off. Turn it on below.'}
        </Text>
        {!pgNet && (
          <Text style={styles.bannerText}>
            ⚠️ The server can’t make web requests (pg_net). Supabase → Database → Extensions → turn on pg_net.
          </Text>
        )}
      </View>

      {/* on/off, speed */}
      <View style={ui.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.title}>📨 SMS</Text>
            <Text style={ui.muted}>
              {settings.enabled ? 'On. People allowed below can send SMS.' : 'Off. Nothing is sent (queued SMS wait).'}
            </Text>
          </View>
          <Switch value={settings.enabled} onValueChange={(v) => set({ ...settings, enabled: v })} />
        </View>
        <NumberRow
          label="SMS each minute"
          hint="How fast a big send goes out (1–500)."
          value={settings.per_minute}
          onChange={(v) => set({ ...settings, per_minute: v })}
        />
        <NumberRow
          label="Most people in one send"
          value={settings.max_per_send}
          onChange={(v) => set({ ...settings, max_per_send: v })}
        />
      </View>

      {/* sign in with a code */}
      <View style={ui.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.title}>🔐 Sign in with mobile + SMS code</Text>
            <Text style={ui.muted}>
              {!settings.otp_login
                ? 'Off. Everyone signs in with email and password.'
                : active?.senders.some((s) => s.is_active && s.kind === 'non_masking') && active.key_set
                  ? 'On. The login page offers “Mobile + code”; the code comes from the non-masking sender. The number must be on the person’s profile (Users → Phone). Email sign-in stays.'
                  : '⚠️ On, but it needs an active non-masking sender ID in the SMS company in use.'}
            </Text>
          </View>
          <Switch value={settings.otp_login} onValueChange={(v) => set({ ...settings, otp_login: v })} />
        </View>
        {settings.otp_login && <AppCodes settings={settings} set={set} />}
      </View>

      <RuleCard
        title="👤 Who may send SMS"
        hint="They can send SMS to the alumni they see. Admins always can."
        rule={settings.send}
        roles={roles}
        users={users}
        onChange={(r) => set({ ...settings, send: r })}
      />

      {error && <Text style={ui.error}>{error}</Text>}
      {dirty && <Button title="Save" onPress={save} loading={saving} />}

      {/* companies */}
      <Text style={styles.section}>SMS COMPANIES</Text>
      {providers.map((p) => (
        <View key={p.id} style={[ui.card, p.is_active && styles.activeCard]}>
          <View style={styles.rowTop}>
            <View style={styles.flex}>
              <Text style={styles.title}>
                {p.name} {p.is_active ? '· ✅ In use' : ''}
              </Text>
              <Text style={styles.mono} numberOfLines={3}>
                {p.method} {p.send_url}
              </Text>
              <Text style={ui.muted}>
                API key: {p.key_set ? p.key_hint : 'not saved'} · Number:{' '}
                {FORMATS.find((f) => f.key === p.number_format)?.label}
                {p.success_match ? ` · Sent when the answer has: ${p.success_match}` : ''}
              </Text>
            </View>
          </View>
          <View style={styles.buttons}>
            <Button title="Edit" variant="secondary" onPress={() => setEditProvider(p)} />
            {!p.is_active && (
              <Button
                title="Use this"
                variant="secondary"
                onPress={() => run(() => saveProvider(p.id, { ...toInput(p), is_active: true }))}
              />
            )}
            {p.is_active && (
              <Button
                title="Stop using"
                variant="ghost"
                onPress={() => run(() => saveProvider(p.id, { ...toInput(p), is_active: false }))}
              />
            )}
            {p.key_set && (
              <Button
                title="Remove key"
                variant="ghost"
                onPress={() =>
                  ask('Remove the API key?', `${p.name} stops sending until a key is saved again.`, 'Remove', () =>
                    run(() => removeProviderKey(p.id)),
                  )
                }
              />
            )}
            <Button
              title="Delete"
              variant="danger"
              onPress={() =>
                ask('Delete this SMS company?', `${p.name} and its sender IDs are deleted.`, 'Delete', () =>
                  run(() => deleteProvider(p.id)),
                )
              }
            />
          </View>

          <Text style={ui.label}>SENDER IDs</Text>
          {p.senders.length === 0 && <Text style={ui.muted}>None yet.</Text>}
          {p.senders.map((s) => (
            <View key={s.id} style={styles.senderRow}>
              <View style={styles.flex}>
                <Text style={styles.text}>
                  {s.sender_id} {s.is_default ? '⭐' : ''}
                </Text>
                <Text style={ui.muted}>
                  {KIND_LABEL[s.kind]}
                  {s.label ? ` · ${s.label}` : ''}
                  {s.is_default ? ` · default ${KIND_LABEL[s.kind].toLowerCase()}` : ''}
                </Text>
              </View>
              <Switch
                value={s.is_active}
                onValueChange={(v) =>
                  run(() =>
                    saveSender(s.id, {
                      provider_id: p.id,
                      sender_id: s.sender_id,
                      kind: s.kind,
                      label: s.label,
                      is_active: v,
                      is_default: v && s.is_default,
                    }),
                  )
                }
              />
              <Button title="Edit" variant="ghost" onPress={() => setEditSender({ provider: p, sender: s })} />
            </View>
          ))}
          <Button
            title="＋ Add sender ID"
            variant="secondary"
            onPress={() => setEditSender({ provider: p, sender: null })}
          />
        </View>
      ))}
      <Button title="＋ Add an SMS company" variant="secondary" onPress={() => setEditProvider('new')} />

      {active && <TestCard provider={active} />}

      <NumbersCard />

      <Button title="📋 SMS sent so far" variant="ghost" onPress={() => router.push('/alumni/sms' as Href)} />

      {editProvider && (
        <ProviderSheet
          provider={editProvider === 'new' ? null : editProvider}
          onClose={() => setEditProvider(null)}
          onSaved={async () => {
            setEditProvider(null);
            await load();
          }}
        />
      )}
      {editSender && (
        <SenderSheet
          provider={editSender.provider}
          sender={editSender.sender}
          onClose={() => setEditSender(null)}
          onSaved={async () => {
            setEditSender(null);
            await load();
          }}
        />
      )}
    </KeyboardAwareScrollView>
  );
}

function toInput(p: SmsProvider): ProviderInput {
  return {
    name: p.name,
    send_url: p.send_url,
    method: p.method,
    balance_url: p.balance_url,
    number_format: p.number_format,
    success_match: p.success_match,
    is_active: p.is_active,
  };
}

function NumberRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Text style={styles.text}>{label}</Text>
        {hint && <Text style={ui.muted}>{hint}</Text>}
      </View>
      <TextInput
        value={String(value || '')}
        onChangeText={(t) => onChange(Number(t.replace(/\D/g, '')) || 0)}
        keyboardType="number-pad"
        style={[styles.input, styles.small]}
      />
    </View>
  );
}

function RuleCard({
  title,
  hint,
  rule,
  roles,
  users,
  onChange,
}: {
  title: string;
  hint: string;
  rule: SmsRule;
  roles: { key: string; name: string }[];
  users: AssignableUser[];
  onChange: (r: SmsRule) => void;
}) {
  const toggle = (key: 'roles' | 'user_ids', v: string) =>
    onChange({ ...rule, [key]: rule[key].includes(v) ? rule[key].filter((x) => x !== v) : [...rule[key], v] });
  return (
    <View style={ui.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={ui.muted}>{hint}</Text>
      <View style={styles.switchRow}>
        <Text style={[styles.flex, styles.text]}>Everyone</Text>
        <Switch value={rule.all} onValueChange={(v) => onChange({ ...rule, all: v })} />
      </View>
      {!rule.all && (
        <>
          <Text style={ui.label}>ROLES</Text>
          <View style={ui.chips}>
            {roles.map((r) => (
              <Chip key={r.key} text={r.name} on={rule.roles.includes(r.key)} onPress={() => toggle('roles', r.key)} />
            ))}
          </View>
          <Text style={ui.label}>AND THESE PEOPLE</Text>
          <View style={ui.chips}>
            {users.map((u) => (
              <Chip
                key={u.id}
                text={u.full_name ?? 'No name'}
                on={rule.user_ids.includes(u.id)}
                onPress={() => toggle('user_ids', u.id)}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function Field({ label, hint, ...rest }: { label: string; hint?: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={ui.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.textMuted} autoCapitalize="none" style={styles.input} {...rest} />
      {hint && <Text style={ui.muted}>{hint}</Text>}
    </View>
  );
}

function ProviderSheet({
  provider,
  onClose,
  onSaved,
}: {
  provider: SmsProvider | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [v, setV] = useState<ProviderInput>(
    provider
      ? toInput(provider)
      : {
          name: '',
          send_url: '',
          method: 'GET',
          balance_url: null,
          number_format: '0',
          success_match: null,
          is_active: false,
        },
  );
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveProvider(provider?.id ?? null, { ...v, ...(key.trim() ? { api_key: key.trim() } : {}) });
      await onSaved();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={provider ? `Edit ${provider.name}` : 'New SMS company'} onClose={onClose}>
      <Field
        label="NAME"
        value={v.name}
        onChangeText={(t) => setV({ ...v, name: t })}
        placeholder="e.g. Bulk SMS Dhaka"
      />
      <Field
        label="SEND ADDRESS (API URL)"
        value={v.send_url}
        onChangeText={(t) => setV({ ...v, send_url: t.trim() })}
        placeholder="https://…/sendtext?apikey={api_key}&callerID={sender_id}&number={number}&message={message}"
        multiline
        hint="Write {api_key} {sender_id} {number} {message} where the company wants them. The app fills them in."
      />
      <Text style={ui.label}>METHOD</Text>
      <View style={ui.chips}>
        {(['GET', 'POST'] as const).map((m) => (
          <Chip key={m} text={m} on={v.method === m} onPress={() => setV({ ...v, method: m })} />
        ))}
      </View>
      <Field
        label="API KEY"
        value={key}
        onChangeText={setKey}
        secureTextEntry
        placeholder={provider?.key_set ? `Saved (${provider.key_hint}). Type to change.` : 'Paste the API key'}
        hint="Kept on the server only. Nobody can see it in the app again."
      />
      <Field
        label="BALANCE ADDRESS (OPTIONAL)"
        value={v.balance_url ?? ''}
        onChangeText={(t) => setV({ ...v, balance_url: t.trim() || null })}
        placeholder="https://…/getBalance?apikey={api_key}"
      />
      <Text style={ui.label}>THE NUMBER IS WRITTEN AS</Text>
      <View style={ui.chips}>
        {FORMATS.map((f) => (
          <Chip
            key={f.key}
            text={f.label}
            on={v.number_format === f.key}
            onPress={() => setV({ ...v, number_format: f.key })}
          />
        ))}
      </View>
      <Field
        label="“SENT” WHEN THE ANSWER HAS (OPTIONAL)"
        value={v.success_match ?? ''}
        onChangeText={(t) => setV({ ...v, success_match: t || null })}
        placeholder='e.g. success   or   "code":\s*"?(200|1000)'
        hint="Empty: any OK answer (HTTP 2xx) counts as sent. Send a test SMS to see the company's answer, then write a word only a good answer has."
      />
      <View style={styles.switchRow}>
        <Text style={[styles.flex, styles.text]}>In use (sends all SMS)</Text>
        <Switch value={v.is_active} onValueChange={(x) => setV({ ...v, is_active: x })} />
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title="Save" onPress={save} loading={busy} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

function SenderSheet({
  provider,
  sender,
  onClose,
  onSaved,
}: {
  provider: SmsProvider;
  sender: SmsSender | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [sid, setSid] = useState(sender?.sender_id ?? '');
  const [kind, setKind] = useState<SenderKind>(sender?.kind ?? 'masking');
  const [label, setLabel] = useState(sender?.label ?? '');
  const [on, setOn] = useState(sender?.is_active ?? true);
  const [def, setDef] = useState(sender?.is_default ?? !provider.senders.some((s) => s.is_default));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveSender(sender?.id ?? null, {
        provider_id: provider.id,
        sender_id: sid,
        kind,
        label: label || null,
        is_active: on,
        is_default: def,
      });
      await onSaved();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const remove = () =>
    ask('Delete this sender ID?', sid, 'Delete', async () => {
      try {
        await deleteSender(sender!.id);
        await onSaved();
      } catch (e) {
        setError(errText(e));
      }
    });
  return (
    <Sheet title={sender ? 'Edit sender ID' : `New sender ID · ${provider.name}`} onClose={onClose}>
      <Text style={ui.label}>TYPE</Text>
      <View style={ui.chips}>
        {(['masking', 'non_masking'] as const).map((k) => (
          <Chip key={k} text={KIND_LABEL[k]} on={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <Text style={ui.muted}>
        {kind === 'masking'
          ? 'Masking: your name shows as the sender (e.g. ITTC). At most 11 letters; approved by the company.'
          : 'Non-masking: a number shows as the sender (e.g. 8809612345678).'}
      </Text>
      <Field
        label="SENDER ID"
        value={sid}
        onChangeText={setSid}
        placeholder={kind === 'masking' ? 'e.g. ITTC' : 'e.g. 8809612345678'}
        maxLength={kind === 'masking' ? 11 : 20}
      />
      <Field label="NOTE (OPTIONAL)" value={label} onChangeText={setLabel} placeholder="e.g. For notices" />
      <View style={styles.switchRow}>
        <Text style={[styles.flex, styles.text]}>Active</Text>
        <Switch value={on} onValueChange={setOn} />
      </View>
      <View style={styles.switchRow}>
        <Text style={[styles.flex, styles.text]}>Default {KIND_LABEL[kind].toLowerCase()} sender</Text>
        <Switch value={def && on} onValueChange={setDef} disabled={!on} />
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        {sender && <Button title="Delete" variant="danger" onPress={remove} />}
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title="Save" onPress={save} loading={busy} disabled={!sid.trim()} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

const BOX_LABEL: Record<string, string> = {
  'leads.phone': 'Leads · Phone',
  'leads.alt_phone': 'Leads · Alt phone',
  'alumni.phone': 'Alumni · Phone',
  'lead_bank.phone': 'Lead Bank',
};

// 📞 Numbers that get no SMS (old data; nothing is changed here)
function NumbersCard() {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<PhoneReport | null>(null);
  const load = async () => {
    setBusy(true);
    try {
      setR(await phoneFormatReport());
    } catch (e) {
      say('Could not check', errText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (box: string, id: string) => {
    if (box.startsWith('leads.')) router.push(`/leads/${id}` as Href);
    else if (box.startsWith('alumni.')) router.push(`/alumni/${id}` as Href);
  };
  return (
    <View style={ui.card}>
      <Text style={styles.title}>📞 Number check</Text>
      <Text style={ui.muted}>
        Numbers written any way (Bangla digits, +880, 0088, two numbers in one box…) are read the same now. This lists
        the saved numbers that still get no SMS. Nothing is changed.
      </Text>
      <Button title={r ? '↻ Check again' : 'Check the numbers'} variant="secondary" onPress={load} loading={busy} />
      {r && (
        <>
          {r.boxes.map((b) => (
            <View key={b.box} style={styles.senderRow}>
              <Text style={[styles.text, styles.flex]}>{BOX_LABEL[b.box] ?? b.box}</Text>
              <Text style={ui.muted}>
                ✅ {b.ok}
                {b.can_fix ? ` · 🔧 ${b.can_fix} can be fixed` : ''}
                {b.cannot_fix ? ` · ❌ ${b.cannot_fix} wrong` : ''}
                {b.two_numbers ? ` · 👥 ${b.two_numbers} two numbers` : ''}
              </Text>
            </View>
          ))}
          {r.can_fix_sample.length > 0 && (
            <>
              <Text style={ui.label}>🔧 CAN BE FIXED (ASK TO FIX THEM ALL AT ONCE)</Text>
              {r.can_fix_sample.slice(0, 30).map((x) => (
                <Tap2 key={x.box + x.id} onPress={() => open(x.box, x.id)}>
                  <Text style={styles.text} numberOfLines={1}>
                    {x.name}
                  </Text>
                  <Text style={ui.muted} numberOfLines={2}>
                    {x.now} → {x.would_be}
                    {x.second ? ` (+ ${x.second})` : ''}
                  </Text>
                </Tap2>
              ))}
            </>
          )}
          {r.cannot_fix_sample.length > 0 && (
            <>
              <Text style={ui.label}>❌ WRONG — FIX BY HAND (TAP TO OPEN)</Text>
              {r.cannot_fix_sample.slice(0, 30).map((x) => (
                <Tap2 key={x.box + x.id} onPress={() => open(x.box, x.id)}>
                  <Text style={styles.text} numberOfLines={1}>
                    {x.name} · {BOX_LABEL[x.box] ?? x.box}
                  </Text>
                  <Text style={ui.muted} numberOfLines={1}>
                    {x.now} — {x.why}
                  </Text>
                </Tap2>
              ))}
            </>
          )}
          {r.can_fix_sample.length === 0 && r.cannot_fix_sample.length === 0 && (
            <Text style={ui.muted}>All saved numbers are good mobile numbers. 🎉</Text>
          )}
        </>
      )}
    </View>
  );
}

function Tap2({ onPress, children }: { onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.reportRow, pressed && { opacity: 0.6 }]}>
      {children}
    </Pressable>
  );
}

function TestCard({ provider }: { provider: SmsProvider }) {
  const senders = provider.senders.filter((s) => s.is_active);
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState('Test SMS from ITTC');
  const [sender, setSender] = useState(senders.find((s) => s.is_default)?.id ?? senders[0]?.id ?? '');
  const [busy, setBusy] = useState<'test' | 'balance' | null>(null);
  const [result, setResult] = useState<SmsBatchDetail | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const len = smsLength(msg);

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      setResult(await sendTest(phone, msg, sender));
    } catch (e) {
      say('Could not send', errText(e));
    } finally {
      setBusy(null);
    }
  };
  const bal = async () => {
    setBusy('balance');
    setBalance(null);
    try {
      const r = await checkBalance();
      setBalance(r.error ? `⚠️ ${r.error}` : `HTTP ${r.status ?? '?'}\n${r.body ?? ''}`);
    } catch (e) {
      setBalance(`⚠️ ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const m = result?.messages[0];

  return (
    <View style={ui.card}>
      <Text style={styles.title}>🧪 Test · {provider.name}</Text>
      {senders.length === 0 ? (
        <Text style={ui.muted}>Add an active sender ID first.</Text>
      ) : (
        <>
          <Field
            label="YOUR MOBILE"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="01XXXXXXXXX"
          />
          <Field
            label={`MESSAGE · ${len.chars} letters · ${len.parts} SMS`}
            value={msg}
            onChangeText={setMsg}
            multiline
          />
          <Text style={ui.label}>SENDER</Text>
          <View style={ui.chips}>
            {senders.map((s) => (
              <Chip
                key={s.id}
                text={`${s.sender_id} · ${KIND_LABEL[s.kind]}`}
                on={sender === s.id}
                onPress={() => setSender(s.id)}
              />
            ))}
          </View>
          <Button
            title="Send a test SMS"
            onPress={test}
            loading={busy === 'test'}
            disabled={!phone.trim() || !sender}
          />
          {m && (
            <View style={styles.result}>
              <Text style={styles.text}>
                {m.status === 'sent' ? '✅' : m.status === 'failed' ? '❌' : '⏳'} {STATUS_LABEL[m.status]}
                {m.error ? ` · ${m.error}` : ''}
              </Text>
              {m.response && <Text style={styles.mono}>Company’s answer: {m.response}</Text>}
              {m.status !== 'sent' && m.status !== 'failed' && (
                <Text style={ui.muted}>The answer comes within a minute; see “SMS sent so far”.</Text>
              )}
            </View>
          )}
        </>
      )}
      {provider.balance_url && (
        <>
          <Button title="💰 Check balance" variant="secondary" onPress={bal} loading={busy === 'balance'} />
          {balance && <Text style={styles.mono}>{balance}</Text>}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  codes: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  codeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeText: { fontSize: fontSize.body, color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  codeRemove: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 80,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  flex: { flex: 1 },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.body, color: colors.text },
  section: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
    color: colors.primary,
    marginTop: spacing.sm,
  },
  mono: {
    fontSize: fontSize.small,
    color: colors.textMuted,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTop: { flexDirection: 'row', gap: spacing.md },
  buttons: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  reportRow: { gap: 2, paddingVertical: 6 },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  activeCard: { borderWidth: 2, borderColor: colors.primary },
  field: { gap: 4 },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
    backgroundColor: colors.background,
  },
  small: { width: 90, textAlign: 'center' },
  banner: { padding: spacing.md, borderRadius: radius.md, gap: 4 },
  bannerOk: { backgroundColor: colors.successSoft },
  bannerWarn: { backgroundColor: colors.warningSoft },
  bannerText: { fontSize: fontSize.small, color: colors.text },
  result: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
});

/**
 * 📲 The phone reads the code SMS by itself only when the SMS ends with the
 * app's code. The code differs for the Play Store app and an APK installed
 * by hand, so an admin allows each one here from a phone with that app.
 * (Only allowed codes are used: another app's code would let it read the SMS.)
 */
function AppCodes({ settings, set }: { settings: SmsSettings; set: (s: SmsSettings) => void }) {
  const mine = smsAppHash();
  const list = settings.otp_app_hashes ?? [];
  const save = (next: string[]) => set({ ...settings, otp_app_hashes: next });
  return (
    <View style={styles.codes}>
      <Text style={styles.title}>📲 Code read by the phone itself</Text>
      <Text style={ui.muted}>
        Android fills in the code by itself only for the app codes allowed here. Open this page once on a phone with the
        Play Store app (and once with the APK, if you use one) and tap Allow. Without it, the keyboard still offers the
        code in one tap.
      </Text>
      {list.map((h) => (
        <View key={h} style={styles.codeRow}>
          <Text style={styles.codeText}>
            {h}
            {h === mine ? '  (this phone)' : ''}
          </Text>
          <Pressable onPress={() => save(list.filter((x) => x !== h))} hitSlop={8} accessibilityRole="button">
            <Text style={styles.codeRemove}>Remove</Text>
          </Pressable>
        </View>
      ))}
      {!!mine && !list.includes(mine) && (
        <Button title={`Allow this phone's app (${mine})`} variant="secondary" onPress={() => save([...list, mine])} />
      )}
      {!mine && list.length === 0 && (
        <Text style={ui.muted}>Open this page on an Android phone with app 2.8.6 or newer to allow it.</Text>
      )}
    </View>
  );
}
