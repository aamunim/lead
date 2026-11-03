import { useWindowDimensions } from 'react-native';

import { LeadsListScreen } from '@/features/leads/LeadsListScreen';
import { isWeb } from '@/features/web/api';
import { WebStudentsScreen } from '@/features/web/students/WebStudentsScreen';

// 📋 Leads · 🌐 on a computer screen: a table (or the board) with the lead in a side panel
export default function LeadsScreen() {
  const { width } = useWindowDimensions();
  if (isWeb && width >= 900) return <WebStudentsScreen mode="leads" />;
  return <LeadsListScreen mode="leads" />;
}
