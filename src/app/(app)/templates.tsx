import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView, KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { listCourses } from '@/features/settings/api';
import {
  CATEGORIES,
  DEFAULT_TEMPLATE_SETTINGS,
  VARIABLES,
  canUseTemplates,
  deleteTemplate,
  fillTemplate,
  getTemplateSettings,
  listTemplates,
  saveTemplate,
  saveTemplateSettings,
  type MessageTemplate,
  type TemplateInput,
  type TemplateSettings,
} from '@/features/templates/api';
import { forgetTemplateSettings } from '@/features/templates/useTemplateAccess';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💬 Message templates
//   Admins: the settings (on / off, who, the button, institute details)
//   and every template. Everyone else: shared templates (read only) and
//   their own personal ones.
// =====================================================================

const WA = '#1F7A57';

const ROLES = [
  { key: 'admin', label: 'Admins' },
  { key: 'team_lead', label: 'Team Leads' },
  { key: 'caller', label: 'Callers' },
];

const CHANNELS: { value: TemplateInput['channels']; label: string }[] = [
  { value: 'both', label: 'WhatsApp + SMS' },
  { value: 'whatsapp', label: '💬 WhatsApp' },
  { value: 'sms', label: '✉️ SMS' },
];

export default function TemplatesScreen() {
  const { hasPermission, profile } = useAuth();
  const isAdmin = hasPermission('settings.manage');

  const [settings, setSettings] = useState<TemplateSettings>(DEFAULT_TEMPLATE_SETTINGS);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [editing, setEditing] = useState<MessageTemplate | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t, c, u] = await Promise.all([
        getTemplateSettings(),
        listTemplates(),
        listCourses().catch(() => []),
        isAdmin ? listAssignableUsers().catch(() => []) : Promise.resolve([]),
      ]);
      setSettings(s);
      setTemplates(t);
      setCourses(c.map((x) => ({ id: x.id, name: x.name })));
      setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const set = <K extends keyof TemplateSettings>(key: K, value: TemplateSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
  };
  const toggleWho = (key: 'roles' | 'user_ids', value: string) =>
    set('who', {
      ...settings.who,
      [key]: settings.who[key].includes(value)
        ? settings.who[key].filter((v) => v !== value)
        : [...settings.who[key], value],
    });

  const saveSettings = async () => {
    const { who } = settings;
    if (who.mode === 'roles' && who.roles.length === 0) return setError('Choose at least one role.');
    if (who.mode === 'users' && who.user_ids.length === 0) return setError('Choose at least one person.');
    setSavingSettings(true);
    setError(null);
    try {
      await saveTemplateSettings(settings);
      forgetTemplateSettings();
      setDirty(false);
      Alert.alert('Saved', 'Template settings are saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSavingSettings(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Message templates' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const allowed = canUseTemplates(settings, profile);
  const shared = templates.filter((t) => t.is_shared);
  const mine = templates.filter((t) => !t.is_shared);
  const canEdit = (t: MessageTemplate) => isAdmin || (!t.is_shared && t.owner_id === profile?.id);

  return (
    <>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: 'Message templates' }} />

        {!isAdmin && !allowed && (
          <View style={styles.offBox}>
            <Text style={styles.offText}>Message templates are turned off for you. Ask an admin.</Text>
          </View>
        )}

        {/* ⚙️ Settings (admins) */}
        {isAdmin && (
          <>
            <Text style={styles.sectionLabel}>SETTINGS</Text>
            <View style={styles.card}>
              <View style={styles.switchRow}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>Message templates</Text>
                  <Text style={styles.rowText}>
                    {settings.enabled
                      ? 'On. WhatsApp / SMS buttons can send a ready-made message.'
                      : 'Off for everyone. The buttons just open the chat.'}
                  </Text>
                </View>
                <Switch value={settings.enabled} onValueChange={(v) => set('enabled', v)} />
              </View>

              {settings.enabled && (
                <>
                  <View style={styles.divider} />
                  <Text style={styles.label}>WHO CAN USE THEM</Text>
                  <View style={styles.chips}>
                    {(
                      [
                        ['all', 'Everyone'],
                        ['roles', 'Some roles'],
                        ['users', 'Some people'],
                      ] as const
                    ).map(([m, label]) => (
                      <Chip
                        key={m}
                        text={label}
                        on={settings.who.mode === m}
                        onPress={() => set('who', { ...settings.who, mode: m })}
                      />
                    ))}
                  </View>
                  {settings.who.mode === 'roles' && (
                    <View style={styles.chips}>
                      {ROLES.map((r) => (
                        <Chip
                          key={r.key}
                          text={r.label}
                          on={settings.who.roles.includes(r.key)}
                          onPress={() => toggleWho('roles', r.key)}
                        />
                      ))}
                    </View>
                  )}
                  {settings.who.mode === 'users' && (
                    <View style={styles.chips}>
                      {users.map((u) => (
                        <Chip
                          key={u.id}
                          text={u.full_name ?? 'No name'}
                          on={settings.who.user_ids.includes(u.id)}
                          onPress={() => toggleWho('user_ids', u.id)}
                        />
                      ))}
                    </View>
                  )}

                  <View style={styles.divider} />
                  <Text style={styles.label}>THE WHATSAPP / SMS BUTTON</Text>
                  <View style={styles.chips}>
                    <Chip text="Tap → templates" on={settings.tap === 'sheet'} onPress={() => set('tap', 'sheet')} />
                    <Chip
                      text="Tap → chat, hold → templates"
                      on={settings.tap === 'long_press'}
                      onPress={() => set('tap', 'long_press')}
                    />
                  </View>
                  <Text style={styles.hint}>
                    {settings.tap === 'sheet'
                      ? 'Tapping opens the templates; “Open chat” there opens an empty chat.'
                      : 'Tapping opens an empty chat as before; press and hold for templates.'}
                  </Text>
                </>
              )}
            </View>

            <Text style={styles.sectionLabel}>INSTITUTE DETAILS (for templates)</Text>
            <View style={styles.card}>
              <Field label="Name {institute}" value={settings.institute.name} onChange={(v) => set('institute', { ...settings.institute, name: v })} />
              <Field label="Address {address}" multiline value={settings.institute.address} onChange={(v) => set('institute', { ...settings.institute, address: v })} />
              <Field label="Google Maps link {map_link}" value={settings.institute.map_link} onChange={(v) => set('institute', { ...settings.institute, map_link: v })} />
              <Field label="Office phone {office_phone}" value={settings.institute.phone} onChange={(v) => set('institute', { ...settings.institute, phone: v })} />
            </View>

            {error && <Text style={styles.error}>{error}</Text>}
            <Button title="Save settings" onPress={saveSettings} loading={savingSettings} disabled={!dirty} fullWidth />
          </>
        )}

        {/* 📋 Templates */}
        <View style={styles.listHead}>
          <Text style={styles.sectionLabel}>SHARED TEMPLATES</Text>
          {isAdmin && (
            <Pressable onPress={() => setEditing('new')} hitSlop={8} accessibilityRole="button">
              <Text style={styles.add}>＋ New</Text>
            </Pressable>
          )}
        </View>
        {shared.length === 0 ? (
          <Text style={styles.hint}>No shared templates yet.</Text>
        ) : (
          shared.map((t) => (
            <TemplateRow key={t.id} t={t} editable={canEdit(t)} onPress={() => canEdit(t) && setEditing(t)} />
          ))
        )}

        <View style={styles.listHead}>
          <Text style={styles.sectionLabel}>MY TEMPLATES</Text>
          {(allowed || isAdmin) && (
            <Pressable onPress={() => setEditing('new')} hitSlop={8} accessibilityRole="button">
              <Text style={styles.add}>＋ New</Text>
            </Pressable>
          )}
        </View>
        {mine.length === 0 ? (
          <Text style={styles.hint}>Your own templates show only to you.</Text>
        ) : (
          mine.map((t) => <TemplateRow key={t.id} t={t} editable={canEdit(t)} onPress={() => setEditing(t)} />)
        )}
      </ScrollView>

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          isAdmin={isAdmin}
          courses={courses}
          settings={settings}
          myName={profile?.full_name ?? ''}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

// =====================================================================
// One template in the list
// =====================================================================
function TemplateRow({ t, editable, onPress }: { t: MessageTemplate; editable: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!editable}
      style={({ pressed }) => [styles.tRow, !t.is_active && styles.tRowOff, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <View style={styles.flex}>
        <Text style={styles.tName} numberOfLines={1}>
          {t.name}
          {!t.is_active && <Text style={styles.tMeta}>  · off</Text>}
        </Text>
        <Text style={styles.tBody} numberOfLines={2}>
          {t.body}
        </Text>
        <Text style={styles.tMeta}>
          {[t.category, t.channels === 'both' ? 'WhatsApp + SMS' : t.channels === 'whatsapp' ? 'WhatsApp' : 'SMS', t.use_count ? `used ${t.use_count}×` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {editable && <Text style={styles.chevron}>›</Text>}
    </Pressable>
  );
}

// =====================================================================
// Add / change a template
// =====================================================================
function TemplateEditor({
  template,
  isAdmin,
  courses,
  settings,
  myName,
  onClose,
  onSaved,
}: {
  template: MessageTemplate | null;
  isAdmin: boolean;
  courses: { id: string; name: string }[];
  settings: TemplateSettings;
  myName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TemplateInput>({
    name: template?.name ?? '',
    body: template?.body ?? '',
    channels: template?.channels ?? 'both',
    category: template?.category ?? null,
    course_ids: template?.course_ids ?? null,
    is_shared: template?.is_shared ?? isAdmin,
    is_active: template?.is_active ?? true,
  });
  const [cursor, setCursor] = useState(form.body.length);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof TemplateInput>(k: K, v: TemplateInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const insert = (key: string) => {
    const tag = `{${key}}`;
    const at = Math.min(cursor, form.body.length);
    set('body', form.body.slice(0, at) + tag + form.body.slice(at));
    setCursor(at + tag.length);
  };

  // A sample lead for the preview
  const sample = fillTemplate(form.body, {
    name: 'Rahim Uddin',
    first_name: 'Rahim',
    course: courses[0]?.name ?? 'BBA',
    batch: 'Spring 2027',
    batch_start: '5 Jan 2027',
    fee: '• Admission fee: ৳5,000\n• Tuition: ৳45,000\nমোট: ৳50,000',
    visit_time: '2 Nov 2026, 11:00 am',
    next_call: '1 Nov 2026, 4:00 pm',
    papers_missing: '• SSC certificate\n• Birth certificate',
    student_id: 'ADM-2026-0012',
    my_name: myName,
    my_phone: '01711-000000',
    institute: settings.institute.name || 'Your institute',
    address: settings.institute.address || 'Address',
    map_link: settings.institute.map_link || 'https://maps.google.com/…',
    office_phone: settings.institute.phone || '0XXXXXXXXXX',
    today: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
  }).text;

  const save = async () => {
    if (!form.name.trim()) return setError('Please give the template a name.');
    if (!form.body.trim()) return setError('Please write the message.');
    setSaving(true);
    setError(null);
    try {
      await saveTemplate(template?.id ?? null, form);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!template) return;
    Alert.alert('Delete this template?', template.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          deleteTemplate(template.id)
            .then(onSaved)
            .catch((e) => Alert.alert('Could not delete', e instanceof Error ? e.message : '')),
      },
    ]);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={styles.editorHead}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.editorTitle}>{template ? 'Edit template' : 'New template'}</Text>
          <View style={styles.headSpacer} />
        </View>

        <KeyboardAwareScrollView
          bottomOffset={spacing.xl}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="Name" value={form.name} onChange={(v) => set('name', v)} />

          <Text style={styles.label}>MESSAGE</Text>
          <TextInput
            value={form.body}
            onChangeText={(v) => set('body', v)}
            onSelectionChange={(e) => setCursor(e.nativeEvent.selection.start)}
            multiline
            style={styles.editor}
            textAlignVertical="top"
            placeholder="আসসালামু আলাইকুম {first_name}, …"
            placeholderTextColor={colors.textMuted}
          />
          <Text style={styles.hint}>Tap to put in the lead’s details:</Text>
          <View style={styles.chips}>
            {VARIABLES.map((v) => (
              <Pressable key={v.key} onPress={() => insert(v.key)} style={styles.varChip} accessibilityRole="button">
                <Text style={styles.varText}>{v.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>PREVIEW (a sample lead)</Text>
          <View style={styles.preview}>
            <Text style={styles.previewText}>{sample || '…'}</Text>
          </View>

          <Text style={styles.label}>SEND BY</Text>
          <View style={styles.chips}>
            {CHANNELS.map((c) => (
              <Chip key={c.value} text={c.label} on={form.channels === c.value} onPress={() => set('channels', c.value)} />
            ))}
          </View>

          <Text style={styles.label}>CATEGORY</Text>
          <View style={styles.chips}>
            {CATEGORIES.map((c) => (
              <Chip key={c} text={c} on={form.category === c} onPress={() => set('category', form.category === c ? null : c)} />
            ))}
          </View>

          {courses.length > 0 && (
            <>
              <Text style={styles.label}>ONLY FOR THESE COURSES (none = all)</Text>
              <View style={styles.chips}>
                {courses.map((c) => {
                  const on = (form.course_ids ?? []).includes(c.id);
                  return (
                    <Chip
                      key={c.id}
                      text={c.name}
                      on={on}
                      onPress={() =>
                        set(
                          'course_ids',
                          on ? (form.course_ids ?? []).filter((x) => x !== c.id) : [...(form.course_ids ?? []), c.id],
                        )
                      }
                    />
                  );
                })}
              </View>
            </>
          )}

          {isAdmin && (
            <View style={styles.switchRow}>
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>Shared with everyone</Text>
                <Text style={styles.rowText}>Off = only you see it.</Text>
              </View>
              <Switch value={form.is_shared} onValueChange={(v) => set('is_shared', v)} />
            </View>
          )}
          <View style={styles.switchRow}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>In use</Text>
              <Text style={styles.rowText}>Off = kept here but not shown when sending.</Text>
            </View>
            <Switch value={form.is_active} onValueChange={(v) => set('is_active', v)} />
          </View>

          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="Save template" onPress={save} loading={saving} fullWidth />
          {template && <Button title="Delete template" variant="ghost" onPress={remove} fullWidth />}
        </KeyboardAwareScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        style={[styles.input, multiline && styles.inputMulti]}
        placeholderTextColor={colors.textMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sectionLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  rowText: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  error: { fontSize: fontSize.small, color: colors.danger },
  offBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.warning + '22' },
  offText: { fontSize: fontSize.small, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: WA, borderColor: WA },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  add: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: WA },
  tRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tRowOff: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
  tName: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  tBody: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  tMeta: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 22, color: colors.textMuted },
  editorHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  editorTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  cancel: { fontSize: fontSize.body, color: colors.primary },
  headSpacer: { width: 52 },
  editor: {
    minHeight: 160,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    lineHeight: 22,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  varChip: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  varText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },
  preview: { padding: spacing.md, borderRadius: radius.md, backgroundColor: '#DCF8C6' },
  previewText: { fontSize: fontSize.body, lineHeight: 22, color: '#111B21' },
  field: { gap: 4 },
  fieldLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  input: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMulti: { minHeight: 70, paddingVertical: spacing.sm, textAlignVertical: 'top' },
});
