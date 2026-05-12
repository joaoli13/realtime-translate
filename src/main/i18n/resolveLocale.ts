import * as electron from 'electron';
import type { UserPrefsStore } from '../config/userPrefsStore';
import { resolveLocaleFromCandidates, type Locale } from '../../shared/i18n';

const { app } = electron;

/** Resolves the UI locale from user override, then OS locale, then en-US fallback. */
export function resolveLocale(prefsStore: UserPrefsStore): Locale {
  const candidates: string[] = [];
  const override = prefsStore.load().uiLanguage;
  if (override) candidates.push(override);
  candidates.push(app.getLocale());
  return resolveLocaleFromCandidates(candidates);
}
