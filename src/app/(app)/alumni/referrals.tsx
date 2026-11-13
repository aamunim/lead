import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  creditReferral,
  hintId,
  importReferral,
  listReferrals,
  rejectReferral,
  type Referral,
} from '@/features/alumni/api';
import { alumniChanged, Chip, s as ui, useAlumniAccess, useAlumniVersion, when } from '@/features/alumni/ui';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';
import { SheetScroll } from '@/shared/ui/SheetScroll';

// =====================================================================
// 📨 Referral inbox: import as a lead (course + person chosen here),
//   give credit (the number was already a lead), or reject
// =====================================================================

const CHANNEL: Record<Referral['channel'], string> = {
  staff: 'Typed by staff',
  alumni_link: 'From the alumnus’s link',
  prospect_link: 'Filled in by the person',
};

function confirm(title: string, text: string, ok: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  }
  return new Promise((resolve) =>
    Alert.alert(title, text, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, onPress: () => resolve(true) },
    ]),
  );
}

export default function ReferralInboxScreen() {
  const access = useAlumniAccess();
  const version = useAlumniVersion();
  const [tab, setTab] = useState<'new' | 'done'>('new');
  const [rows, setRows] = useState<Referral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState<Referral | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listReferrals({ status: tab }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, [tab]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load, version]);

  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await run();
      alumniChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do it.');
    } finally {
      setBusy(null);
    }
  };

  const credit = (r: Referral) =>
    act(r.id, async () => {
      try {
        await creditReferral(r.id);
      } catch (e) {
        if (hintId(e, 'referral_other_alumnus')) {
          const ok = await confirm(
            'Another alumnus has the credit',
            'This lead was already credited to another alumnus. Give the credit to ' +
              (r.alumni?.name ?? 'this alumnus') +
              ' instead?',
            'Give credit',
          );
          if (ok) await creditReferral(r.id, { replace: true });
          return;
        }
        throw e;
      }
    });

  const reject = (r: Referral) => {
    const run = (reason: string | null) => act(r.id, () => rejectReferral(r.id, reason ?? undefined));
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      const reason = window.prompt('Reject this referral? Why (optional)', '');
      if (reason !== null) run(reason);
      return;
    }
    Alert.alert('Reject this referral?', `${r.name} · ${r.phone}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Wrong number', onPress: () => run('Wrong number') },
      { text: 'Not interested', onPress: () => run('Not interested') },
      { text: 'Reject', style: 'destructive', onPress: () => run(null) },
    ]);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Referral inbox' }} />
      <View style={styles.tabs}>
        <Chip text="📨 New" on={tab === 'new'} onPress={() => setTab('new')} />
        <Chip text="✓ Handled" on={tab === 'done'} onPress={() => setTab('done')} />
      </View>
      {error && <Text style={[ui.error, styles.pad]}>{error}</Text>}
      {rows === null ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.big}>{tab === 'new' ? '📭' : '🗂'}</Text>
              <Text style={ui.muted}>
                {tab === 'new'
                  ? 'No new referrals. Add one from an alumnus’s page (📨 Add a referral).'
                  : 'Nothing handled yet.'}
              </Text>
            </View>
          }
          renderItem={({ item: r }) => (
            <View style={[ui.card, styles.card]}>
              <View style={styles.top}>
                <View style={styles.flex}>
                  <Text style={styles.name}>{r.name}</Text>
                  <Text style={styles.phone} selectable>
                    📞 {r.phone}
                  </Text>
                </View>
                <Text style={ui.muted}>{when(r.created_at)}</Text>
              </View>
              <Pressable onPress={() => router.push(`/alumni/${r.alumni_id}` as Href)} accessibilityRole="link">
                <Text style={styles.from}>🎓 Referred by {r.alumni?.name ?? '—'} ›</Text>
              </Pressable>
              <Text style={ui.muted}>
                {[r.course?.name, r.area, CHANNEL[r.channel], r.by?.full_name ? `by ${r.by.full_name}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {!!r.note && <Text style={styles.note}>“{r.note}”</Text>}

              {r.status === 'new' && r.existing_lead_id && (
                <Pressable
                  onPress={() => router.push(`/leads/${r.existing_lead_id}` as Href)}
                  style={styles.warn}
                  accessibilityRole="link"
                >
                  <Text style={styles.warnText}>
                    ⚠ Already a lead: {r.existing?.name ?? 'open it'}
                    {r.existing?.assigned?.full_name ? ` (${r.existing.assigned.full_name})` : ''} ›
                  </Text>
                </Pressable>
              )}

              {r.status !== 'new' && (
                <Text style={styles.done}>
                  {r.status === 'imported'
                    ? '🎯 Became a lead'
                    : r.status === 'credited'
                      ? '🤝 Credit given'
                      : '✕ Rejected'}
                  {r.reject_reason ? ` · ${r.reject_reason}` : ''}
                  {r.handled_at ? ` · ${when(r.handled_at)}` : ''}
                </Text>
              )}
              {r.status !== 'new' && r.lead_id && (
                <Pressable onPress={() => router.push(`/leads/${r.lead_id}` as Href)} accessibilityRole="link">
                  <Text style={styles.from}>Open the lead ›</Text>
                </Pressable>
              )}

              {r.status === 'new' && access.manage && (
                <View style={styles.buttons}>
                  <Pressable
                    onPress={() => reject(r)}
                    disabled={busy === r.id}
                    style={styles.ghost}
                    accessibilityRole="button"
                  >
                    <Text style={styles.ghostText}>Reject</Text>
                  </Pressable>
                  {r.existing_lead_id ? (
                    <Pressable
                      onPress={() => credit(r)}
                      disabled={busy === r.id}
                      style={styles.primary}
                      accessibilityRole="button"
                    >
                      <Text style={styles.primaryText}>{busy === r.id ? '…' : '🤝 Give credit'}</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => setImporting(r)}
                      disabled={busy === r.id}
                      style={styles.primary}
                      accessibilityRole="button"
                    >
                      <Text style={styles.primaryText}>{busy === r.id ? '…' : '🎯 Import as lead'}</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          )}
        />
      )}
      {importing && (
        <ImportSheet
          referral={importing}
          onClose={() => setImporting(null)}
          onDone={(leadId) => {
            setImporting(null);
            alumniChanged();
            router.push(`/leads/${leadId}` as Href);
          }}
        />
      )}
    </View>
  );
}

// 🎯 Import: the course(s) and the person
function ImportSheet({
  referral,
  onClose,
  onDone,
}: {
  referral: Referral;
  onClose: () => void;
  onDone: (leadId: string) => void;
}) {
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [people, setPeople] = useState<AssignableUser[]>([]);
  const [courseIds, setCourseIds] = useState<string[]>(referral.course_id ? [referral.course_id] : []);
  const [assignTo, setAssignTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCourses()
      .then(setCourses)
      .catch(() => undefined);
    listAssignableUsers()
      .then((p) => setPeople(p.filter((x) => x.is_active)))
      .catch(() => undefined);
  }, []);

  const run = async () => {
    if (courses.length > 0 && courseIds.length === 0) return setError('Choose the course(s) they are interested in.');
    setBusy(true);
    setError(null);
    try {
      const leadId = await importReferral(referral.id, courseIds, assignTo);
      onDone(leadId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent keyboard animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <SheetScroll contentContainerStyle={styles.sheetBody}>
          <Text style={styles.sheetTitle}>🎯 {referral.name} → new lead</Text>
          <Text style={ui.muted}>Source: Alumni referral · Referred by {referral.alumni?.name ?? 'the alumnus'}</Text>
          {courses.length > 0 && (
            <>
              <Text style={ui.label}>INTERESTED COURSE(S) *</Text>
              <View style={ui.chips}>
                {courses.map((c) => (
                  <Chip
                    key={c.id}
                    text={c.name}
                    on={courseIds.includes(c.id)}
                    onPress={() =>
                      setCourseIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id]))
                    }
                  />
                ))}
              </View>
            </>
          )}
          <Text style={ui.label}>GIVE TO</Text>
          <View style={ui.chips}>
            <Chip text="Unassigned / by the rules" on={assignTo === null} onPress={() => setAssignTo(null)} />
            {people.map((p) => (
              <Chip
                key={p.id}
                text={p.full_name ?? 'No name'}
                on={assignTo === p.id}
                onPress={() => setAssignTo(p.id)}
              />
            ))}
          </View>
          {error && <Text style={ui.error}>{error}</Text>}
          <Button title="Import as lead" onPress={run} loading={busy} fullWidth />
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </SheetScroll>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  pad: { paddingHorizontal: spacing.lg },
  loader: { marginTop: spacing.xl },
  tabs: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    ...(isWeb ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : {}),
  },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : {}),
  },
  empty: { alignItems: 'center', padding: spacing.xl, gap: spacing.sm },
  big: { fontSize: 44 },
  card: { gap: 4 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  phone: { fontSize: fontSize.small, color: colors.text },
  from: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  note: { fontSize: fontSize.small, color: colors.textMuted, fontStyle: 'italic' },
  warn: { padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background, marginTop: 2 },
  warnText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning },
  done: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  ghost: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  ghostText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textMuted },
  primary: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  primaryText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '85%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    ...(Platform.OS === 'web' ? { width: '100%', maxWidth: 560, alignSelf: 'center' } : {}),
  },
  sheetBody: { padding: spacing.lg, gap: spacing.sm },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
});
