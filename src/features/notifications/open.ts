import { router, type Href } from 'expo-router';

// =====================================================================
// Where a notification takes you (from the 🔔 list, or a tapped push)
//   lead_id  → the lead · lead_ids → the leads list with just those
//   route    → that screen (e.g. /users)
// =====================================================================
export function openNotificationTarget(data: { lead_id?: string; lead_ids?: string[]; route?: string } | null) {
  if (!data) return;
  if (data.lead_id) {
    router.push(`/leads/${data.lead_id}` as Href);
  } else if (data.lead_ids && data.lead_ids.length > 0) {
    router.push({ pathname: '/leads', params: { ids: data.lead_ids.join(',') } } as unknown as Href);
  } else if (data.route) {
    router.push(data.route as Href);
  }
}
