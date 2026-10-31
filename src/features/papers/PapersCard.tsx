import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { formatDue, scheduleFollowUp } from '@/features/follow-ups/api';
import {
    copyLabel,
    getLeadPapers,
    paperPlaceSuggestions,
    returnLeadPaper,
    setLeadPaper,
    setPaperFolder,
    shortDay,
    type CopyType,
    type LeadPaper,
    type LeadPapers,
    type PaperStatus,
} from '@/features/papers/api';
import { listPipelineStages, moveLeadStage } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { VoiceNoteButton } from '@/features/voice/VoiceNote';

// =====================================================================
// 📄 Papers card on the lead page
//   Tap = received / untick · ⋯ = details (original/copy, place, note, returned)
// =====================================================================

type Props = {
  leadId: string;
  /** open / won / lost / cancelled */
  stageKind: string;
  /** key of the lead's current stage (e.g. "papers_pending") */
  stageKey: string | null;
  /** Something changed: reload the lead page (and show a short message) */
  onChanged: (message?: string) => void;
  /** Changes when papers may have been ticked elsewhere (e.g. a file upload): reload */
  refreshKey?: number;
};

export function PapersCard({ leadId, stageKind, stageKey, onChanged, refreshKey }: Props) {
  const [data, setData] = useState<LeadPapers | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // paper id being saved
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<LeadPaper | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);

  // The card starts closed: only the title and the count until tapped
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await getLeadPapers(leadId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the papers.');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // All required papers in: offer to move the lead on
  const offerReady = async (before: LeadPapers, after: LeadPapers) => {
    if (stageKind !== 'open' || after.required === 0) return;
    if (before.done >= before.required || after.done < after.required) return;

    const stages = await listPipelineStages().catch(() => []);
    const ready = stages.find((s) => s.key === 'ready' && s.kind === 'open');
    if (!ready || ready.key === stageKey) {
      onChanged('📄 All required papers received.');
      return;
    }
    Alert.alert('All papers received', `Move the lead to "${ready.name}"?`, [
      { text: 'Not now', style: 'cancel', onPress: () => onChanged('📄 All required papers received.') },
      {
        text: 'Move',
        onPress: async () => {
          try {
            // A stage that asks for a note or a date is moved from the step bar instead
            if (ready.noteRequired || ready.askDate) {
              onChanged(`📄 All papers received. Move to "${ready.name}" from the step bar.`);
              return;
            }
            await moveLeadStage(leadId, ready.id);
            onChanged(`📄 All papers received. Moved to ${ready.name}.`);
          } catch (e) {
            Alert.alert('Could not move', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  /** Save, reload, and tell the page */
  const save = async (paperId: string, change: () => Promise<void>) => {
    if (!data) return;
    const before = data;
    setBusy(paperId);
    setError(null);
    try {
      await change();
      const after = await getLeadPapers(leadId);
      setData(after);
      await offerReady(before, after);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  // Tap: not received → received; received / not needed → untick
  const quickToggle = (p: LeadPaper) =>
    save(p.paperId, () =>
      setLeadPaper(leadId, p.paperId, p.status ? { status: null } : { status: 'received' }),
    );

  // Ask the lead to bring the missing papers: a next call tomorrow 10 am
  const remind = () => {
    if (!data) return;
    const missing = data.papers.filter((p) => p.isRequired && !p.status).map((p) => p.name);
    if (missing.length === 0) return;
    const due = new Date();
    due.setDate(due.getDate() + 1);
    due.setHours(10, 0, 0, 0);
    Alert.alert('Remind the lead?', `A call will be set for ${formatDue(due)}:\n\nBring: ${missing.join(', ')}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Set call',
        onPress: async () => {
          try {
            await scheduleFollowUp(leadId, due, `📄 Bring: ${missing.join(', ')}`);
            onChanged(`Call set for ${formatDue(due)} to remind about papers.`);
          } catch (e) {
            Alert.alert('Could not set the call', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  // --- render -----------------------------------------------------------------
  if (loading) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>📄 Papers</Text>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>📄 Papers</Text>
        {error && <Text style={styles.errorText}>{error}</Text>}
      </View>
    );
  }

  if (data.papers.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>📄 Papers</Text>
        <Text style={styles.hint}>No papers are needed for this lead’s course. (Settings → Required papers)</Text>
      </View>
    );
  }

  const complete = data.required > 0 && data.done >= data.required;
  const missingCount = data.required - data.done;

  return (
    <View style={[styles.card, stageKey === 'papers_pending' && !complete && styles.cardFocus]}>
      {/* Header: tap to open or close */}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        hitSlop={8}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Papers${data.required > 0 ? `, ${data.done} of ${data.required} required` : ''}`}
      >
        <Text style={styles.title}>📄 Papers</Text>
        <View style={styles.headerRight}>
          {data.required > 0 ? (
            <Text style={[styles.progress, complete ? styles.progressDone : styles.progressMissing]}>
              {data.done} of {data.required} required{complete ? ' ✓' : ''}
            </Text>
          ) : (
            <Text style={styles.hint}>{data.papers.length} {data.papers.length === 1 ? 'paper' : 'papers'}</Text>
          )}
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
        </View>
      </Pressable>

      {open && (
        <>
          {/* Where the file is kept */}
          <Pressable
            onPress={() => setFolderOpen(true)}
            style={({ pressed }) => [styles.folder, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={data.folder ? `Kept at ${data.folder}. Change` : 'Set where the papers are kept'}
          >
            <Text style={styles.folderIcon}>📁</Text>
            <Text style={[styles.folderText, !data.folder && styles.folderEmpty]} numberOfLines={2}>
              {data.folder ? `Kept at: ${data.folder}` : 'Where are the papers kept? Tap to set'}
            </Text>
            <Ionicons name="pencil" size={14} color={colors.textMuted} />
          </Pressable>

          {data.originalsHeld > 0 && (
            <Text style={styles.originals}>
              🗂 {data.originalsHeld} {data.originalsHeld === 1 ? 'original is' : 'originals are'} with us
            </Text>
          )}

          {/* The papers */}
          {data.papers.map((p) => (
            <PaperRow
              key={p.paperId}
              paper={p}
              busy={busy === p.paperId}
              onToggle={() => quickToggle(p)}
              onDetails={() => setDetail(p)}
            />
          ))}

          {error && <Text style={styles.errorText}>{error}</Text>}

          {missingCount > 0 && stageKind === 'open' && (
            <Button title={`📞 Remind to bring ${missingCount} ${missingCount === 1 ? 'paper' : 'papers'}`} variant="ghost" onPress={remind} fullWidth />
          )}
          <Text style={styles.hint}>Tap to tick · ⋯ for original / copy, place, note, returned</Text>
        </>
      )}

      {detail && (
        <PaperDetailSheet
          leadId={leadId}
          paper={detail}
          onClose={() => setDetail(null)}
          onSave={async (value) => {
            await save(detail.paperId, () => setLeadPaper(leadId, detail.paperId, value));
            setDetail(null);
          }}
          onReturn={async (undo) => {
            await save(detail.paperId, () => returnLeadPaper(leadId, detail.paperId, undo));
            setDetail(null);
          }}
        />
      )}

      {folderOpen && (
        <PlaceSheet
          title="Where are the papers kept?"
          initial={data.folder ?? ''}
          placeholder="e.g. Almirah 2 · Shelf 3 · File #42"
          onClose={() => setFolderOpen(false)}
          onSave={async (place) => {
            await setPaperFolder(leadId, place);
            setFolderOpen(false);
            await load();
            onChanged(place.trim() ? `📁 Kept at: ${place.trim()}` : 'Place removed.');
          }}
        />
      )}
    </View>
  );
}

// =====================================================================
// One paper
// =====================================================================
function PaperRow({
  paper: p,
  busy,
  onToggle,
  onDetails,
}: {
  paper: LeadPaper;
  busy: boolean;
  onToggle: () => void;
  onDetails: () => void;
}) {
  const received = p.status === 'received';
  const notNeeded = p.status === 'not_needed';

  const sub = received
    ? [
        copyLabel(p.copyType),
        p.returnedAt ? `Returned ${shortDay(p.returnedAt)}` : null,
        shortDay(p.receivedAt),
        p.receivedByName,
        p.keptAt ? `📍 ${p.keptAt}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : notNeeded
      ? `Not needed${p.receivedByName ? ` · ${p.receivedByName}` : ''}`
      : p.description ?? (p.isRequired ? 'Required' : 'Optional');

  return (
    <View style={styles.paperRow}>
      <Pressable
        onPress={onToggle}
        onLongPress={onDetails}
        disabled={busy}
        style={({ pressed }) => [styles.paperMain, pressed && styles.pressed]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: !!p.status, busy }}
        accessibilityLabel={`${p.name}${p.isRequired ? ', required' : ''}`}
      >
        <View style={[styles.box, received && styles.boxOn, notNeeded && styles.boxSkip]}>
          {busy ? (
            <ActivityIndicator size="small" color={received ? colors.textOnPrimary : colors.primary} />
          ) : received ? (
            <Ionicons name="checkmark" size={16} color={colors.textOnPrimary} />
          ) : notNeeded ? (
            <Ionicons name="remove" size={16} color={colors.textOnPrimary} />
          ) : null}
        </View>
        <View style={styles.flex}>
          <Text style={[styles.paperName, notNeeded && styles.paperSkipped]}>
            {p.name}
            {p.isRequired && !p.status ? <Text style={styles.reqMark}>  required</Text> : null}
          </Text>
          <Text style={[styles.paperSub, p.returnedAt && styles.returned]} numberOfLines={2}>
            {sub}
          </Text>
          {p.note ? <Text style={styles.paperNote}>“{p.note}”</Text> : null}
        </View>
      </Pressable>
      <Pressable onPress={onDetails} hitSlop={8} style={styles.more} accessibilityRole="button" accessibilityLabel="Details">
        <Ionicons name="ellipsis-horizontal" size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

// =====================================================================
// Details of one paper
// =====================================================================
function PaperDetailSheet({
  leadId,
  paper,
  onClose,
  onSave,
  onReturn,
}: {
  leadId: string;
  paper: LeadPaper;
  onClose: () => void;
  onSave: (value: { status: PaperStatus | null; copyType: CopyType | null; keptAt: string; note: string }) => Promise<void>;
  onReturn: (undo: boolean) => Promise<void>;
}) {
  const [status, setStatus] = useState<PaperStatus | null>(paper.status ?? 'received');
  const [copyType, setCopyType] = useState<CopyType | null>(paper.copyType);
  const [keptAt, setKeptAt] = useState(paper.keptAt ?? '');
  const [note, setNote] = useState(paper.note ?? '');
  const [places, setPlaces] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    paperPlaceSuggestions().then(setPlaces);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setSaving(false);
    }
  };

  const canReturn = paper.status === 'received' && paper.copyType === 'original';

  return (
    <Sheet onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>📄 {paper.name}</Text>
      {paper.description && <Text style={styles.hint}>{paper.description}</Text>}

      {/* Status */}
      <View style={styles.field}>
        <Text style={styles.label}>Status</Text>
        <View style={styles.chips}>
          <Chip label="✓ Received" on={status === 'received'} color={colors.success} onPress={() => setStatus('received')} />
          <Chip label="Not needed" on={status === 'not_needed'} color={colors.textMuted} onPress={() => setStatus('not_needed')} />
          <Chip label="Not received" on={status === null} color={colors.danger} onPress={() => setStatus(null)} />
        </View>
      </View>

      {status === 'received' && (
        <>
          {/* Original or photocopy */}
          <View style={styles.field}>
            <Text style={styles.label}>Original or photocopy?</Text>
            <View style={styles.chips}>
              <Chip label="Original" on={copyType === 'original'} onPress={() => setCopyType(copyType === 'original' ? null : 'original')} />
              <Chip label="Photocopy" on={copyType === 'photocopy'} onPress={() => setCopyType(copyType === 'photocopy' ? null : 'photocopy')} />
            </View>
          </View>

          {/* Place, if different from the file */}
          <View style={styles.field}>
            <Text style={styles.label}>Kept somewhere else? (optional)</Text>
            <TextInput
              value={keptAt}
              onChangeText={setKeptAt}
              placeholder="e.g. Principal's office locker"
              placeholderTextColor={colors.textMuted}
              maxLength={120}
              style={styles.input}
            />
            {places.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestions}>
                {places.map((pl) => (
                  <Chip key={pl} label={pl} small on={keptAt === pl} onPress={() => setKeptAt(pl)} />
                ))}
              </ScrollView>
            )}
            <Text style={styles.hint}>Leave empty if it is in the student’s file.</Text>
          </View>
        </>
      )}

      {/* Note */}
      {status !== null && (
        <View style={styles.field}>
          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={status === 'not_needed' ? 'e.g. Has NID instead' : 'e.g. Blurry, bring a clear copy'}
            placeholderTextColor={colors.textMuted}
            maxLength={200}
            style={styles.input}
          />
          <VoiceNoteButton leadId={leadId} context="papers" />
        </View>
      )}

      {/* Original returned */}
      {canReturn && (
        <View style={styles.returnBox}>
          <Text style={styles.label}>Original</Text>
          <Text style={styles.hint}>
            {paper.returnedAt
              ? `Returned to the student on ${shortDay(paper.returnedAt)}${paper.returnedByName ? ` by ${paper.returnedByName}` : ''}.`
              : 'The original is with us.'}
          </Text>
          <Button
            title={paper.returnedAt ? 'It is with us again' : '↩ Returned to the student'}
            variant="secondary"
            onPress={() => run(() => onReturn(!!paper.returnedAt))}
            disabled={saving}
            fullWidth
          />
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Button
        title="Save"
        onPress={() => run(() => onSave({ status, copyType: status === 'received' ? copyType : null, keptAt, note }))}
        loading={saving}
        fullWidth
      />
      <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
    </Sheet>
  );
}

// =====================================================================
// Where the student's file is kept
// =====================================================================
function PlaceSheet({
  title,
  initial,
  placeholder,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  placeholder: string;
  onClose: () => void;
  onSave: (place: string) => Promise<void>;
}) {
  const [place, setPlace] = useState(initial);
  const [places, setPlaces] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    paperPlaceSuggestions().then(setPlaces);
  }, []);

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setSaving(false);
    }
  };

  return (
    <Sheet onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>📁 {title}</Text>
      <TextInput
        value={place}
        onChangeText={setPlace}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        maxLength={120}
        autoFocus
        style={styles.input}
      />
      {places.length > 0 && (
        <View style={styles.field}>
          <Text style={styles.hint}>Used before:</Text>
          <View style={styles.chips}>
            {places.map((pl) => (
              <Chip key={pl} label={pl} small on={place === pl} onPress={() => setPlace(pl)} />
            ))}
          </View>
        </View>
      )}
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Button title="Save" onPress={() => save(place)} loading={saving} disabled={!place.trim()} fullWidth />
      {initial ? <Button title="Remove place" variant="ghost" onPress={() => save('')} disabled={saving} fullWidth /> : null}
      <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
    </Sheet>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
function Sheet({ onClose, children }: { onClose?: () => void; children: React.ReactNode }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Chip({
  label,
  on,
  color = colors.primary,
  small,
  onPress,
}: {
  label: string;
  on: boolean;
  color?: string;
  small?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, small && styles.chipSmall, on && { backgroundColor: color, borderColor: color }]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
    >
      <Text style={[styles.chipText, small && styles.chipTextSmall, on && styles.textOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardFocus: { borderColor: colors.warning, borderWidth: 1.5 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  progress: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  progressDone: { color: colors.success },
  progressMissing: { color: colors.warning },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },

  folder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  folderIcon: { fontSize: 16 },
  folderText: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  folderEmpty: { color: colors.textMuted, fontWeight: fontWeight.regular ?? '400' },
  originals: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.info },

  paperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  paperMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  box: {
    width: 26,
    height: 26,
    marginTop: 1,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.success, borderColor: colors.success },
  boxSkip: { backgroundColor: colors.textMuted, borderColor: colors.textMuted },
  paperName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  paperSkipped: { color: colors.textMuted, textDecorationLine: 'line-through' },
  reqMark: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.danger },
  paperSub: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  returned: { color: colors.info },
  paperNote: { fontSize: fontSize.caption, fontStyle: 'italic', color: colors.text, marginTop: 2 },
  more: { padding: spacing.xs },

  // Sheets
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  sheetContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
  },
  suggestions: { gap: spacing.sm, paddingVertical: 2 },
  returnBox: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    maxWidth: '100%',
  },
  chipSmall: { paddingVertical: 4, paddingHorizontal: spacing.md },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextSmall: { fontSize: fontSize.caption },
  textOn: { color: colors.textOnPrimary },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});