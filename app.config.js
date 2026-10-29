// Adds what app.json can't hold:
//   1. The Firebase file for Android push: only from the EAS file env var
//      GOOGLE_SERVICES_JSON (eas env:create … --type file). The copy on your PC
//      (./google-services.json, never committed) is not used, so EAS does not
//      warn that it "won't be uploaded". To build on the PC itself, run with
//      GOOGLE_SERVICES_JSON=./google-services.json.
//   2. Android 11+ only lets the app open other apps it names here
//      (WhatsApp and WhatsApp Business, for leads with only a username).
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
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

  return withWhatsAppQueries({
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  });
};
