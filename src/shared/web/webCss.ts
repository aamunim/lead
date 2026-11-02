import { Platform } from 'react-native';

import { colors, isDark } from '@/shared/theme';

// =====================================================================
// 🌐 A few page-wide styles for the website (computer screens)
//   • The phone's bottom sheets (a "Close" area on top, the sheet below)
//     open as a dialog in the middle of a wide screen.
//   • Thin scroll bars, no blue box around a box being typed in.
// =====================================================================

const css = () => `
html, body { background: ${colors.background}; color-scheme: ${isDark ? 'dark' : 'light'}; }
@media (min-width: 900px) {
  [aria-modal="true"] > div > div:has(> [aria-label="Close"]:first-child + div:last-child) {
    justify-content: center !important;
    align-items: center !important;
    padding: 24px;
  }
  [aria-modal="true"] > div > div > [aria-label="Close"]:first-child:has(+ div:last-child) {
    position: absolute !important;
    inset: 0;
  }
  [aria-modal="true"] > div > div > [aria-label="Close"]:first-child + div:last-child {
    position: relative;
    z-index: 1;
    width: 560px;
    max-width: 100%;
    max-height: 88vh !important;
    border-radius: 16px !important;
    box-shadow: 0 24px 64px rgba(16, 26, 51, 0.28);
  }
}
input, textarea { outline: none; }
* { scrollbar-width: thin; scrollbar-color: ${isDark ? '#3A4560' : '#C5CCDB'} transparent; }
`;

let done = false;

export function installWebCss(): void {
  if (done || Platform.OS !== 'web' || typeof document === 'undefined') return;
  done = true;
  const el = document.createElement('style');
  el.setAttribute('data-lead-web', '');
  el.textContent = css();
  document.head.appendChild(el);
}
