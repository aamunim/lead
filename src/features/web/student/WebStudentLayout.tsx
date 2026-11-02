import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  DEFAULT_APPROVAL_SETTINGS,
  canApprove,
  getApprovalSettings,
  getPlacementOptions,
  stageBadge,
  type ApprovalSettings,
  type PlacementOptions,
} from '@/features/approval/api';
import {
  ApprovalActionSheet,
  admissionChecks,
  type ApprovalLead,
  type ApprovalSheetKind,
} from '@/features/approval/ApprovalCard';
import { useAuth } from '@/features/auth/AuthProvider';
import { money } from '@/features/fees/api';
import { FeeChangeSheet } from '@/features/fees/FeeChangeSheet';
import { downloadLeadFile, listLeadFiles } from '@/features/files/api';
import { addNoteToLeads, type LeadDetail } from '@/features/leads/api';
import { listMissingPapers } from '@/features/papers/api';
import { dialogOpen, loadPref, onKey, savePref, typingInField } from '@/features/web/prefs';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐🎓 The student page on a computer screen
//   • panel (next to the table): a compact header, then tabs
//     Overview · Fee · Papers & files · Activity
//   • full page: a wide header, then three columns
//     profile · activity (with a note box) · fee, papers, files
//   The parts themselves (cards) are the phone's; only the order and the
//   frame are the website's. "Next steps" lists what is left, with a
//   button for each.
// =====================================================================

export type StudentParts = {
  screen: React.ReactNode;
  recent: React.ReactNode;
  pipeline: React.ReactNode;
  approval: React.ReactNode;
  visit: React.ReactNode;
  fee: React.ReactNode;
  papers: React.ReactNode;
  files: React.ReactNode;
  follow: React.ReactNode;
  calls: React.ReactNode;
  interest: React.ReactNode;
  details: React.ReactNode;
  activity: React.ReactNode;
  remove: React.ReactNode;
};

type Tab = 'overview' | 'fee' | 'files' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'fee', label: '💰 Fee' },
  { key: 'files', label: '📄 Papers & files' },
  { key: 'activity', label: '🕘 Activity' },
];
const TAB_KEY = 'web_student_tab';

// The passport photo of a student (kept while the page is open)
const photoCache = new Map<string, string | null>();

export function WebStudentLayout({
  mode,
  wide,
  lead,
  parts,
  onWhatsApp,
  onChanged,
}: {
  mode: 'panel' | 'full';
  /** room for three columns */
  wide: boolean;
  lead: LeadDetail;
  parts: StudentParts;
  onWhatsApp: () => void;
  /** something was saved: a short message, then the page loads again */
  onChanged: (message: string) => void;
}) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [settings, setSettings] = useState<ApprovalSettings>(DEFAULT_APPROVAL_SETTINGS);
  const [places, setPlaces] = useState<PlacementOptions | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [photo, setPhoto] = useState<string | null>(photoCache.get(lead.id) ?? null);
  const [tab, setTabState] = useState<Tab>(() => loadPref<Tab>(TAB_KEY, 'overview'));
  const [sheet, setSheet] = useState<ApprovalSheetKind | null>(null);
  const [feeOpen, setFeeOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'calls' | 'changes'>('all');
  const noteRef = useRef<{ focus: () => void } | null>(null);

  const setTab = (t: Tab) => {
    setTabState(t);
    savePref(TAB_KEY, t);
  };

  useEffect(() => {
    getApprovalSettings().then(setSettings);
    getPlacementOptions()
      .then(setPlaces)
      .catch(() => setPlaces(null));
  }, []);

  const admitted = lead.stage?.kind === 'won' && !!lead.admitted_at;
  const officer = settings.enabled && canApprove(settings, profile, isAdmin);

  // Papers still missing (names)
  useEffect(() => {
    if (!admitted || !(lead.papers_missing ?? 0)) {
      setMissing([]);
      return;
    }
    listMissingPapers(lead.id, lead.admitted_course_id)
      .then(setMissing)
      .catch(() => setMissing([]));
  }, [admitted, lead.id, lead.admitted_course_id, lead.papers_missing]);

  // 🪪 The passport photo (the newest picture of a "passport photo" paper)
  useEffect(() => {
    if (photoCache.has(lead.id)) {
      setPhoto(photoCache.get(lead.id) ?? null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const [{ data: papers }, files] = await Promise.all([
          supabase.from('admission_papers').select('id').eq('passport', true),
          listLeadFiles(lead.id),
        ]);
        const ids = new Set((papers ?? []).map((p: { id: string }) => p.id));
        const pic = files.find((f) => f.paper_id && ids.has(f.paper_id) && (f.mime_type ?? '').startsWith('image/'));
        const url = pic ? (await downloadLeadFile(pic)).uri : null;
        photoCache.set(lead.id, url);
        if (live) setPhoto(url);
      } catch {
        if (live) setPhoto(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [lead.id, lead.updated_at]);

  const paid = Number(lead.fee_paid ?? 0);
  const reg = lead.approval_status === 'approved' ? (lead.registration_status ?? 'waiting') : null;
  const stepNow: ApprovalSheetKind | null =
    officer && lead.approval_status === 'waiting' && paid >= settings.admission_min_paid
      ? 'approve'
      : officer && reg === 'waiting' && paid >= settings.registration_min_paid
        ? 'reg_approve'
        : null;

  // ⌨ Full page: N note · A approve / register · Esc back to the list
  useEffect(() => {
    if (mode !== 'full') return;
    return onKey((e) => {
      if (typingInField(e) || dialogOpen()) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (wide) noteRef.current?.focus();
        else setNoteOpen(true);
      } else if ((e.key === 'a' || e.key === 'A') && stepNow) {
        setSheet(stepNow);
      } else if (e.key === 'Escape') {
        if (router.canGoBack()) router.back();
        else router.navigate('/students' as Href);
      }
    });
  }, [mode, wide, stepNow]);

  // ── Next steps ──
  type Step = { tone: 'warn' | 'bad' | 'info'; text: string; action?: { label: string; run: () => void } };
  const steps: Step[] = [];
  if (admitted && settings.enabled && lead.approval_status) {
    if (lead.approval_status === 'waiting') {
      if (paid < settings.admission_min_paid) {
        steps.push({
          tone: 'warn',
          text: `Admission approval needs ${money(settings.admission_min_paid)} paid (paid ${money(paid)})`,
          action: { label: 'Take payment', run: () => setTab('fee') },
        });
      } else {
        steps.push({
          tone: 'info',
          text: 'Admission waiting for approval',
          action: officer ? { label: '✅ Approve', run: () => setSheet('approve') } : undefined,
        });
      }
    }
    if (lead.approval_status === 'returned') {
      steps.push({
        tone: 'bad',
        text: `Admission sent back${lead.approval_note ? `: “${lead.approval_note}”` : ''}`,
        action: { label: 'Send again', run: () => setSheet('resubmit') },
      });
    }
    if (lead.approval_status === 'approved' && !lead.admitted_section_id) {
      steps.push({
        tone: 'warn',
        text: 'No section yet',
        action: officer ? { label: 'Choose', run: () => setSheet('place') } : undefined,
      });
    }
    if (!lead.student_ref) {
      steps.push({
        tone: 'warn',
        text: 'No College ID',
        action: officer ? { label: 'Add', run: () => setSheet('ref') } : undefined,
      });
    }
    if (!lead.nu_admission_id) {
      steps.push({
        tone: 'warn',
        text: 'No NU Admission ID',
        action: officer ? { label: 'Add', run: () => setSheet('nu') } : undefined,
      });
    }
    if (reg === 'waiting') {
      if (paid < settings.registration_min_paid) {
        steps.push({
          tone: 'warn',
          text: `Registration needs ${money(settings.registration_min_paid - paid)} more (${money(settings.registration_min_paid)} in total)`,
          action: { label: 'Take payment', run: () => setTab('fee') },
        });
      } else {
        steps.push({
          tone: 'info',
          text: 'Registration waiting for approval',
          action: officer ? { label: '📝 Register', run: () => setSheet('reg_approve') } : undefined,
        });
      }
    }
    if (reg === 'returned') {
      steps.push({
        tone: 'bad',
        text: `Registration sent back${lead.registration_note ? `: “${lead.registration_note}”` : ''}`,
        action: { label: 'Send again', run: () => setSheet('reg_resubmit') },
      });
    }
  }
  if (admitted && (lead.papers_missing ?? 0) > 0) {
    const n = lead.papers_missing ?? 0;
    steps.push({
      tone: 'warn',
      text: `${n} paper${n > 1 ? 's' : ''} missing${missing.length ? `: ${missing.join(', ')}` : ''}`,
      action: { label: 'Upload', run: () => setTab('files') },
    });
  }

  const nextSteps = admitted ? (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>✨ Next steps</Text>
      {steps.length === 0 ? (
        <Text style={styles.done}>✅ Everything is done</Text>
      ) : (
        steps.map((st) => (
          <View key={st.text} style={styles.stepRow}>
            <View
              style={[
                styles.stepDot,
                st.tone === 'bad' ? styles.dotBad : st.tone === 'info' ? styles.dotInfo : styles.dotWarn,
              ]}
            />
            <Text style={styles.stepText}>{st.text}</Text>
            {st.action && (
              <Pressable
                onPress={st.action.run}
                style={(s) => [styles.stepBtn, (s as { hovered?: boolean }).hovered && styles.stepBtnHover]}
                accessibilityRole="button"
              >
                <Text style={styles.stepBtnText}>{st.action.label}</Text>
              </Pressable>
            )}
          </View>
        ))
      )}
    </View>
  ) : null;

  // ── Header ──
  const placement = places
    ? [
        places.courses.find((c) => c.id === lead.admitted_course_id)?.name,
        places.batches.find((b) => b.id === lead.admitted_batch_id)?.name,
        (() => {
          const s = places.sections.find((x) => x.id === lead.admitted_section_id)?.name;
          return s ? `Section ${s}` : null;
        })(),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const badge = admitted ? stageBadge(lead.approval_status, lead.registration_status) : null;
  const due = Number(lead.fee_due ?? 0);
  const compact = mode === 'panel' || !wide;

  const copy = (v: string) => navigator.clipboard?.writeText(v).catch(() => undefined);

  const header = (
    <View style={[styles.header, compact && styles.headerCompact]}>
      <View style={[styles.photo, compact && styles.photoSmall]}>
        {photo ? (
          <Image source={{ uri: photo }} style={styles.photoImg} accessibilityLabel="Passport photo" />
        ) : (
          <Text style={[styles.initials, compact && styles.initialsSmall]}>{initialsOf(lead.name)}</Text>
        )}
      </View>
      <View style={styles.flex}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, compact && styles.nameSmall]} numberOfLines={1}>
            {lead.name}
          </Text>
          {lead.stage?.kind === 'cancelled' && <Pill text="Cancelled" tone="bad" />}
          {badge && (
            <Pill text={badge.text} tone={badge.color === 'good' ? 'good' : badge.color === 'bad' ? 'bad' : 'warn'} />
          )}
          {admitted && due > 0 && <Pill text={`💵 ${money(due)} due`} tone="warn" />}
          {admitted && (lead.papers_required ?? 0) > 0 && (
            <Pill
              text={`📄 ${(lead.papers_required ?? 0) - (lead.papers_missing ?? 0)}/${lead.papers_required}`}
              tone={(lead.papers_missing ?? 0) > 0 ? 'warn' : 'good'}
            />
          )}
        </View>
        <View style={styles.idRow}>
          <IdChip label="College ID" value={lead.student_ref} onCopy={copy} />
          <IdChip label="NU ID" value={lead.nu_admission_id} onCopy={copy} />
        </View>
        <Text style={styles.meta} numberOfLines={2}>
          {[
            placement || null,
            lead.phone ? `📞 ${lead.phone}` : null,
            lead.admitted_at
              ? `Admitted ${new Date(lead.admitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
              : null,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </Text>
        <View style={styles.actions}>
          {mode === 'full' && (
            <Action
              label="← Students"
              onPress={() => (router.canGoBack() ? router.back() : router.navigate('/students' as Href))}
            />
          )}
          <Action label="💬 WhatsApp" onPress={onWhatsApp} />
          <Action
            label="📝 Note"
            onPress={() => (mode === 'full' && wide ? noteRef.current?.focus() : setNoteOpen(true))}
          />
          {stepNow && (
            <Action
              primary
              label={stepNow === 'approve' ? '✅ Approve admission' : '📝 Approve registration'}
              onPress={() => setSheet(stepNow)}
            />
          )}
          {officer && admitted && <Action label="💰 Change fee" onPress={() => setFeeOpen(true)} />}
          {mode === 'panel' && <Action label="📎 Upload" onPress={() => setTab('files')} />}
          {mode === 'full' && <Action label="✏️ Edit" onPress={() => router.push(`/leads/edit/${lead.id}` as Href)} />}
        </View>
      </View>
    </View>
  );

  const noteBox = (
    <NoteBox
      inputRef={noteRef}
      onSave={async (text) => {
        await addNoteToLeads([lead.id], text);
        setNoteOpen(false);
        onChanged('📝 Note saved.');
      }}
    />
  );

  const filterChips = (
    <View style={styles.chips}>
      {(
        [
          ['all', 'All'],
          ['calls', '📞 Calls & notes'],
          ['changes', '🕘 Changes'],
        ] as const
      ).map(([k, label]) => (
        <Pressable
          key={k}
          onPress={() => setFilter(k)}
          style={[styles.chip, filter === k && styles.chipOn]}
          accessibilityRole="radio"
          accessibilityState={{ selected: filter === k }}
        >
          <Text style={[styles.chipText, filter === k && styles.chipTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
  const activity = (
    <>
      {filterChips}
      {filter !== 'changes' && parts.calls}
      {filter !== 'calls' && parts.activity}
    </>
  );

  const overview = (
    <>
      {nextSteps}
      {parts.approval}
      {parts.recent && <View style={styles.card}>{parts.recent}</View>}
      {parts.pipeline}
      {parts.follow}
      {parts.visit}
      {parts.details}
      {parts.interest}
      {parts.remove}
    </>
  );

  const dialogs = (
    <>
      {sheet && (
        <ApprovalActionSheet
          kind={sheet}
          lead={lead as unknown as ApprovalLead}
          warnings={admissionChecks(lead).filter((c) => !c.ok).length}
          checks={admissionChecks(lead)}
          onClose={() => setSheet(null)}
          onDone={(message) => {
            setSheet(null);
            onChanged(message);
          }}
        />
      )}
      {feeOpen && (
        <FeeChangeSheet
          leadId={lead.id}
          name={lead.name}
          onClose={() => setFeeOpen(false)}
          onDone={(message) => {
            setFeeOpen(false);
            onChanged(message);
          }}
        />
      )}
      {noteOpen && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setNoteOpen(false)}>
          <View style={styles.backdrop}>
            <Pressable style={styles.flex} onPress={() => setNoteOpen(false)} accessibilityLabel="Close" />
            <View style={styles.sheet}>
              <Text style={styles.cardTitle}>📝 Note · {lead.name}</Text>
              {noteBox}
            </View>
          </View>
        </Modal>
      )}
    </>
  );

  // ── Three columns (full page, wide screen) ──
  if (mode === 'full' && wide) {
    return (
      <View style={styles.screen}>
        {parts.screen}
        {header}
        <View style={styles.columns}>
          <ScrollView style={styles.colLeft} contentContainerStyle={styles.colContent}>
            <Text style={styles.colTitle}>PROFILE</Text>
            {nextSteps}
            {parts.approval}
            {parts.pipeline}
            {parts.details}
            {parts.interest}
            {parts.visit}
            {parts.follow}
            {parts.remove}
          </ScrollView>
          <ScrollView style={styles.colMid} contentContainerStyle={styles.colContent}>
            <Text style={styles.colTitle}>ACTIVITY</Text>
            <View style={styles.card}>{noteBox}</View>
            {activity}
          </ScrollView>
          <ScrollView style={styles.colRight} contentContainerStyle={styles.colContent}>
            <Text style={styles.colTitle}>FEE · PAPERS · FILES</Text>
            {parts.fee}
            {parts.papers}
            {parts.files}
          </ScrollView>
        </View>
        {dialogs}
      </View>
    );
  }

  // ── Header + tabs (the panel, or a narrower full page) ──
  return (
    <View style={styles.screen}>
      {parts.screen}
      {header}
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={(s) => [
              styles.tab,
              tab === t.key && styles.tabOn,
              (s as { hovered?: boolean }).hovered && styles.tabHover,
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.key }}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={[styles.colContent, mode === 'full' && styles.fullNarrow]}>
        {tab === 'overview' && overview}
        {tab === 'fee' && parts.fee}
        {tab === 'files' && (
          <>
            {parts.papers}
            {parts.files}
          </>
        )}
        {tab === 'activity' && activity}
      </ScrollView>
      {dialogs}
    </View>
  );
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?'
  );
}

function Pill({ text, tone }: { text: string; tone: 'good' | 'warn' | 'bad' }) {
  const t = tone === 'good' ? styles.pillGood : tone === 'bad' ? styles.pillBad : styles.pillWarn;
  return (
    <View style={[styles.pill, t]}>
      <Text style={[styles.pillText, t]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function IdChip({ label, value, onCopy }: { label: string; value: string | null; onCopy: (v: string) => void }) {
  return (
    <View style={styles.idChip}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={[styles.idValue, !value && styles.idEmpty]}>{value ?? '—'}</Text>
      {!!value && (
        <Pressable
          onPress={() => onCopy(value)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${label}`}
        >
          <Text style={styles.copy}>📋</Text>
        </Pressable>
      )}
    </View>
  );
}

function Action({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={(s) => [
        styles.action,
        primary && styles.actionPrimary,
        (s as { hovered?: boolean }).hovered && styles.actionHover,
      ]}
      accessibilityRole="button"
    >
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

function NoteBox({
  inputRef,
  onSave,
}: {
  inputRef: React.MutableRefObject<{ focus: () => void } | null>;
  onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(text.trim());
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }, [text, onSave]);
  return (
    <View style={styles.noteBox}>
      <TextInput
        ref={inputRef as never}
        value={text}
        onChangeText={setText}
        placeholder="Write a note…  (Ctrl+Enter to save)"
        placeholderTextColor={colors.textMuted}
        multiline
        style={styles.noteInput}
        onKeyPress={(e) => {
          const ev = e.nativeEvent as unknown as { key?: string; ctrlKey?: boolean; metaKey?: boolean };
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) save();
        }}
        accessibilityLabel="New note"
      />
      <View style={styles.noteFoot}>
        {error ? <Text style={styles.error}>{error}</Text> : <View style={styles.flex} />}
        <Pressable
          onPress={busy ? undefined : save}
          style={[styles.saveBtn, (!text.trim() || busy) && styles.saveOff]}
          accessibilityRole="button"
        >
          <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save note'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    gap: spacing.lg,
    padding: spacing.xl,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerCompact: { padding: spacing.lg, gap: spacing.md },
  photo: {
    width: 96,
    height: 96,
    borderRadius: radius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: isDark ? '#1E2949' : '#E1E8FB',
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoSmall: { width: 64, height: 64, borderRadius: radius.md },
  photoImg: { width: '100%', height: '100%' },
  initials: { fontSize: 32, fontWeight: fontWeight.bold, color: colors.primary },
  initialsSmall: { fontSize: fontSize.title },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  name: { fontSize: 26, fontWeight: fontWeight.bold, color: colors.text, flexShrink: 1 },
  nameSmall: { fontSize: fontSize.title },
  idRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, flexWrap: 'wrap' },
  idChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  idLabel: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.textMuted, textTransform: 'uppercase' },
  idValue: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  },
  idEmpty: { color: colors.textMuted, fontWeight: fontWeight.regular },
  copy: { fontSize: 12 },
  meta: { marginTop: spacing.xs, fontSize: fontSize.small, color: colors.textMuted },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.md },
  action: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionHover: { borderColor: colors.primary },
  actionPrimary: { backgroundColor: colors.success, borderColor: colors.success },
  actionText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  actionTextPrimary: { color: '#fff' },

  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  pillText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, backgroundColor: 'transparent' },
  pillGood: { backgroundColor: colors.successSoft, color: colors.success },
  pillWarn: { backgroundColor: colors.warningSoft, color: colors.warning },
  pillBad: { backgroundColor: colors.dangerSoft, color: colors.danger },

  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabOn: { borderBottomColor: colors.primary },
  tabHover: { backgroundColor: colors.background },
  tabText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  tabTextOn: { color: colors.primary },

  columns: { flex: 1, flexDirection: 'row', minHeight: 0 },
  colLeft: { flex: 1, borderRightWidth: 1, borderRightColor: colors.border },
  colMid: { flex: 1.25, borderRightWidth: 1, borderRightColor: colors.border },
  colRight: { flex: 1 },
  colContent: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl * 2 },
  fullNarrow: { maxWidth: 900, width: '100%', alignSelf: 'center' },
  colTitle: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.textMuted, letterSpacing: 1 },

  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  done: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepDot: { width: 8, height: 8, borderRadius: 4 },
  dotWarn: { backgroundColor: colors.warning },
  dotBad: { backgroundColor: colors.danger },
  dotInfo: { backgroundColor: colors.primary },
  stepText: { flex: 1, fontSize: fontSize.small, color: colors.text },
  stepBtn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
  },
  stepBtnHover: { opacity: 0.85 },
  stepBtnText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },

  chips: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: {
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },

  noteBox: { gap: spacing.sm },
  noteInput: {
    minHeight: 76,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.small,
    textAlignVertical: 'top',
  },
  noteFoot: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  saveBtn: {
    paddingVertical: 7,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  saveOff: { opacity: 0.5 },
  saveText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  error: { flex: 1, fontSize: fontSize.small, color: colors.danger },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
});
