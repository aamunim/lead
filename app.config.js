// Adds what app.json can't hold:
//   1. The Firebase file for Android push: only from the EAS file env var
//      GOOGLE_SERVICES_JSON (eas env:create … --type file). The copy on your PC
//      (./google-services.json, never committed) is not used, so EAS does not
//      warn that it "won't be uploaded". To build on the PC itself, run with
//      GOOGLE_SERVICES_JSON=./google-services.json.
//   2. Android 11+ only lets the app open other apps it names here
//      (WhatsApp and WhatsApp Business, for leads with only a username).
//   3. Building the .aab on your own PC (not EAS): sign it with the Play
//      upload key when these are in ~/.gradle/gradle.properties:
//        LEAD_UPLOAD_STORE_FILE, LEAD_UPLOAD_STORE_PASSWORD,
//        LEAD_UPLOAD_KEY_ALIAS, LEAD_UPLOAD_KEY_PASSWORD
//      EAS builds are not affected (EAS signs with its own credentials).
const { withAndroidManifest, withAppBuildGradle } = require('expo/config-plugins');

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

// Release builds on the PC: use the upload key if its properties are set
function withLocalReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let gradle = c.modResults.contents;
    if (gradle.includes('LEAD_UPLOAD_STORE_FILE')) return c;

    gradle = gradle.replace(
      /signingConfigs \{\n/,
      `signingConfigs {
        if (project.hasProperty('LEAD_UPLOAD_STORE_FILE')) {
            upload {
                storeFile file(LEAD_UPLOAD_STORE_FILE)
                storePassword LEAD_UPLOAD_STORE_PASSWORD
                keyAlias LEAD_UPLOAD_KEY_ALIAS
                keyPassword LEAD_UPLOAD_KEY_PASSWORD
            }
        }
`,
    );
    gradle = gradle.replace(
      /(release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      `$1signingConfig project.hasProperty('LEAD_UPLOAD_STORE_FILE') ? signingConfigs.upload : signingConfigs.debug`,
    );
    c.modResults.contents = gradle;
    return c;
  });
}

module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

  return withLocalReleaseSigning(withWhatsAppQueries({
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  }));
};
