import { Redirect } from 'expo-router';

// Google sends the admin back with leadmanagement://drive-connected:
// show the Google Drive settings (they reload the connection state)
export default function DriveConnected() {
  return <Redirect href="/settings/drive" />;
}
