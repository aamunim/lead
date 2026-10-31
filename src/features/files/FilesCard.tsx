import * as DocumentPicker from 'expo-document-picker';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  deleteLeadFile,
  downloadAllFiles,
  getDriveStatus,
  getFilesSettings,
  isRecordedVoice,
  listLeadFiles,
  openLeadFile,
  saveZip,
  sizeText,
  uploadLeadFile,
  type LeadFile,
} from '@/features/files/api';
import { getLeadPapers, type LeadPaper } from '@/features/papers/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';
import { VoicePlayer, isAudio } from '@/features/voice/VoiceNote';
import { hasCamera } from '@/features/voice/native';
import { clock } from '@/features/voice/format';

// =====================================================================
// 📎 Files on the lead page (kept in the institute's Google Drive)
//   Upload a paper (photo / PDF from the phone or the Google Drive app),
//   open it, remove it (to Drive's Trash), or download all as one ZIP.
//   Everyone sees what they added; admins (and people allowed in
//   Settings) see all.
// =====================================================================

type Props = {
  leadId: string;
  stateKey: string;
  nameOf: (userId: string | null | undefined) => string | null;
  onChanged: (message?: string) => void;
};

// Photos, PDFs and audio (e.g. the phone's call recordings)
const TYPES = ['image/*', 'application/pdf', 'audio/*'];

const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function iconOf(f: LeadFile): string {
  if (f.kind === 'voice') return '🎙';
  if (f.mime_type?.startsWith('image/')) return '🖼';
  if (f.mime_type === 'application/pdf') return '📄';
  return '📎';
}

export function FilesCard({ leadId, stateKey, nameOf, onChanged }: Props) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [enabled, setEnabled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState<LeadFile[]>([]);
  const [papers, setPapers] = useState<LeadPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  // ▶ A voice note / audio file being played in the app
  const [playing, setPlaying] = useState<LeadFile | null>(null);
  const more = useShowMore(files, 4);

  const load = useCallback(async () => {
    try {
      const [s, d, f, p] = await Promise.all([
        getFilesSettings(),
        getDriveStatus().catch(() => ({ connected: false })),
        listLeadFiles(leadId).catch(() => []),
        getLeadPapers(leadId).catch(() => null),
      ]);
      setEnabled(s.enabled);
      setConnected(d.connected);
      // 🎙 Voice notes from the 🎙 buttons show in Calls & notes instead
      setFiles(f.filter((x) => !isRecordedVoice(x)));
      setPapers(p?.papers ?? []);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load, stateKey]);

  if (loading || !enabled) return null;

  const paperName = (id: string | null) => papers.find((p) => p.paperId === id)?.name ?? null;

  // 📷 Camera (this build has it) or 📁 a file from the phone / Google Drive app
  const upload = (paper: LeadPaper | null) => {
    setPicking(false);
    if (!hasCamera) {
      pickFile(paper);
      return;
    }
    Alert.alert(paper?.name ?? 'Upload', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: '📁 Choose a file', onPress: () => pickFile(paper) },
      { text: '📷 Take a photo', onPress: () => takePhoto(paper, 1) },
    ]);
  };

  const send = async (paper: LeadPaper | null, file: { uri: string; name: string; mimeType: string }) => {
    setUploading(paper?.name ?? file.name);
    try {
      await uploadLeadFile({
        leadId,
        kind: paper ? 'paper' : file.mimeType.startsWith('audio/') ? 'voice' : 'other',
        paperId: paper?.paperId ?? null,
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      });
      await load();
      onChanged(`📎 ${paper?.name ?? file.name} saved to Google Drive.`);
      return true;
    } catch (e) {
      Alert.alert('Could not upload', e instanceof Error ? e.message : '');
      return false;
    } finally {
      setUploading(null);
    }
  };

  const pickFile = async (paper: LeadPaper | null) => {
    const picked = await DocumentPicker.getDocumentAsync({ type: TYPES, copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets?.[0]) return;
    const a = picked.assets[0];
    const ext = a.name.includes('.') ? a.name.slice(a.name.lastIndexOf('.')) : '';
    await send(paper, {
      uri: a.uri,
      name: paper ? `${paper.name}${ext}` : a.name,
      mimeType: a.mimeType ?? 'application/octet-stream',
    });
  };

  // One photo per page; after each, "Another page?"
  const takePhoto = async (paper: LeadPaper | null, page: number) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera not allowed', 'Allow it in the phone’s Settings → Apps → Lead Management → Permissions → Camera.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5, allowsEditing: true });
    if (shot.canceled || !shot.assets?.[0]) return;
    const base = paper?.name ?? `Photo ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const ok = await send(paper, {
      uri: shot.assets[0].uri,
      name: `${base}${page > 1 ? ` (${page})` : ''}.jpg`,
      mimeType: shot.assets[0].mimeType ?? 'image/jpeg',
    });
    if (!ok) return;
    Alert.alert('Another page?', paper ? `Take one more photo for ${paper.name}?` : undefined, [
      { text: 'Done', style: 'cancel' },
      { text: '📷 Next page', onPress: () => takePhoto(paper, page + 1) },
    ]);
  };

  const open = async (f: LeadFile) => {
    if (isAudio(f)) {
      setPlaying(f);
      return;
    }
    setOpening(f.id);
    try {
      await openLeadFile(f);
    } catch (e) {
      Alert.alert('Could not open', e instanceof Error ? e.message : '');
    } finally {
      setOpening(null);
    }
  };

  // 📦 Every file here in one ZIP: save it to a folder, or share it
  const downloadAll = async () => {
    setZipping(true);
    try {
      const zip = await downloadAllFiles(leadId);
      const keep = (how: 'save' | 'share') =>
        saveZip(zip, how)
          .then((done) => done && how === 'save' && onChanged(`📦 ${zip.name} saved.`))
          .catch((e) => Alert.alert('Could not save', e instanceof Error ? e.message : ''));
      Alert.alert('ZIP ready', `${zip.name} (${files.length} files)`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Share', onPress: () => keep('share') },
        ...(Platform.OS === 'android' ? [{ text: 'Save to phone', onPress: () => keep('save') }] : []),
      ]);
    } catch (e) {
      Alert.alert('Could not download', e instanceof Error ? e.message : '');
    } finally {
      setZipping(false);
    }
  };

  const remove = (f: LeadFile) => {
    if (f.uploaded_by !== profile?.id && !isAdmin) return;
    Alert.alert('Remove this file?', `${f.name} will be removed here and moved to Google Drive's Trash (it can be brought back from there for 30 days).`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            const drive = await deleteLeadFile(f.id);
            await load();
            onChanged(drive === 'trashed' ? 'File removed (moved to Google Drive’s Trash).' : 'File removed here; it is still in Google Drive.');
          } catch (e) {
            Alert.alert('Could not remove', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>📎 Files</Text>
        {connected && (
          <View style={styles.actions}>
            {files.length >= 2 &&
              (zipping ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Pressable
                  onPress={downloadAll}
                  disabled={!!uploading}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Download all files as one ZIP"
                >
                  <Text style={styles.link}>⬇ All</Text>
                </Pressable>
              ))}
            <Pressable onPress={() => setPicking(true)} disabled={!!uploading} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>＋ Upload</Text>
            </Pressable>
          </View>
        )}
      </View>

      {!connected ? (
        <Pressable
          onPress={isAdmin ? () => router.push('/settings/drive' as Href) : undefined}
          accessibilityRole={isAdmin ? 'link' : undefined}
        >
          <Text style={styles.hint}>
            Google Drive is not connected yet.
            {isAdmin ? ' Tap to connect it (Settings → Google Drive).' : ' An admin can connect it in Settings.'}
          </Text>
        </Pressable>
      ) : files.length === 0 && !uploading ? (
        <Text style={styles.hint}>No files yet. Upload a paper’s photo or PDF; it is saved in Google Drive.</Text>
      ) : null}

      {uploading && (
        <View style={styles.row}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.meta}>Uploading {uploading}…</Text>
        </View>
      )}

      {more.visible.map((f) => (
        <Pressable
          key={f.id}
          onPress={() => open(f)}
          onLongPress={() => remove(f)}
          style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityHint="Opens the file. Press and hold to remove."
        >
          <Text style={styles.icon}>{iconOf(f)}</Text>
          <View style={styles.flex}>
            <Text style={styles.name} numberOfLines={1}>
              {f.kind === 'paper' && paperName(f.paper_id) ? paperName(f.paper_id) : f.name}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {[f.duration_sec ? `▶ ${clock(f.duration_sec)}` : sizeText(f.size_bytes), when(f.created_at), nameOf(f.uploaded_by)]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          {opening === f.id ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.chevron}>›</Text>}
        </Pressable>
      ))}
      <ShowMoreButton {...more} />

      <VoicePlayer file={playing} onClose={() => setPlaying(null)} />

      {/* Which paper is this? */}
      <Modal visible={picking} transparent animationType="slide" onRequestClose={() => setPicking(false)}>
        <View style={styles.backdrop}>
          <Pressable style={styles.flex} onPress={() => setPicking(false)} accessibilityLabel="Close" />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <ScrollView contentContainerStyle={styles.sheetContent}>
              <Text style={styles.sheetTitle}>Upload: which paper?</Text>
              <Text style={styles.meta}>
                {hasCamera
                  ? 'Then take a photo, or choose a photo / PDF / audio file (from the phone, or the Google Drive app).'
                  : 'Then choose a photo, PDF or audio file (from the phone, or the Google Drive app).'}
              </Text>
              <View style={styles.chips}>
                {papers.map((p) => {
                  const has = files.some((f) => f.paper_id === p.paperId);
                  return (
                    <Pressable key={p.paperId} onPress={() => upload(p)} style={styles.chip} accessibilityRole="button">
                      <Text style={styles.chipText}>
                        {has ? '✓ ' : ''}
                        {p.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Button title="Something else" variant="secondary" onPress={() => upload(null)} fullWidth />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  pressed: { opacity: 0.7 },
  icon: { fontSize: fontSize.title },
  name: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chevron: { fontSize: 22, color: colors.textMuted },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '80%',
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
});
