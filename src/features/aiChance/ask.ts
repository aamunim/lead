import { Alert, Platform } from 'react-native';

/** A question with choices (web: the browser's OK / Cancel, OK = the first choice) */
export function ask(title: string, text: string, buttons: { label: string; run: () => void; danger?: boolean }[]) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${text}\n\nOK = ${buttons[0].label}`)) buttons[0].run();
    return;
  }
  Alert.alert(title, text, [
    { text: 'Cancel', style: 'cancel' },
    ...buttons.map((b) => ({ text: b.label, style: b.danger ? ('destructive' as const) : undefined, onPress: b.run })),
  ]);
}
