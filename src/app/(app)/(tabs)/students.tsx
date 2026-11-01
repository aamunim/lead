import { useWindowDimensions } from 'react-native';

import { LeadsListScreen } from '@/features/leads/LeadsListScreen';
import { isWeb } from '@/features/web/api';
import { WebStudentsScreen } from '@/features/web/students/WebStudentsScreen';

// 🎓 Admitted students only: the same list and lead page as Leads
// 🌐 On a computer screen: a table with the student in a side panel
export default function StudentsScreen() {
  const { width } = useWindowDimensions();
  if (isWeb && width >= 900) return <WebStudentsScreen />;
  return <LeadsListScreen mode="students" />;
}
