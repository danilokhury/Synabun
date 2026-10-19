// Hands the page's translator to account-view.js (`accounts.*` in i18n/*.json).
// Browser-only: i18n.js reads the page's storage, so node tests load
// account-view.js without it and get the English.
import { t } from './i18n.js';
import { setAccountTranslator } from './account-view.js';

setAccountTranslator((key, params) => t(`accounts.${key}`, params));
