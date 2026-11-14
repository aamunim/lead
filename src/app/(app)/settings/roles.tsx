import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  ACTS_AS,
  PERMISSIONS,
  deleteRole,
  forgetRoleChoices,
  listRolesFull,
  saveRole,
  type ActsAs,
  type Role,
} from '@/features/roles/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';
import { SheetScroll } from '@/shared/ui/SheetScroll';

// =====================================================================
// 👥 Settings → Roles (the Super Admin only)
//   The roles, how many people each has; ➕ a new role (or a copy of one):
//   its name, what it works like, its permissions and its courses.
//   The Super Admin role stays as it is; the first four can't be removed.
// =====================================================================

type Course = { id: string; name: string };
type Draft = {
  key: string | null;
  name: string;
  description: string;
  actsAs: ActsAs;
  permissions: string[];
  /** null = every course */
  courseIds: string[] | null;
  isSystem: boolean;
};

export default function RolesScreen() {
  const { profile } = useAuth();
  const superAdmin = profile?.role_key === 'super_admin';
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        listRolesFull(),
        // alumni courses are seen by everyone: not part of course access
        supabase
          .from('courses')
          .select('id, name')
          .eq('is_alumni' as never, false as never)
          .order('sort_order')
          .order('name'),
      ]);
      setRoles(r);
      setCourses(c.data ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const courseText = (ids: string[] | null) =>
    !ids
      ? 'Every course'
      : ids
          .map((id) => courses.find((c) => c.id === id)?.name)
          .filter(Boolean)
          .join(', ') || 'No course';

  const open = (r: Role | null, copy = false) =>
    setDraft(
      r
        ? {
            key: copy ? null : r.key,
            name: copy ? `${r.name} (copy)` : r.name,
            description: r.description ?? '',
            actsAs: r.actsAs,
            permissions: r.permissions.filter((p) => p !== '*'),
            courseIds: r.courseIds,
            isSystem: copy ? false : r.isSystem,
          }
        : {
            key: null,
            name: '',
            description: '',
            actsAs: 'caller',
            permissions: ['leads.view_own', 'leads.edit_own'],
            courseIds: null,
            isSystem: false,
          },
    );

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Roles' }} />
      <Text style={styles.muted}>
        Each person has one role. A role says what they may do and which courses they see. Admins see every course.
      </Text>
      {!superAdmin && <Text style={styles.warn}>Only the Super Admin can change roles.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      {roles === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        roles.map((r) => (
          <View key={r.key} style={styles.card}>
            <View style={styles.row}>
              <View style={styles.flex}>
                <Text style={styles.name}>
                  {r.name} {r.isSystem ? <Text style={styles.small}>· first role</Text> : null}
                </Text>
                <Text style={styles.small}>
                  👤 {r.people} · works like {ACTS_AS.find((a) => a.key === r.actsAs)?.label ?? r.actsAs}
                </Text>
              </View>
              {superAdmin && r.key !== 'super_admin' && (
                <View style={styles.btns}>
                  <Pressable onPress={() => open(r)} hitSlop={6} accessibilityRole="button">
                    <Text style={styles.link}>Edit</Text>
                  </Pressable>
                  <Pressable onPress={() => open(r, true)} hitSlop={6} accessibilityRole="button">
                    <Text style={styles.link}>Copy</Text>
                  </Pressable>
                </View>
              )}
            </View>
            {!!r.description && <Text style={styles.desc}>{r.description}</Text>}
            <Text style={styles.small}>
              🎓{' '}
              {r.permissions.includes('*') || r.permissions.includes('settings.manage')
                ? 'Every course'
                : courseText(r.courseIds)}
            </Text>
            <Text style={styles.small} numberOfLines={2}>
              🔑{' '}
              {r.permissions.includes('*')
                ? 'Everything'
                : PERMISSIONS.flatMap((g) => g.items)
                    .filter((p) => r.permissions.includes(p.key))
                    .map((p) => p.label)
                    .join(' · ') || 'Nothing yet'}
            </Text>
          </View>
        ))
      )}
      {superAdmin && <Button title="➕ New role" onPress={() => open(null)} fullWidth />}

      {draft && (
        <RoleEditor
          draft={draft}
          courses={courses}
          onClose={() => setDraft(null)}
          onSaved={() => {
            forgetRoleChoices();
            setDraft(null);
            load();
          }}
        />
      )}
    </KeyboardAwareScrollView>
  );
}

function RoleEditor({
  draft,
  courses,
  onClose,
  onSaved,
}: {
  draft: Draft;
  courses: Course[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = d.permissions.includes('settings.manage');

  const toggle = (key: string) =>
    setD((x) => ({
      ...x,
      permissions: x.permissions.includes(key) ? x.permissions.filter((p) => p !== key) : [...x.permissions, key],
    }));
  const toggleCourse = (id: string) =>
    setD((x) => {
      const now = x.courseIds ?? [];
      return { ...x, courseIds: now.includes(id) ? now.filter((c) => c !== id) : [...now, id] };
    });

  const save = async () => {
    if (!d.name.trim()) return setError('Please give the role a name.');
    if (d.courseIds && d.courseIds.length === 0) return setError('Choose at least one course, or “Every course”.');
    setSaving(true);
    setError(null);
    try {
      await saveRole(d);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!d.key) return;
    Alert.alert('Remove this role?', `“${d.name}” goes. People must have another role first.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRole(d.key as string);
            onSaved();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove.');
          }
        },
      },
    ]);
  };

  return (
    <Modal keyboard visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <SheetScroll contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>{d.key ? `✏️ ${draft.name}` : '➕ New role'}</Text>

            <Text style={styles.label}>NAME</Text>
            <TextInput
              value={d.name}
              onChangeText={(name) => setD({ ...d, name })}
              placeholder="e.g. Senior Caller"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
            <TextInput
              value={d.description}
              onChangeText={(description) => setD({ ...d, description })}
              placeholder="What this role is for (optional)"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />

            <Text style={styles.label}>WORKS LIKE</Text>
            {d.isSystem ? (
              <Text style={styles.small}>{ACTS_AS.find((a) => a.key === d.actsAs)?.label} (a first role)</Text>
            ) : (
              <View style={styles.chips}>
                {ACTS_AS.map((a) => (
                  <Chip
                    key={a.key}
                    text={a.label}
                    on={d.actsAs === a.key}
                    onPress={() => setD({ ...d, actsAs: a.key })}
                  />
                ))}
              </View>
            )}
            <Text style={styles.small}>
              {ACTS_AS.find((a) => a.key === d.actsAs)?.hint}. Teams, adding own leads and discount limits follow this.
            </Text>

            {PERMISSIONS.map((g) => (
              <View key={g.group} style={styles.group}>
                <Text style={styles.label}>{g.group.toUpperCase()}</Text>
                {g.items.map((p) => (
                  <Pressable
                    key={p.key}
                    onPress={() => toggle(p.key)}
                    style={styles.check}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: d.permissions.includes(p.key) }}
                  >
                    <Text style={styles.box}>{d.permissions.includes(p.key) ? '☑' : '☐'}</Text>
                    <Text style={styles.checkText}>{p.label}</Text>
                  </Pressable>
                ))}
              </View>
            ))}

            <Text style={styles.label}>🎓 COURSES THIS ROLE SEES</Text>
            {admin ? (
              <Text style={styles.small}>With Settings, it sees every course.</Text>
            ) : (
              <>
                <View style={styles.chips}>
                  <Chip text="Every course" on={d.courseIds === null} onPress={() => setD({ ...d, courseIds: null })} />
                  <Chip
                    text="Only some"
                    on={d.courseIds !== null}
                    onPress={() => setD({ ...d, courseIds: d.courseIds ?? [] })}
                  />
                </View>
                {d.courseIds !== null && (
                  <View style={styles.chips}>
                    {courses.map((c) => (
                      <Chip
                        key={c.id}
                        text={c.name}
                        on={(d.courseIds ?? []).includes(c.id)}
                        onPress={() => toggleCourse(c.id)}
                      />
                    ))}
                  </View>
                )}
                <Text style={styles.small}>
                  Leads and students of other courses are hidden from this role. Leads with no course are seen by admins
                  only. One person can have their own courses (Users → the person).
                </Text>
              </>
            )}

            {error && <Text style={styles.error}>{error}</Text>}
            <Button title="Save" onPress={save} loading={saving} fullWidth />
            {!!d.key && !d.isSystem && <Button title="Remove this role" variant="ghost" onPress={remove} fullWidth />}
          </SheetScroll>
        </View>
      </View>
    </Modal>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  warn: { fontSize: fontSize.small, color: colors.warning, fontWeight: fontWeight.semibold },
  error: { fontSize: fontSize.small, color: colors.danger },
  card: {
    gap: 4,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  desc: { fontSize: fontSize.small, color: colors.text },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  btns: { flexDirection: 'row', gap: spacing.md },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '92%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  sheetContent: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  input: {
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.background,
    fontSize: fontSize.body,
  },
  group: { gap: 2 },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5 },
  box: { fontSize: 18, color: colors.primary },
  checkText: { fontSize: fontSize.body, color: colors.text },
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
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
});
