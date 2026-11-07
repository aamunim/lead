import { useLocalSearchParams } from 'expo-router';

import { PublicForm } from '@/features/public/PublicForm';

// 🙋 lead.ittc.edu.bd/apply: anyone interested in admission (open to everyone);
//   ?ref=<code> makes it an alumnus's referral
export default function ApplyScreen() {
  const { ref } = useLocalSearchParams<{ ref?: string }>();
  return <PublicForm mode="apply" code={typeof ref === 'string' ? ref : null} />;
}
