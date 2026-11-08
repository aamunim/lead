import { Modal as RNModal, Platform, StyleSheet, View, type ModalProps } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/shared/theme';

// =====================================================================
// 📱 A Modal (popup / bottom sheet) that never goes under the phone's
//   ◁ ○ □ buttons or the gesture line.
//   The app draws edge to edge, so a plain Modal reaches the very bottom
//   of the screen. This one keeps its content above the buttons and
//   fills the strip behind them:
//     · slide-up sheets and full pages: the sheet's white, so the sheet
//       looks like it runs to the bottom edge
//     · fade popups (a box in the middle, a menu): the dimmed backdrop
//   Use it everywhere instead of react-native's Modal.
// =====================================================================

export function Modal({
  children,
  bottomFill,
  keyboard,
  ...props
}: ModalProps & {
  /** Colour behind the phone's buttons (when the default doesn't match) */
  bottomFill?: string;
  /** ⌨️ A sheet with text fields: it moves up above the keyboard */
  keyboard?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const bottom = Platform.OS === 'web' ? 0 : insets.bottom;
  const fill =
    bottomFill ?? (props.transparent && props.animationType === 'fade' ? 'rgba(0,0,0,0.45)' : colors.surface);

  return (
    <RNModal {...props}>
      <View style={styles.flex}>
        {keyboard ? (
          <KeyboardAvoidingView style={styles.flex} behavior="padding">
            {children}
          </KeyboardAvoidingView>
        ) : (
          <View style={styles.flex}>{children}</View>
        )}
        {bottom > 0 && <View style={{ height: bottom, backgroundColor: fill }} />}
      </View>
    </RNModal>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
