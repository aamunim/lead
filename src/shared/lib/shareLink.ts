import * as Clipboard from 'expo-clipboard';
import { Alert, Platform, Share } from 'react-native';

// =====================================================================
// 🔗 Share a link: the phone's share menu (WhatsApp, Messenger…);
//   the website copies it.
// =====================================================================
export async function shareLink(message: string, url: string): Promise<void> {
  if (Platform.OS === 'web') {
    await Clipboard.setStringAsync(url).catch(() => undefined);
    window.alert(`Link copied:\n${url}`);
    return;
  }
  try {
    await Share.share({ message: `${message}\n${url}` });
  } catch {
    await Clipboard.setStringAsync(url).catch(() => undefined);
    Alert.alert('Link copied', url);
  }
}

export async function copyLink(url: string): Promise<void> {
  await Clipboard.setStringAsync(url).catch(() => undefined);
  if (Platform.OS === 'web') window.alert(`Link copied:\n${url}`);
  else Alert.alert('Link copied', url);
}
