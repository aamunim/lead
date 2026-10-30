import { LeadsListScreen } from '@/features/leads/LeadsListScreen';

// 🎓 Admitted students only: the same list and lead page as Leads
export default function StudentsScreen() {
  return <LeadsListScreen mode="students" />;
}
