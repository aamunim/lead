import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers } from '@/features/leads/api';
import {
  getUser,
  listRoles,
  listTeamLeads,
  updateUser,
  type RoleOption,
  type TeamLeadOption,
  type UserRow,
} from '@/features/users/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';
import { ResetPasswordSheet } from '@/features/users/ResetPasswordSheet';

type Form = {
  fullName: string;
  phone: string;
  roleKey: string;
  teamLeadId: string | null;
};

export default function UserEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile: me, assignment } = useAuth();

  const [user, setUser] = useState<UserRow | null>(null);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [teamLeads, setTeamLeads] = useState<TeamLeadOption[]>([]);
  const [teamSize, setTeamSize] = useState(0); // active Callers led by this user

  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 🔑 Reset password sheet
  const [resetting, setResetting] = useState(false);

  // --- load the user and the options together -----------------------
  const load = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const [u, r, t, team] = await Promise.all([
        getUser(id),
        listRoles(),
        listTeamLeads(),
        listAssignableUsers({ teamLeadId: id }).catch(() => []),
      ]);
      setUser(u);
      setRoles(r);
      setTeamLeads(t.filter((lead) => lead.id !== id)); // nobody leads themselves
      setTeamSize(team.filter((p) => p.id !== id).length);
      if (u) {
        setForm({
          fullName: u.full_name ?? '',
          phone: u.phone ?? '',
          roleKey: u.role_key,
          teamLeadId: u.team_lead_id,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this user.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // --- what the signed-in admin is allowed to do here ---------------
  const isSelf = me?.id === user?.id;
  const iAmSuperAdmin = me?.role_key === 'super_admin';
  const targetIsSuperAdmin = user?.role_key === 'super_admin';
  const readOnly = targetIsSuperAdmin && !iAmSuperAdmin;

  // Only a Super Admin may give the Super Admin role
  const roleOptions = useMemo(
    () => roles.filter((r) => r.key !== 'super_admin' || iAmSuperAdmin),
    [roles, iAmSuperAdmin],
  );

  const status: 'active' | 'pending' | 'deactivated' = user?.is_active
    ? 'active'
    : user?.deactivated_at
      ? 'deactivated'
      : 'pending';

  const showTeamLead = form?.roleKey === 'caller';

  // --- things to warn about -------------------------------------------
  const isAutoAssignUser =
    !!user && assignment.enabled && assignment.admin_auto && assignment.admin_auto_user_id === user.id;
  const leadsATeam = user?.role_key === 'team_lead' && teamSize > 0;

  // --- save ----------------------------------------------------------
  const save = async (activate?: boolean) => {
    if (!user || !form) return;

    setSaving(true);
    setError(null);
    try {
      await updateUser(user.id, {
        full_name: form.fullName.trim() || null,
        phone: form.phone.trim() || null,
        // Role and status are never sent for your own account
        ...(isSelf ? {} : { role_key: form.roleKey }),
        team_lead_id: form.roleKey === 'caller' ? form.teamLeadId : null,
        ...(activate !== undefined && !isSelf ? { is_active: activate } : {}),
      });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  // Changing a Team Lead's role leaves their Callers without a Team Lead
  const saveChanges = () => {
    if (!user || !form) return;
    const losingTeam = leadsATeam && form.roleKey !== 'team_lead';
    if (!losingTeam) {
      save();
      return;
    }
    Alert.alert(
      'This Team Lead has a team',
      `${teamSize} ${teamSize === 1 ? 'Caller is' : 'Callers are'} in ${user.full_name ?? 'this user'}'s team. ` +
        'After this change they will have no Team Lead until you set a new one on each Caller.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change role', style: 'destructive', onPress: () => save() },
      ],
    );
  };

  const confirmDeactivate = () => {
    const name = user?.full_name ?? 'This user';
    const warnings: string[] = [];
    if (isAutoAssignUser) {
      warnings.push(
        '• New leads added by admins are auto-assigned to this user. Those leads will stay Unassigned until you pick someone else in Settings → Lead assignment.',
      );
    }
    if (leadsATeam) {
      warnings.push(
        `• ${teamSize} ${teamSize === 1 ? 'Caller has' : 'Callers have'} this user as Team Lead. They will have no Team Lead until you set a new one.`,
      );
    }
    warnings.push(
      '• Their leads stay assigned to them. To move them: Leads → Filter → Assigned to → Mark all → Assign.',
    );

    Alert.alert(
      'Deactivate this user?',
      `${name} will no longer be able to use the app. Their history is kept, and you can reactivate them later.\n\n${warnings.join('\n\n')}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Deactivate', style: 'destructive', onPress: () => save(false) },
      ],
    );
  };

  // --- states --------------------------------------------------------
  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'User' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!user || !form) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'User' }} />
        <Text style={styles.sectionTitle}>User not found</Text>
        {error && <Text style={styles.muted}>{error}</Text>}
      </View>
    );
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const selectedRole = roles.find((r) => r.key === form.roleKey);

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: user.full_name || 'User' }} />

      {/* Summary */}
      <View style={styles.card}>
        <Text style={styles.name}>{user.full_name || 'No name'}</Text>
        <Text style={styles.muted}>{user.email}</Text>
        <View style={[styles.statusPill, { backgroundColor: STATUS[status].background }]}>
          <Text style={[styles.statusText, { color: STATUS[status].color }]}>
            {STATUS[status].label}
          </Text>
        </View>
        {isSelf && (
          <Text style={styles.note}>This is your account. You can’t change your own role or status.</Text>
        )}
        {readOnly && (
          <Text style={styles.note}>Only a Super Admin can change a Super Admin account.</Text>
        )}
        {isAutoAssignUser && (
          <Text style={styles.note}>New leads added by admins are auto-assigned to this user.</Text>
        )}
        {leadsATeam && (
          <Text style={styles.note}>
            Team Lead of {teamSize} {teamSize === 1 ? 'Caller' : 'Callers'}.
          </Text>
        )}
      </View>

      {/* Details */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Details</Text>
        <TextField
          label="Full name"
          value={form.fullName}
          onChangeText={(v) => set('fullName', v)}
          editable={!readOnly}
          autoCapitalize="words"
        />
        <TextField
          label="Phone"
          value={form.phone}
          onChangeText={(v) => set('phone', v)}
          editable={!readOnly}
          keyboardType="phone-pad"
        />
      </View>

      {/* Role */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Role</Text>
        <OptionChips
          options={roleOptions.map((r) => ({ value: r.key, label: r.name }))}
          value={form.roleKey}
          onChange={(v) => set('roleKey', v)}
          disabled={readOnly || isSelf}
        />
        {selectedRole?.description && <Text style={styles.muted}>{selectedRole.description}</Text>}
      </View>

      {/* Team Lead (only for callers) */}
      {showTeamLead && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Team Lead</Text>
          <OptionChips
            options={[
              { value: null, label: 'None' },
              ...teamLeads.map((t) => ({ value: t.id, label: t.full_name || 'No name' })),
            ]}
            value={form.teamLeadId}
            onChange={(v) => set('teamLeadId', v)}
            disabled={readOnly}
          />
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Actions depend on the user's status */}
      {!readOnly && (
        <View style={styles.actions}>
          {status === 'pending' && (
            <Button title="Approve and activate" onPress={() => save(true)} loading={saving} fullWidth />
          )}

          {status === 'active' && (
            <>
              <Button title="Save changes" onPress={saveChanges} loading={saving} fullWidth />
              <Button
                title="👁 View activity"
                variant="secondary"
                onPress={() => router.push(`/activity/${user.id}` as Href)}
                fullWidth
              />
              {/* 🔑 Admins reset others' passwords; their own: More → Change password */}
              {!isSelf && (
                <Button title="🔑 Reset password" variant="secondary" onPress={() => setResetting(true)} fullWidth />
              )}
              {!isSelf && (
                <Button
                  title="Deactivate user"
                  variant="danger"
                  onPress={confirmDeactivate}
                  disabled={saving}
                  fullWidth
                />
              )}
            </>
          )}

          {status === 'deactivated' && (
            <Button title="Reactivate user" onPress={() => save(true)} loading={saving} fullWidth />
          )}
        </View>
      )}
      {resetting && user && (
        <ResetPasswordSheet
          user={user}
          onClose={() => setResetting(false)}
          onDone={(message) => Alert.alert('Password reset', message)}
        />
      )}
    </KeyboardAwareScrollView>
  );
}

// ---------------------------------------------------------------------
// Simple chip picker (a shared Select component will replace this later)
// ---------------------------------------------------------------------
function OptionChips<T extends string | null>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            disabled={disabled}
            style={[
              styles.chip,
              selected && styles.chipSelected,
              disabled && !selected && styles.chipDisabled,
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
          >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const STATUS = {
  active: { label: 'Active', background: colors.successSoft, color: colors.success },
  pending: { label: 'Waiting for approval', background: colors.warningSoft, color: colors.warning },
  deactivated: { label: 'Deactivated', background: colors.dangerSoft, color: colors.danger },
} as const;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  name: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  sectionTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  muted: {
    fontSize: fontSize.small,
    color: colors.textMuted,
  },
  note: {
    fontSize: fontSize.small,
    color: colors.info,
    backgroundColor: colors.infoSoft,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  statusPill: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  statusText: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipText: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  chipTextSelected: {
    color: colors.textOnPrimary,
  },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  errorText: {
    fontSize: fontSize.small,
    color: colors.danger,
  },
  actions: { gap: spacing.md },
});