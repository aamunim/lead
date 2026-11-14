import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { isDeveloper } from '@/features/feedback/api';
import { ChatView } from '@/features/feedback/ChatView';
import { takePendingShot } from '@/features/feedback/screenShot';
import { colors } from '@/shared/theme';

// =====================================================================
// 💬 More → Contact developer: my one chat with the developer, with the
//   topics (🐞 problems · 💡 ideas · ❓ questions) inside. A three-finger
//   screenshot opens it with the picture and a new 🐞 problem ready.
// =====================================================================

export default function ContactDeveloperScreen() {
  const { profile } = useAuth();
  const [dev, setDev] = useState<boolean | null>(null);
  const [shot] = useState(() => takePendingShot());

  useEffect(() => {
    isDeveloper()
      .then(setDev)
      .catch(() => setDev(false));
  }, []);

  // The developer has everyone's chats in the inbox
  if (dev) return <Redirect href="/feedback/inbox" />;
  if (dev === null || !profile?.id) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Contact developer' }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" automaticOffset>
      <Stack.Screen options={{ title: 'Contact developer' }} />
      <ChatView
        chatUser={profile.id}
        me={profile.id}
        isDev={false}
        otherName="Developer"
        firstFiles={shot ? [{ uri: shot, mime: 'image/jpeg' }] : undefined}
        startTopic={shot ? 'bug' : null}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
