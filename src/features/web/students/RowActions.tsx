import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { money, recordPayment, type FeeSettings } from '@/features/fees/api';
import { PaySheet } from '@/features/fees/PaymentsSection';
import { usePaperUpload } from '@/features/files/usePaperUpload';
import { addNoteToLeads, type LeadListItem } from '@/features/leads/api';
import { getLeadPapers, type LeadPaper } from '@/features/papers/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐 ⋯ on a Students row: the everyday work without opening the student
//   payment · note · upload a paper · 📤 submitted / 🏛 received (and
//   undo) · section, NU ID, College ID · fee · papers · all notes
// =====================================================================

export type RowAction =
  | 'pay'
  | 'note'
  | 'upload'
  | 'submit'
  | 'receive'
  | 'undo_submit'
  | 'undo_receive'
  | 'place'
  | 'nu'
  | 'ref'
  | 'fee'
  | 'papers'
  | 'notes'
  | 'open';

export function RowMenu({
  row: r,
  officer,
  canPay,
  mins,
  onPick,
  onClose,
}: {
  row: LeadListItem;
  officer: boolean;
  canPay: boolean;
  /** (old) */
  mins?: { admission: number; registration: number };
  onPick: (a: RowAction) => void;
  onClose: () => void;
}) {
  const paid = Number(r.fee_paid ?? 0);
  const won = r.stage?.kind === 'won';
  const need = Number(r.admission_fee_need ?? mins?.admission ?? 0);
  const items: { a: RowAction; label: string; hint?: string; off?: boolean }[] = [];

  if (canPay && won && Number(r.fee_due ?? 0) > 0)
    items.push({ a: 'pay', label: '💵 Take payment', hint: `${money(Number(r.fee_due))} due` });
  items.push({ a: 'note', label: '📝 Add note' });
  items.push({ a: 'upload', label: '📎 Upload a paper' });
  if (officer && won && r.admitted_at) {
    if (!r.submitted_at) items.push({ a: 'submit', label: '📤 Submitted Online', hint: 'NU Admission ID' });
    if (r.submitted_at && !r.received_at) {
      items.push({
        a: 'receive',
        label: '🏛 Received by ITTC',
        off: paid < need,
        hint: paid < need ? `admission fee ${money(need)}: ${money(need - paid)} more` : undefined,
      });
      items.push({ a: 'undo_submit', label: '↩ Undo Submitted Online' });
    }
    if (r.received_at) items.push({ a: 'undo_receive', label: '↩ Undo Received by ITTC' });
    items.push({ a: 'place', label: '🏫 Course · batch · section' });
    items.push({ a: 'nu', label: r.nu_admission_id ? '🆔 Change NU Admission ID' : '🆔 Add NU Admission ID' });
    items.push({ a: 'ref', label: '✏️ College ID' });
    items.push({ a: 'fee', label: '💰 Change fee (discount / final)' });
  }
  items.push({ a: 'papers', label: '📄 Papers' });
  items.push({ a: 'notes', label: '🕘 All calls & notes' });
  items.push({ a: 'open', label: '↗ Open the student' });

  return (
    <Dialog
      onClose={onClose}
      title={r.name}
      sub={[r.student_ref, r.admitted_course?.name, r.admitted_section ? `Section ${r.admitted_section.name}` : null]
        .filter(Boolean)
        .join(' · ')}
    >
      {items.map((it) => (
        <Pressable
          key={it.a}
          disabled={it.off}
          onPress={() => onPick(it.a)}
          style={(s) => [
            styles.item,
            it.off && styles.itemOff,
            !it.off && (s as { hovered?: boolean }).hovered && styles.itemHover,
          ]}
          accessibilityRole="menuitem"
          accessibilityState={{ disabled: !!it.off }}
        >
          <Text style={[styles.itemText, it.off && styles.offText]}>
            {it.off ? '🔒 ' : ''}
            {it.label}
          </Text>
          {!!it.hint && <Text style={styles.itemHint}>{it.hint}</Text>}
        </Pressable>
      ))}
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// 📋 Leads: ⋯ on a row (the phone's lead actions, without opening it)
// ---------------------------------------------------------------------
export type LeadRowAction =
  | 'note'
  | 'followup'
  | 'stage'
  | 'rating'
  | 'tags'
  | 'assign'
  | 'whatsapp'
  | 'upload'
  | 'lost'
  | 'admit'
  | 'notes'
  | 'open';

/** What can be done to many ticked leads at once */
export const LEAD_BULK: {
  field: 'note' | 'stage' | 'tags' | 'assign' | 'followup' | 'rating' | 'lost';
  label: string;
}[] = [
  { field: 'note', label: '📝 Note' },
  { field: 'followup', label: '⏰ Next call' },
  { field: 'stage', label: '🚩 Stage' },
  { field: 'rating', label: '🔥 Rating' },
  { field: 'tags', label: '🏷 Tag' },
  { field: 'assign', label: '👤 Give to' },
  { field: 'lost', label: '✕ Lost' },
];

export function LeadRowMenu({
  row: r,
  mayHandOver,
  onPick,
  onClose,
}: {
  row: LeadListItem;
  mayHandOver: boolean;
  onPick: (a: LeadRowAction) => void;
  onClose: () => void;
}) {
  const open = !r.stage || (r.stage.kind !== 'won' && r.stage.kind !== 'lost' && r.stage.kind !== 'cancelled');
  const items: { a: LeadRowAction; label: string; hint?: string }[] = [
    { a: 'note', label: '📝 Add note' },
    { a: 'followup', label: '⏰ Next call', hint: r.next_follow_up_at ? 'change' : undefined },
    ...(open ? [{ a: 'stage' as const, label: '🚩 Move to a stage' }] : []),
    { a: 'rating', label: '🔥 Hot / warm / cold' },
    { a: 'tags', label: '🏷 Tags' },
    ...(mayHandOver ? [{ a: 'assign' as const, label: '👤 Give to someone' }] : []),
    { a: 'whatsapp', label: '💬 WhatsApp' },
    { a: 'upload', label: '📎 Upload a paper' },
    ...(open
      ? [
          { a: 'admit' as const, label: '🎓 Admit…', hint: 'on the lead page' },
          { a: 'lost' as const, label: '✕ Mark as lost' },
        ]
      : []),
    { a: 'notes', label: '🕘 All calls & notes' },
    { a: 'open', label: '↗ Open the lead' },
  ];
  return (
    <Dialog onClose={onClose} title={r.name} sub={[r.stage?.name, r.assignee?.full_name].filter(Boolean).join(' · ')}>
      {items.map((it) => (
        <Pressable
          key={it.a}
          onPress={() => onPick(it.a)}
          style={(s) => [styles.item, (s as { hovered?: boolean }).hovered && styles.itemHover]}
          accessibilityRole="menuitem"
        >
          <Text style={styles.itemText}>{it.label}</Text>
          {!!it.hint && <Text style={styles.itemHint}>{it.hint}</Text>}
        </Pressable>
      ))}
    </Dialog>
  );
}

/** 💵 The payment form, from the row */
export function RowPay({
  row: r,
  settings,
  isAdmin,
  onClose,
  onDone,
}: {
  row: LeadListItem;
  settings: FeeSettings;
  isAdmin: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  return (
    <PaySheet
      visible
      leadId={r.id}
      due={Number(r.fee_due ?? 0)}
      next={null}
      settings={settings}
      isAdmin={isAdmin}
      onClose={onClose}
      onSave={async (input) => {
        const res = await recordPayment({ leadId: r.id, ...input });
        onDone(`💵 ${money(input.amount)} received from ${r.name} · ${res.receipt_no}`);
      }}
    />
  );
}

/** 📝 A note, from the row */
export function RowNote({
  row: r,
  onClose,
  onDone,
}: {
  row: LeadListItem;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!text.trim()) return setError('Please write the note.');
    setBusy(true);
    setError(null);
    try {
      await addNoteToLeads([r.id], text.trim());
      onDone(`📝 Note saved for ${r.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={onClose} title={`📝 Note · ${r.name}`}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        placeholder="Write a note…  (Ctrl+Enter to save)"
        placeholderTextColor={colors.textMuted}
        style={styles.noteInput}
        onKeyPress={(e) => {
          const ev = e.nativeEvent as unknown as { key?: string; ctrlKey?: boolean; metaKey?: boolean };
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) save();
        }}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable
        onPress={busy ? undefined : save}
        style={[styles.saveBtn, busy && styles.itemOff]}
        accessibilityRole="button"
      >
        <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save note'}</Text>
      </Pressable>
    </Dialog>
  );
}

/** 📎 Choose the paper, then the file (resize / passport editor / PDF rules as everywhere) */
export function RowUpload({
  row: r,
  onClose,
  onDone,
}: {
  row: LeadListItem;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [papers, setPapers] = useState<LeadPaper[] | null>(null);
  const uploader = usePaperUpload(r.id, (message) => onDone(message));
  useEffect(() => {
    getLeadPapers(r.id)
      .then((p) => setPapers(p.papers))
      .catch(() => setPapers([]));
  }, [r.id]);

  // While the editor is open (passport photo), only it shows
  if (uploader.ui) return <>{uploader.ui}</>;

  return (
    <Dialog onClose={onClose} title={`📎 Upload · ${r.name}`} sub="Which paper?">
      {uploader.uploading ? (
        <View style={styles.busy}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.itemHint}>Uploading {uploader.uploading}…</Text>
        </View>
      ) : papers === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <View style={styles.chips}>
          {papers.map((p) => (
            <Pressable
              key={p.paperId}
              onPress={() => uploader.upload(p)}
              style={(s) => [
                styles.chip,
                p.status === null && styles.chipMissing,
                (s as { hovered?: boolean }).hovered && styles.itemHover,
              ]}
              accessibilityRole="button"
            >
              <Text style={styles.chipText}>
                {p.status ? '✅ ' : p.isRequired ? '⚠️ ' : ''}
                {p.name}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={() => uploader.upload(null)} style={styles.chip} accessibilityRole="button">
            <Text style={styles.chipText}>Something else</Text>
          </Pressable>
        </View>
      )}
    </Dialog>
  );
}

function Dialog({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.back} onPress={onClose} accessibilityLabel="Close menu">
        <Pressable style={styles.box} onPress={() => undefined}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {!!sub && <Text style={styles.sub}>{sub}</Text>}
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: {
    flex: 1,
    backgroundColor: 'rgba(16,26,51,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  box: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '85%',
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted },
  list: { marginTop: spacing.sm },
  listContent: { gap: 2 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 9,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  itemHover: { backgroundColor: colors.primarySoft },
  itemOff: { opacity: 0.55 },
  itemText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  offText: { color: colors.textMuted },
  itemHint: { fontSize: fontSize.caption, color: colors.textMuted },
  noteInput: {
    minHeight: 110,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.small,
    textAlignVertical: 'top',
  },
  error: { fontSize: fontSize.small, color: colors.danger },
  saveBtn: {
    alignSelf: 'flex-end',
    marginTop: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  saveText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipMissing: { borderColor: colors.warning },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  busy: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
});
