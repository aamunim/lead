// Adds what app.json can't hold: the Firebase file for Android push.
//   - EAS build: the file env var GOOGLE_SERVICES_JSON (eas env:create … --type file)
//   - your PC:   ./google-services.json (never committed, see .gitignore)
const fs = require('fs');

module.exports = ({ config }) => {
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON ??
    (fs.existsSync('./google-services.json') ? './google-services.json' : undefined);

  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
