import { router, type Href } from 'expo-router';
import { Alert, Platform, type GestureResponderEvent } from 'react-native';

// =====================================================================
// 📸 Tap anywhere with three fingers: the screen is captured and
//   Contact developer opens with that picture already added (2.8.0+).
// =====================================================================

let pending: string | null = null;
let lastAt = 0;

/** The picture waiting for Contact developer (taken once) */
export function takePendingShot(): string | null {
  const p = pending;
  pending = null;
  return p;
}

type ViewShot = typeof import('react-native-view-shot');
function viewShot(): ViewShot | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-view-shot') as ViewShot;
  } catch {
    return null;
  }
}

export const hasScreenShot = Platform.OS !== 'web';

/** Put on the outermost view: onTouchStart={onThreeFingers} */
export function onThreeFingers(e: GestureResponderEvent): void {
  if ((e.nativeEvent.touches?.length ?? 0) < 3) return;
  const now = Date.now();
  if (now - lastAt < 3000) return;
  lastAt = now;
  const vs = viewShot();
  if (!vs) return;
  vs.captureScreen({ format: 'jpg', quality: 0.7 })
    .then((uri) => {
      Alert.alert('📸 Send this screen to the developer?', 'It opens Contact developer with this picture added.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Write a message',
          onPress: () => {
            pending = uri;
            router.push('/feedback' as Href);
          },
        },
      ]);
    })
    .catch(() => undefined);
}
