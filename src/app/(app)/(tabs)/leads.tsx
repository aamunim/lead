import { Redirect } from 'expo-router';

import { LeadsListScreen } from '@/features/leads/LeadsListScreen';
import { isWeb } from '@/features/web/api';

export default function LeadsScreen() {
  // 🌐 The website has no Leads module (yet)
  if (isWeb) return <Redirect href="/students" />;
  return <LeadsListScreen mode="leads" />;
}
