import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { Alert, Platform } from 'react-native';

import { sizeText, uploadLeadFile } from '@/features/files/api';
import { PassportEditor } from '@/features/files/PassportEditor';
import { prepareImage } from '@/features/files/prepareImage';
import { ruleFor } from '@/features/files/uploadRules';
import { hasCamera } from '@/features/voice/native';

// =====================================================================
// 📎 Upload a paper (or any file) for a lead, the same everywhere:
//   the lead page's Files card and the website's table row.
//   Camera or a file; on the website the paper's upload rule (size, KB,
//   passport photo editor); PDFs are made smaller on the server.
// =====================================================================

export type UploadPaper = { paperId: string; name: string };

const TYPES = ['image/*', 'application/pdf', 'audio/*'];

export function usePaperUpload(leadId: string, onUploaded: (message: string) => Promise<void> | void) {
  const [uploading, setUploading] = useState<string | null>(null);
  // 🪪 Website: the passport photo editor, waiting for "Use this" (or Cancel)
  const [editor, setEditor] = useState<{
    source: Blob;
    title: string;
    width: number;
    height: number;
    bgColor: string;
    facePct: number;
    done: (picture: Blob | null) => void;
  } | null>(null);

  // 📷 Camera (this build has it) or 📁 a file from the phone / Google Drive app
  const upload = (paper: UploadPaper | null) => {
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

  const send = async (
    paper: UploadPaper | null,
    file: { uri: string; name: string; mimeType: string; blob?: Blob | null },
  ) => {
    setUploading(paper?.name ?? file.name);
    try {
      let { name, mimeType } = file;
      let blob: Blob | null = file.blob ?? null;
      let originalSize: number | null = null;
      let note = '';
      // 🌐 Website: the paper's upload rule (Settings → Upload rules)
      if (Platform.OS === 'web') {
        const rule = await ruleFor(paper?.paperId ?? null);
        const isImage = mimeType.startsWith('image/');
        const isPdf = mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
        if (rule.accept === 'image' && !isImage)
          throw new Error(`${paper?.name ?? 'This paper'}: only a picture can be uploaded.`);
        if (rule.accept === 'pdf' && !isPdf)
          throw new Error(`${paper?.name ?? 'This paper'}: only a PDF can be uploaded.`);
        // 🖼 A picture: the set size, then under the KB limit (JPEG)
        if (isImage && !/gif|svg/.test(mimeType)) {
          const source = blob ?? (await (await fetch(file.uri)).blob());
          let picture: Blob = source;
          // 🪪 Passport photo: the person cut out, the head placed; checked in the editor
          if (rule.passport && rule.exact) {
            const exact = rule.exact;
            const pass = rule.passport;
            setUploading(null);
            const edited = await new Promise<Blob | null>((done) =>
              setEditor({
                source,
                title: paper?.name ?? 'Photo',
                width: exact.width,
                height: exact.height,
                bgColor: pass.bgColor,
                facePct: pass.facePct,
                done,
              }),
            );
            setEditor(null);
            if (!edited) return false; // cancelled
            setUploading(paper?.name ?? file.name);
            picture = edited;
          }
          const out = await prepareImage(picture, { exact: rule.exact, maxSide: rule.maxSide, maxKb: rule.imgMaxKb });
          originalSize = source.size;
          blob = out.blob;
          mimeType = 'image/jpeg';
          name = name.replace(/\.[^.]+$/, '') + '.jpg';
          note = ` · 🖼 ${sizeText(source.size)} → ${sizeText(out.blob.size)} (${out.width}×${out.height})${
            out.underLimit ? '' : ` · still over ${rule.imgMaxKb} KB`
          }`;
        }
      }
      const row = await uploadLeadFile({
        leadId,
        kind: paper ? 'paper' : mimeType.startsWith('audio/') ? 'voice' : 'other',
        paperId: paper?.paperId ?? null,
        uri: file.uri,
        name,
        mimeType,
        file: blob,
        originalSize,
      });
      if (row.compressed) note = ` · 📄 ${sizeText(row.compressed.from)} → ${sizeText(row.compressed.to)}`;
      await onUploaded(`📎 ${paper?.name ?? name} saved to Google Drive${note}.`);
      return true;
    } catch (e) {
      Alert.alert('Could not upload', e instanceof Error ? e.message : '');
      return false;
    } finally {
      setUploading(null);
    }
  };

  const pickFile = async (paper: UploadPaper | null) => {
    const picked = await DocumentPicker.getDocumentAsync({ type: TYPES, copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets?.[0]) return;
    const a = picked.assets[0];
    const ext = a.name.includes('.') ? a.name.slice(a.name.lastIndexOf('.')) : '';
    await send(paper, {
      uri: a.uri,
      name: paper ? `${paper.name}${ext}` : a.name,
      mimeType: a.mimeType ?? 'application/octet-stream',
      // 🌐 the browser's own file
      blob: (a as { file?: File }).file ?? null,
    });
  };

  // One photo per page; after each, "Another page?"
  const takePhoto = async (paper: UploadPaper | null, page: number) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Camera not allowed',
        'Allow it in the phone’s Settings → Apps → Lead Management → Permissions → Camera.',
      );
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5, allowsEditing: true });
    if (shot.canceled || !shot.assets?.[0]) return;
    const base =
      paper?.name ??
      `Photo ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
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

  const ui = editor ? (
    <PassportEditor
      source={editor.source}
      title={editor.title}
      width={editor.width}
      height={editor.height}
      bgColor={editor.bgColor}
      facePct={editor.facePct}
      onCancel={() => editor.done(null)}
      onDone={(picture) => editor.done(picture)}
    />
  ) : null;

  return { upload, uploading, ui };
}
