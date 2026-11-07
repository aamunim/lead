import { Redirect, useLocalSearchParams } from 'expo-router';
import { Platform } from 'react-native';

import { PublicForm } from '@/features/public/PublicForm';

// 🎓 lead.ittc.edu.bd/refer/<code>: an alumnus's link (open to everyone)
export default function ReferScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  // The phone app never shows the public form: back to the app
  if (Platform.OS !== 'web') return <Redirect href="/" />;
  return <PublicForm mode="refer" code={typeof code === 'string' ? code : null} />;
}
