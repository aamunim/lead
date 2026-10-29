// Adds what app.json can't hold:
//   1. The Firebase file for Android push.
//      - EAS build: the file env var GOOGLE_SERVICES_JSON (eas env:create … --type file)
//      - your PC:   ./google-services.json (never committed, see .gitignore)
//   2. Android 11+ only lets the app open other apps it names here
//      (WhatsApp and WhatsApp Business, for leads with only a username).
const fs = require('fs');
const { withAndroidManifest } = require('expo/config-plugins');

const OTHER_APPS = ['com.whatsapp', 'com.whatsapp.w4b'];

function withWhatsAppQueries(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    manifest.queries = manifest.queries ?? [{}];
    const queries = manifest.queries[0];
    queries.package = queries.package ?? [];
    for (const name of OTHER_APPS) {
      if (!queries.package.some((p) => p.$?.['android:name'] === name)) {
        queries.package.push({ $: { 'android:name': name } });
      }
    }
    return c;
  });
}

module.exports = ({ config }) => {
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON ??
    (fs.existsSync('./google-services.json') ? './google-services.json' : undefined);

  return withWhatsAppQueries({
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  });
};
