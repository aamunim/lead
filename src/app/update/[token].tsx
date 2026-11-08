import { Redirect, useLocalSearchParams } from 'expo-router';
import { Platform } from 'react-native';

import { PublicUpdateForm } from '@/features/public/PublicForm';

// ✍️ lead.ittc.edu.bd/update/<token>: an alumnus updates their own details (open to everyone)
export default function AlumniUpdateScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  // The phone app never shows the public form: back to the app
  if (Platform.OS !== 'web') return <Redirect href="/" />;
  return <PublicUpdateForm token={typeof token === 'string' ? token : null} />;
}
