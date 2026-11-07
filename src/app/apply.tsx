import { Redirect, useLocalSearchParams } from 'expo-router';
import { Platform } from 'react-native';

import { PublicForm } from '@/features/public/PublicForm';

// 🙋 lead.ittc.edu.bd/apply: anyone interested in admission (open to everyone);
//   ?ref=<code> makes it an alumnus's referral
export default function ApplyScreen() {
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  // The phone app never shows the public form: back to the app
  if (Platform.OS !== 'web') return <Redirect href="/" />;
  return <PublicForm mode="apply" code={typeof ref === 'string' ? ref : null} />;
}
