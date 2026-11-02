import { Stack } from 'expo-router';

import { PhotoStudio } from '@/features/photo/PhotoStudio';
import { isWeb } from '@/features/web/api';

// 🖼 Photo Studio (website): any photo → the size you need
export default function PhotoStudioScreen() {
  return (
    <>
      {/* the website's top bar shows the name */}
      <Stack.Screen options={{ title: 'Photo Studio', headerShown: !isWeb }} />
      <PhotoStudio />
    </>
  );
}
