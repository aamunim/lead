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
const fs = require('fs');
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

// 🔔 Is the Firebase file really there, and for this app?
//   Returns what is wrong, or null when it is fine.
function googleServicesProblem(file, pkg) {
  if (!file) return 'no file was given (GOOGLE_SERVICES_FILE / GOOGLE_SERVICES_JSON is empty)';
  if (!fs.existsSync(file)) return `the file "${file}" does not exist on the build machine`;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return `the file "${file}" is not valid JSON`;
  }
  const pkgs = (json.client ?? []).map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
  if (!pkgs.includes(pkg)) return `the file is for ${pkgs.join(', ') || 'no Android app'}, not ${pkg}`;
  return null;
}

module.exports = ({ config }) => {
  // GOOGLE_SERVICES_FILE: written by the GitHub "Build Android" workflow from its own
  //   secret (works whatever the EAS visibility is)
  // GOOGLE_SERVICES_JSON: the EAS file variable (must be "Sensitive" or "Plain text"
  //   for builds on GitHub: "Secret" ones never leave EAS's own servers)
  const googleServicesFile = process.env.GOOGLE_SERVICES_FILE || process.env.GOOGLE_SERVICES_JSON;

  // 🔔 An Android build without the Firebase file has no push at all
  //   ("Default FirebaseApp is not initialized" on the phone). Stop the build
  //   instead of making such an app. (Only on the build machine, EAS or --local.)
  const onBuilder = ['true', '1'].includes(String(process.env.EAS_BUILD ?? '').toLowerCase());
  if (onBuilder && process.env.EAS_BUILD_PLATFORM !== 'ios') {
    const problem = googleServicesProblem(googleServicesFile, config.android?.package);
    if (problem) {
      throw new Error(
        `Push notifications would not work in this build: ${problem}. ` +
          'Fix: expo.dev → this project → Environment variables → GOOGLE_SERVICES_JSON (type File, visibility ' +
          `"Sensitive", "${process.env.EAS_BUILD_PROFILE ?? 'build'}" environment ticked), or add the GitHub secret ` +
          'GOOGLE_SERVICES_JSON_BASE64. Then build again.',
      );
    }
    console.log(`✅ Firebase file found for ${config.android?.package}: push will work in this build`);
  }

  return withLocalReleaseSigning(withWhatsAppQueries({
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  }));
};
