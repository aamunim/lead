import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { ChatView } from '@/features/feedback/ChatView';
import { PersonInfo } from '@/features/feedback/PersonInfo';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight } from '@/shared/theme';

// =====================================================================
// 💬 The developer's chat with one person (from the inbox or a
//   notification): /feedback/chat?u=<their id>
// =====================================================================

export default function DeveloperChatScreen() {
  const { u } = useLocalSearchParams<{ u: string }>();
  const { profile } = useAuth();
  const [person, setPerson] = useState<{ name: string; avatar: string | null } | null>(null);
  const [info, setInfo] = useState(false);

  useEffect(() => {
    if (!u) return;
    supabase
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', u)
      .maybeSingle()
      .then(({ data }) => setPerson({ name: data?.full_name ?? 'Someone', avatar: data?.avatar_url ?? null }));
  }, [u]);

  if (!u || !profile?.id || !person) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Chat' }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: person.name }} />
      <ChatView
        chatUser={u}
        me={profile.id}
        isDev
        otherName={person.name}
        otherAvatar={person.avatar}
        headerRight={
          <View style={styles.right}>
            <Pressable
              onPress={() => setInfo(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Phone and app"
            >
              <Text style={styles.link}>ℹ️</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push(`/users/${u}` as Href)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Open the person"
            >
              <Text style={styles.link}>👤</Text>
            </Pressable>
          </View>
        }
      />
      {info && <PersonInfo chatUser={u} name={person.name} onClose={() => setInfo(false)} />}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  right: { flexDirection: 'row', gap: 14 },
  link: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
});
