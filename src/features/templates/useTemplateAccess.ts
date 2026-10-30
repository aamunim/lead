import { useEffect, useState } from 'react';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_TEMPLATE_SETTINGS,
  canUseTemplates,
  getTemplateSettings,
  type TemplateSettings,
} from '@/features/templates/api';

// One copy for the whole app; read again at most every 2 minutes
let cache: { at: number; settings: TemplateSettings } | null = null;
const FRESH_MS = 2 * 60 * 1000;

/** The template settings, and whether this person may use templates */
export function useTemplateAccess(): { settings: TemplateSettings; allowed: boolean } {
  const { profile } = useAuth();
  const [settings, setSettings] = useState<TemplateSettings>(cache?.settings ?? DEFAULT_TEMPLATE_SETTINGS);

  useEffect(() => {
    if (cache && Date.now() - cache.at < FRESH_MS) {
      setSettings(cache.settings);
      return;
    }
    getTemplateSettings()
      .then((s) => {
        cache = { at: Date.now(), settings: s };
        setSettings(s);
      })
      .catch(() => undefined);
  }, []);

  return { settings, allowed: canUseTemplates(settings, profile) };
}

/** After saving the settings: read them again next time */
export function forgetTemplateSettings() {
  cache = null;
}
