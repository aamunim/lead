import { useEffect, useState } from 'react';
import { Image, type ImageSourcePropType, type ImageStyle, type StyleProp } from 'react-native';

import { useBrand } from './brand';

// =====================================================================
// 🖼 The college logo: the one from Settings → Branding, or the app's own
//   when none is set, or it can't load (offline the first time, removed).
//   Decoded at the size it is shown (a big upload costs no memory).
// =====================================================================

export function BrandLogo({
  own,
  style,
  uri,
}: {
  own: ImageSourcePropType;
  style: StyleProp<ImageStyle>;
  /** a picture to show instead (the Settings preview) */
  uri?: string | null;
}) {
  const brand = useBrand();
  const url = uri === undefined ? brand.logo_url : uri;
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [url]);
  const useOwn = !url || failed === url;
  return (
    <Image
      source={useOwn ? own : { uri: url }}
      style={style}
      resizeMode="contain"
      resizeMethod="resize"
      onError={() => url && setFailed(url)}
      accessibilityLabel="Logo"
    />
  );
}
