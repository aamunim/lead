import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

// =====================================================================
// 🎙📷 Is the microphone / camera part in this app build?
//   Builds before 2.6.0 don't have them: the buttons stay hidden there and
//   the screens that use them are only loaded (require) when present, so
//   an update never crashes an older app.
// =====================================================================
export const hasAudio = Platform.OS !== 'web' && !!requireOptionalNativeModule('ExpoAudio');
export const hasCamera = Platform.OS !== 'web' && !!requireOptionalNativeModule('ExponentImagePicker');
