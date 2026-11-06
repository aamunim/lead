import * as Device from 'expo-device';
import { Platform } from 'react-native';

// =====================================================================
// 📱🖥 What to call this device in Team activity, App versions, Push health:
//   phone → "Xiaomi Redmi 9"; website → "🌐 Chrome 131 · Windows PC"
// =====================================================================

type UAData = { brands?: { brand: string; version: string }[]; mobile?: boolean; platform?: string };

function browserName(ua: string, data: UAData | undefined): string {
  // Chromium browsers tell their real name in userAgentData
  const brand = data?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand));
  if (brand) return `${brand.brand.replace(/^(Google|Microsoft) /, '')} ${brand.version.split('.')[0]}`;
  const pick: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/UCBrowser\/(\d+)/, 'UC Browser'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+)[\d.]* .*Safari/, 'Safari'],
  ];
  for (const [re, name] of pick) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]}`;
  }
  return 'Browser';
}

function systemName(ua: string, data: UAData | undefined): string {
  const p = (data?.platform ?? '').toLowerCase();
  const mobile = data?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(ua);
  if (p === 'windows' || /Windows NT/i.test(ua)) return 'Windows PC';
  if (p === 'macos' || /Macintosh|Mac OS X/i.test(ua)) return /iPad|iPhone/.test(ua) ? 'iPhone / iPad' : 'Mac';
  if (p === 'chrome os' || /CrOS/i.test(ua)) return 'Chromebook';
  if (p === 'android' || /Android/i.test(ua)) return mobile ? 'Android phone' : 'Android tablet';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
  if (p === 'linux' || /Linux/i.test(ua)) return 'Linux PC';
  return mobile ? 'Phone' : 'PC';
}

let cached: string | undefined;

export function deviceLabel(): string | undefined {
  if (cached !== undefined) return cached;
  if (Platform.OS === 'web') {
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      const ua = nav?.userAgent ?? '';
      const data = (nav as unknown as { userAgentData?: UAData } | undefined)?.userAgentData;
      cached = `🌐 ${browserName(ua, data)} · ${systemName(ua, data)}`;
    } catch {
      cached = '🌐 Website';
    }
    return cached;
  }
  cached = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || undefined;
  return cached;
}
