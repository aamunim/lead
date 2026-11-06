import { createElement, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { downloadLeadFile, listLeadFiles, type LeadFile } from '@/features/files/api';
import { usePaperUpload } from '@/features/files/usePaperUpload';
import { copyLabel, getLeadPapers, setLeadPaper, type LeadPaper, type LeadPapers } from '@/features/papers/api';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐📄 A student's papers from the Students table:
//   ✅ tick what came in · 📎 upload (or drop a file on the paper) ·
//   👁 see what was uploaded · what is still missing.
// =====================================================================

export function PapersPopup({
  leadId,
  name,
  onClose,
  onOpen,
  onChanged,
}: {
  leadId: string;
  name: string;
  onClose: () => void;
  onOpen: () => void;
  /** something changed: the table refreshes */
  onChanged?: (message: string) => void;
}) {
  const [data, setData] = useState<LeadPapers | null>(null);
  const [files, setFiles] = useState<LeadFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([getLeadPapers(leadId), listLeadFiles(leadId).catch(() => [] as LeadFile[])]);
      setData(p);
      setFiles(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the papers.');
    }
  }, [leadId]);
  useEffect(() => {
    load();
  }, [load]);

  const uploader = usePaperUpload(leadId, async (message) => {
    setNote(message);
    await load();
    onChanged?.(message);
  });

  const tick = async (p: LeadPaper) => {
    setBusy(p.paperId);
    setError(null);
    try {
      await setLeadPaper(leadId, p.paperId, {
        status: p.status ? null : 'received',
        copyType: p.status ? null : (p.copyType ?? 'photocopy'),
      });
      await load();
      onChanged?.(p.status ? `${p.name}: unticked.` : `✅ ${p.name} received.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const view = async (f: LeadFile) => {
    try {
      const file = await downloadLeadFile(f);
      window.open((file as unknown as { uri: string }).uri, '_blank');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the file.');
    }
  };

  // The passport photo editor (from an upload rule) covers everything while open
  if (uploader.ui) return <>{uploader.ui}</>;

  const list = data?.papers.filter((p) => p.isRequired || p.status !== null) ?? [];
  const extra = data?.papers.filter((p) => !p.isRequired && p.status === null) ?? [];
  const other = files.filter((f) => !f.paper_id && f.kind !== 'voice' && !f.mime_type?.startsWith('audio/'));

  const row = (p: LeadPaper) => {
    const mine = files.filter((f) => f.paper_id === p.paperId);
    const ok = p.status !== null;
    const bits = [
      p.status === 'not_needed' ? 'Not needed' : copyLabel(p.copyType),
      p.returnedAt ? 'Returned' : null,
      p.keptAt ? `at ${p.keptAt}` : null,
      !p.isRequired ? 'optional' : null,
    ].filter(Boolean);
    const body = (
      <View style={[styles.row, over === p.paperId && styles.rowOver]}>
        <Pressable
          onPress={() => tick(p)}
          disabled={busy === p.paperId || p.status === 'not_needed'}
          style={[styles.check, ok && styles.checkOn]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ok }}
          accessibilityLabel={`${p.name} received`}
        >
          {busy === p.paperId ? (
            <ActivityIndicator size="small" color={ok ? '#fff' : colors.primary} />
          ) : (
            <Text style={styles.checkMark}>{ok ? '✓' : ''}</Text>
          )}
        </Pressable>
        <View style={styles.flex}>
          <Text style={[styles.name, !ok && p.isRequired && styles.missing]}>{p.name}</Text>
          {(bits.length > 0 || mine.length > 0) && (
            <View style={styles.files}>
              {bits.length > 0 && <Text style={styles.muted}>{bits.join(' · ')}</Text>}
              {mine.map((f) => (
                <Pressable
                  key={f.id}
                  onPress={() => view(f)}
                  style={(s) => [styles.file, (s as { hovered?: boolean }).hovered && styles.fileHover]}
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${f.name}`}
                >
                  <Text style={styles.fileText} numberOfLines={1}>
                    {f.mime_type?.startsWith('image/') ? '🖼' : '📄'} {f.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
        <Pressable
          onPress={() => uploader.upload({ paperId: p.paperId, name: p.name })}
          disabled={!!uploader.uploading}
          style={(s) => [styles.upload, (s as { hovered?: boolean }).hovered && styles.uploadHover]}
          accessibilityRole="button"
          accessibilityLabel={`Upload ${p.name}`}
        >
          <Text style={styles.uploadText}>📎 Upload</Text>
        </Pressable>
      </View>
    );
    // 🖱 Drop a file on the paper
    return createElement(
      'div',
      {
        key: p.paperId,
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          setOver(p.paperId);
        },
        onDragLeave: () => setOver((x) => (x === p.paperId ? null : x)),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setOver(null);
          const file = e.dataTransfer?.files?.[0];
          if (file) uploader.drop({ paperId: p.paperId, name: p.name }, file);
        },
      },
      body,
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.back} onPress={onClose} accessibilityLabel="Close papers">
        <Pressable style={styles.box} onPress={() => undefined}>
          <View style={styles.head}>
            <View style={styles.flex}>
              <Text style={styles.title}>📄 Papers</Text>
              <Text style={styles.sub}>{name}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.x}>✕</Text>
            </Pressable>
          </View>
          {!data ? (
            error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            )
          ) : (
            <>
              <View style={styles.summary}>
                <Text style={[styles.big, data.done < data.required ? styles.warn : styles.good]}>
                  {data.required ? `${data.done}/${data.required}` : '—'}
                </Text>
                <View style={styles.flex}>
                  <Text style={styles.summaryText}>
                    {data.required === 0
                      ? 'No papers are needed for this course.'
                      : data.done < data.required
                        ? `${data.required - data.done} required paper${data.required - data.done > 1 ? 's' : ''} missing`
                        : 'All required papers are in ✓'}
                  </Text>
                  <Text style={styles.muted}>
                    {data.originalsHeld
                      ? `${data.originalsHeld} original${data.originalsHeld > 1 ? 's' : ''} with us · `
                      : ''}
                    {data.folder ? `📁 ${data.folder} · ` : ''}Tick, upload, or drop a file on a paper.
                  </Text>
                </View>
              </View>
              {uploader.uploading && (
                <View style={styles.busy}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.muted}>Uploading {uploader.uploading}…</Text>
                </View>
              )}
              {note && !uploader.uploading && <Text style={styles.note}>{note}</Text>}
              {error && <Text style={styles.error}>{error}</Text>}

              <ScrollView style={styles.list}>
                {list.map(row)}
                {extra.length > 0 && <Text style={styles.label}>OTHER PAPERS (OPTIONAL)</Text>}
                {extra.map(row)}
                {other.length > 0 && <Text style={styles.label}>OTHER FILES</Text>}
                {other.map((f) => (
                  <Pressable
                    key={f.id}
                    onPress={() => view(f)}
                    style={(s) => [styles.otherRow, (s as { hovered?: boolean }).hovered && styles.fileHover]}
                    accessibilityRole="link"
                  >
                    <Text style={styles.fileText} numberOfLines={1}>
                      {f.mime_type?.startsWith('image/') ? '🖼' : '📄'} {f.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}

          <View style={styles.buttons}>
            <Pressable
              onPress={() => uploader.upload(null)}
              disabled={!!uploader.uploading}
              style={styles.ghost}
              accessibilityRole="button"
            >
              <Text style={styles.ghostText}>📎 Other file</Text>
            </Pressable>
            <View style={styles.flex} />
            <Pressable onPress={onClose} style={styles.outline} accessibilityRole="button">
              <Text style={styles.outlineText}>Close</Text>
            </Pressable>
            <Pressable onPress={onOpen} style={styles.btn} accessibilityRole="button">
              <Text style={styles.btnText}>Open student</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  back: {
    flex: 1,
    backgroundColor: 'rgba(16,26,51,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  box: {
    width: '100%',
    maxWidth: 600,
    maxHeight: '90%',
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: 16,
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  x: { fontSize: 18, color: colors.textMuted, padding: 4 },
  loader: { marginVertical: spacing.xl },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: isDark ? '#141C2E' : '#F5F7FC',
    borderWidth: 1,
    borderColor: colors.border,
  },
  big: { fontSize: fontSize.heading, fontWeight: fontWeight.bold },
  summaryText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  good: { color: colors.success },
  warn: { color: colors.warning },
  muted: { flexShrink: 1, fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.success, fontWeight: fontWeight.semibold },
  busy: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  list: { marginTop: spacing.xs, maxHeight: 420 },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.6,
    marginTop: spacing.md,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderBottomColor: colors.border,
  },
  rowOver: { borderColor: colors.primary, backgroundColor: colors.primarySoft, borderStyle: 'dashed' },
  check: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: isDark ? '#4A5573' : '#B5BED3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.success, borderColor: colors.success },
  checkMark: { color: '#fff', fontSize: 14, fontWeight: fontWeight.bold },
  name: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  missing: { color: colors.warning },
  files: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 },
  file: {
    maxWidth: 220,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: isDark ? '#1D2740' : '#EEF2FB',
  },
  fileHover: { backgroundColor: colors.primarySoft },
  fileText: { fontSize: fontSize.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  otherRow: { paddingVertical: 6, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
  upload: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  uploadHover: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  uploadText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  error: { fontSize: fontSize.small, color: colors.danger },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  btn: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  outline: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  outlineText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  ghost: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.sm },
  ghostText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
