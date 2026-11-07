import { useLocalSearchParams } from 'expo-router';

import { PublicForm } from '@/features/public/PublicForm';

// 🎓 lead.ittc.edu.bd/refer/<code>: an alumnus's link (open to everyone)
export default function ReferScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  return <PublicForm mode="refer" code={typeof code === 'string' ? code : null} />;
}
