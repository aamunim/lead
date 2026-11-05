import { File, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 👤 Profile editing: name, phone, email and photo. Your own (More → My
//   profile) or, for admins, anyone's (Users → a person). Role, team and
//   status are not changed here (the database stops it anyway).
// =====================================================================

function friendly(m: string): string {
  if (/network|fetch|internet|offline/i.test(m)) return 'No internet connection. Please try again.';
  if (/already.*(registered|exists)|email.*taken/i.test(m)) return 'Someone already signs in with this email.';
  return m;
}

/** Name and phone (yours, or anyone's for an admin) */
export async function saveNamePhone(userId: string, fullName: string, phone: string): Promise<void> {
  const name = fullName.trim();
  if (name.length < 2) throw new Error('Please write the name.');
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: name, phone: phone.trim() || null })
    .eq('id', userId);
  if (error) throw new Error(friendly(error.message));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Your own sign-in email: a confirm link goes to the new address first */
export async function changeMyEmail(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new Error('That email doesn’t look right.');
  const { error } = await supabase.auth.updateUser({ email: e });
  if (error) throw new Error(friendly(error.message));
}

/** An admin sets someone else's sign-in email (at once) */
export async function adminSetEmail(userId: string, email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new Error('That email doesn’t look right.');
  const { error } = await supabase.rpc('admin_set_user_email', { p_user: userId, p_email: e });
  if (error) throw new Error(friendly(error.message));
}

/** 📷 A new photo (already cropped square by the picker): uploaded, then saved on the profile */
export async function uploadPhoto(userId: string, uri: string, mime = 'image/jpeg'): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) throw new Error('Please sign in again.');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const path = `${userId}/${Date.now()}.${ext}`;
  try {
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob();
      const { error } = await supabase.storage.from('avatars').upload(path, blob, { contentType: mime });
      if (error) throw error;
    } else {
      const res = await new File(uri).upload(
        `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/avatars/${path}`,
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
      if (res.status < 200 || res.status >= 300)
        throw new Error(
          /bucket not found/i.test(res.body) ? 'The database is not updated yet.' : 'Could not upload the photo.',
        );
    }
  } catch (e) {
    throw new Error(friendly(e instanceof Error ? e.message : 'Could not upload the photo.'));
  }
  const url = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  const { error } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', userId);
  if (error) throw new Error(friendly(error.message));
  return url;
}

export async function removePhoto(userId: string): Promise<void> {
  const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', userId);
  if (error) throw new Error(friendly(error.message));
}
