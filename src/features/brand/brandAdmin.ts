import { File, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from '@/shared/lib/supabase';

import { LOGO_PATH, loadBrand, type BrandSaved } from './brand';

// =====================================================================
// 🎨 Settings → Branding (Super Admin only; the database checks it too):
//   read and save the branding, upload and remove logo pictures.
//   Kept apart from brand.ts so app start loads none of this.
// =====================================================================

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const LOGO_MAX = 1024 * 1024;

/** What is saved now (for the Settings page; empty fields = the app's own) */
export async function getBrandSaved(): Promise<BrandSaved> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'branding').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('The database is not updated yet (Branding).');
  return ((data as { value: BrandSaved }).value ?? {}) as BrandSaved;
}

export async function saveBrand(next: BrandSaved): Promise<void> {
  const { data, error } = await supabase
    .from('app_settings')
    .update({ value: next as never })
    .eq('key', 'branding')
    .select('key');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('Could not save. Only a Super Admin can change the branding.');
  await loadBrand(true);
}

/** 🖼 A new logo picture → its place in the branding folder (saved with the rest on Save) */
export async function uploadLogo(uri: string, mime: string): Promise<string> {
  if (!LOGO_TYPES.includes(mime)) throw new Error('Choose a PNG, JPG or WEBP picture.');
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) throw new Error('Please sign in again.');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const path = `logo/${Date.now()}.${ext}`;
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    if (blob.size > LOGO_MAX) throw new Error('The picture is too big (1 MB at most).');
    const { error } = await supabase.storage.from('branding').upload(path, blob, { contentType: mime });
    if (error) throw new Error(/bucket/i.test(error.message) ? 'The database is not updated yet.' : error.message);
  } else {
    const res = await new File(uri).upload(
      `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/branding/${path}`,
      {
        httpMethod: 'POST',
        uploadType: UploadType.BINARY_CONTENT,
        mimeType: mime,
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
          'Content-Type': mime,
        },
      },
    );
    if (res.status < 200 || res.status >= 300) {
      if (/bucket not found/i.test(res.body)) throw new Error('The database is not updated yet.');
      if (/too large|exceeded|size/i.test(res.body)) throw new Error('The picture is too big (1 MB at most).');
      throw new Error('Could not upload the picture.');
    }
  }
  return path;
}

/** Remove logo pictures nobody uses any more (quietly; a leftover does no harm) */
export async function removeLogos(paths: (string | null | undefined)[]): Promise<void> {
  const list = [...new Set(paths.filter((p): p is string => !!p && LOGO_PATH.test(p)))];
  if (list.length)
    await supabase.storage
      .from('branding')
      .remove(list)
      .catch(() => undefined);
}
