// ═══════════════════════════════════════════
// SynaBun — Desktop (computer use) config: kv_config `desktop_config`
// ═══════════════════════════════════════════
//
// Knobs are data, not code constants: one JSON row re-read with a short TTL, so
// the Settings/API change of any guard, pause or screenshot size applies within
// seconds without a restart. The store (get/set of a kv row) is injected so
// tests never touch the live database.

import { BUNDLE_PREFIX_RE } from './protocol.js';

export const DESKTOP_CONFIG_KEY = 'desktop_config';

export const BROWSER_BUNDLES = Object.freeze([
  'com.google.Chrome', 'com.google.chrome.for.testing', 'org.chromium.Chromium', 'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'company.thebrowser.Browser', 'com.microsoft.edgemac', 'org.mozilla.firefox', 'com.brave.Browser', 'com.operasoftware.Opera', 'com.vivaldi.Vivaldi',
]);

/**
 * The web browsers computer use refuses to act on (guards.browserApps): the
 * browsers above, their beta / dev / canary channels, and MoreLogin's profile
 * windows (org.HongKongZiXun.MoreLogin, the Chromium build a MoreLogin profile
 * runs in, verified on a Mac). MoreLogin's manager app (com.zixun.MoreLoginPlus)
 * is not a browser. Web pages go through the SynaBun browser tools.
 */
export const BROWSER_GUARD_BUNDLES = Object.freeze([
  ...BROWSER_BUNDLES,
  'com.google.Chrome.beta', 'com.google.Chrome.dev', 'com.google.Chrome.canary', 'com.microsoft.edgemac.Beta', 'com.microsoft.edgemac.Dev',
  'com.microsoft.edgemac.Canary', 'org.mozilla.firefoxdeveloperedition', 'org.mozilla.nightly', 'com.brave.Browser.beta', 'com.brave.Browser.nightly',
  'com.operasoftware.OperaGX', 'org.HongKongZiXun.MoreLogin',
]);

/**
 * Bundle-id prefixes of installed web apps (each app gets its own bundle id).
 * com.apple.Safari.WebApp. is verified — Safari "Add to Dock" apps such as the
 * SynaBun web app (com.apple.Safari.WebApp.<UUID>, name "SynaBun"). The
 * Chromium-family prefixes follow Chromium's naming for installed web apps and
 * are NOT verified on a Mac.
 */
export const WEB_APP_BUNDLE_PREFIXES = Object.freeze([
  'com.apple.Safari.WebApp.', 'com.google.Chrome.app.', 'com.google.Chrome.canary.app.', 'org.chromium.Chromium.app.',
  'com.microsoft.edgemac.app.', 'com.brave.Browser.app.', 'com.vivaldi.Vivaldi.app.',
]);

/** System Settings (macOS 13+) and the old System Preferences share the protected-pane rules. */
export const SETTINGS_BUNDLES = Object.freeze(['com.apple.systempreferences', 'com.apple.Settings']);

export const SETTINGS_LANGS = Object.freeze(['en', 'pt', 'es', 'fr', 'de', 'it', 'tr', 'ja']);

// ── System Settings pane names ───────────────────────────────────────────────
// Window titles of the protected panes, per language. Read on macOS 26.6.2
// (Tahoe) from /System/Library/ExtensionKit/Extensions/*.appex/Contents/
// Resources/{InfoPlist,Localizable}.loctable (plutil -convert json); pt holds
// pt_BR + pt_PT, es holds es + es_419. `old` names are macOS 14/15 names from
// memory (unverified). `anchor` entries are short generic words matched as the
// whole title only. Section stems (Privacy, Segurança, …) also catch a
// drill-in page whose window keeps its section's title. Traps: pt_PT uses a
// non-breaking hyphen (U+2011), French a curly apostrophe (U+2019), and brand
// names carry a no-break space (U+00A0) in "Touch ID", "Apple Pay", "Apple
// Account" and "Compte Apple" — hence the builder's \s for every space.
// NOT protected, on purpose: Network, Wi-Fi, Bluetooth, Software Update and
// Appearance (Bluetooth's privacy page shares its title with the Bluetooth pane).
// Note the Accessibility privacy page shares its title with the Accessibility
// pane (VoiceOver, Zoom …), so that pane is protected too.
export const SETTINGS_PANE_NAMES = Object.freeze({
  'settings-security': [
    {
      pane: 'Privacy & Security',
      en: ['Privacy & Security', 'Privacy', 'Security'],
      pt: ['Privacidade e Segurança', 'Privacidade e segurança', 'Privacidade', 'Segurança'],
      es: ['Privacidad y seguridad', 'Privacidad', 'Seguridad'],
      fr: ['Confidentialité et sécurité', 'Confidentialité', 'Sécurité'],
      de: ['Datenschutz & Sicherheit', 'Datenschutz', 'Sicherheit'],
      it: ['Privacy e sicurezza', 'Sicurezza'],
      tr: ['Gizlilik ve Güvenlik', 'Gizlilik', 'Güvenlik'],
      ja: ['プライバシーとセキュリティ', 'プライバシー', 'セキュリティ'],
    },
    {
      pane: 'Touch ID & Password',
      en: ['Touch ID', 'Password'],
      pt: ['Touch ID e Senha', 'Senha', 'Touch ID e palavra‑passe', 'palavra‑passe'],
      es: ['Touch ID y contraseña', 'contraseña'],
      fr: ['Touch ID et mot de passe', 'mot de passe'],
      de: ['Touch ID & Passwort', 'Passwort'],
      it: ['Touch ID e password'],
      tr: ['Touch ID ve Parola'], // not the bare stem: Italian "Parola di oggi" would match it
      ja: ['Touch IDとパスワード', 'パスワード'],
      old: ['Passwords', 'Senhas', 'Palavras-passe', 'Contraseñas', 'Mots de passe', 'Passwörter', 'Parolalar'],
    },
    {
      pane: 'Lock Screen',
      en: ['Lock Screen'],
      pt: ['Tela Bloqueada', 'Ecrã bloqueado'],
      es: ['Pantalla de bloqueo', 'Pantalla bloqueada'],
      fr: ['Écran verrouillé'],
      de: ['Sperrbildschirm'],
      it: ['Schermata di blocco'],
      tr: ['Kilitli Ekran'],
      ja: ['ロック画面'],
    },
    {
      pane: 'Users & Groups',
      en: ['Users & Groups'],
      pt: ['Usuários e Grupos', 'Utilizadores e grupos'],
      es: ['Usuarios y grupos'],
      fr: ['Utilisateurs et groupes'],
      de: ['Benutzer:innen & Gruppen', 'Benutzer'],
      it: ['Utenti e gruppi'],
      tr: ['Kullanıcılar ve Gruplar'],
      ja: ['ユーザとグループ'],
    },
    {
      pane: 'Login Items',
      en: ['Login Items'],
      pt: ['Itens de Início', 'Início de sessão'],
      es: ['Ítems de inicio', 'Elementos de inicio'],
      fr: ['Ouverture'],
      de: ['Anmeldeobjekte'],
      it: ['Elementi login'],
      tr: ['Oturum Açma Öğeleri'],
      ja: ['ログイン項目'],
    },
    {
      pane: 'Wallet & Apple Pay',
      en: ['Wallet', 'Apple Pay'],
      pt: ['Carteira e Apple Pay', 'Carteira'],
      es: ['Cartera y Apple Pay', 'Cartera'],
      fr: ['Cartes et Apple Pay'],
      tr: ['Cüzdan ve Apple Pay', 'Cüzdan'],
      ja: ['ウォレットとApple Pay', 'ウォレット'],
    },
    {
      pane: 'Apple Account (and its older Apple ID name)',
      en: ['Apple Account', 'Apple ID'],
      pt: ['Conta Apple', 'ID Apple'],
      es: ['Cuenta de Apple', 'ID de Apple'],
      fr: ['Compte Apple', 'Identifiant Apple'],
      de: ['Apple-ID'],
      tr: ['Apple Hesabı', 'Apple Kimliği'],
    },
    {
      pane: 'Internet Accounts',
      en: ['Internet Accounts'],
      pt: ['Contas de Internet', 'Contas da internet'],
      es: ['Cuentas de internet'],
      fr: ['Comptes Internet'],
      de: ['Internetaccounts'],
      it: ['Account internet'],
      tr: ['İnternet Hesapları'],
      ja: ['インターネットアカウント'],
    },
    { pane: 'FileVault', en: ['FileVault'] },
    {
      pane: 'Lockdown Mode',
      en: ['Lockdown Mode'],
      pt: ['Modo de Isolamento', 'Modo de bloqueio'],
      es: ['Modo de aislamiento', 'Modo hermético'],
      fr: ['Mode Isolement'],
      de: ['Blockierungsmodus'],
      it: ['Modalità di isolamento'],
      tr: ['Kilit Modu'],
      ja: ['ロックダウンモード'],
    },
  ],
  'settings-privacy': [
    {
      pane: 'Full Disk Access',
      en: ['Full Disk Access'],
      pt: ['Acesso Total ao Disco', 'Acesso completo ao disco'],
      es: ['Acceso total al disco', 'Acceso completo al disco'],
      fr: ['Accès complet au disque'],
      de: ['Festplattenvollzugriff'],
      it: ['Accesso completo al disco'],
      tr: ['Tam Disk Erişimi'],
      ja: ['フルディスクアクセス'],
    },
    {
      pane: 'Accessibility',
      en: ['Accessibility'],
      pt: ['Acessibilidade'],
      es: ['Accesibilidad'],
      fr: ['Accessibilité'],
      de: ['Bedienungshilfen'],
      it: ['Accessibilità'],
      tr: ['Erişilebilirlik'],
      ja: ['アクセシビリティ'],
    },
    {
      pane: 'Screen & System Audio Recording',
      en: ['Screen & System Audio Recording', 'Screen Recording', 'System Audio Recording'],
      pt: [
        'Gravação do Áudio do Sistema e da Tela', 'Gravação de Tela', 'Gravação do Áudio do Sistema',
        'Gravação do ecrã e de áudio do sistema', 'Gravação do ecrã', 'Gravação de áudio do sistema',
      ],
      es: [
        'Grabación de pantalla y del audio del sistema', 'Grabación de audio del sistema y pantalla', 'Grabación de pantalla',
        'Grabación del audio del sistema', 'Grabación de audio del sistema',
      ],
      fr: ['Enregistrement de l’écran et des sons du système', 'Enregistrement de l’écran', 'Enregistrement des sons du système'],
      de: ['Aufnahme von Bildschirm & Systemaudio', 'Bildschirmaufnahme', 'Aufnahme von Systemaudio'],
      it: ['Registrazione schermo e audio di sistema', 'Registrazione schermo', 'Registrazione audio di sistema'],
      tr: ['Ekran ve Sistem Sesi Kaydı', 'Ekran Kaydı', 'Sistem Ses Kaydı'],
      ja: ['画面収録とシステムオーディオ録音', '画面収録', 'システムオーディオ録音'],
    },
    {
      pane: 'Input Monitoring',
      en: ['Input Monitoring'],
      pt: ['Monitoração de Entrada', 'Monitorização de entrada'],
      es: ['Monitorización'],
      fr: ['Surveillance de l’entrée'],
      de: ['Eingabeüberwachung'],
      it: ['Monitoraggio input'],
      tr: ['Giriş İzleme'],
      ja: ['入力監視'],
    },
    {
      pane: 'Automation',
      en: ['Automation'],
      pt: ['Automação', 'Automatização'],
      es: ['Automatización'],
      fr: ['Automatisation'],
      it: ['Automazione'],
      tr: ['Otomasyon'],
      ja: ['オートメーション'],
    },
    {
      pane: 'Developer Tools',
      en: ['Developer Tools'],
      pt: ['Ferramentas para Desenvolvedores', 'Ferramentas para programadores'],
      es: ['Herramientas para desarrolladores'],
      fr: ['Outils de développement'],
      de: ['Entwickler-Werkzeuge'],
      it: ['Strumenti per lo sviluppo'],
      tr: ['Geliştirici Araçları'],
      ja: ['デベロッパツール'],
    },
    {
      pane: 'App Management',
      en: ['App Management'],
      pt: ['Gerenciamento de Apps', 'Gestão de aplicações'],
      es: ['Gestión de las apps', 'Administración de apps'],
      fr: ['Gestion des apps'],
      de: ['App-Verwaltung'],
      it: ['Gestione app'],
      tr: ['Uygulama Yönetimi'],
      ja: ['アプリ管理'],
    },
    {
      pane: 'Files & Folders',
      en: ['Files & Folders'],
      pt: ['Arquivos e Pastas', 'Ficheiros e pastas'],
      es: ['Archivos y carpetas'],
      fr: ['Fichiers et dossiers'],
      de: ['Dateien & Ordner'],
      it: ['File e cartelle'],
      tr: ['Dosyalar ve Klasörler'],
      ja: ['ファイルとフォルダ'],
      old: ['Files and Folders'],
    },
    { pane: 'Remote Desktop', en: ['Remote Desktop'], es: ['Escritorio remoto'], it: ['Accesso remoto'] },
    {
      pane: 'Location Services',
      en: ['Location Services'],
      pt: ['Serviços de Localização'],
      fr: ['Service de localisation'],
      de: ['Ortungsdienste'],
      tr: ['Konum Servisleri'],
      ja: ['位置情報サービス'],
    },
    { pane: 'Location Services (es, it — a bare word)', anchor: true, es: ['Localización'], it: ['Localizzazione'] },
    {
      pane: 'Passkeys Access for Web Browsers',
      en: ['Passkey'],
      pt: ['Chaves‑senha', 'chaves‑passe'],
      es: ['llaves de acceso'],
      fr: ['clés d’accès'],
      tr: ['Geçiş Anahtar'],
      ja: ['パスキー'],
    },
    {
      pane: 'Camera', anchor: true,
      en: ['Camera'], pt: ['Câmera', 'Câmara'], es: ['Cámara'], fr: ['Caméra'], de: ['Kamera'], it: ['Fotocamera'], ja: ['カメラ'],
    },
    {
      pane: 'Microphone', anchor: true,
      en: ['Microphone'], pt: ['Microfone'], es: ['Micrófono'], fr: ['Micro'], de: ['Mikrofon'], it: ['Microfono'], ja: ['マイク'],
    },
    {
      pane: 'Contacts', anchor: true,
      en: ['Contacts'], pt: ['Contatos', 'Contactos'], de: ['Kontakte'], it: ['Contatti'], tr: ['Kişiler'], ja: ['連絡先'],
    },
    {
      pane: 'Calendars', anchor: true,
      en: ['Calendars'], pt: ['Calendários'], es: ['Calendarios'], fr: ['Calendriers'], de: ['Kalender'], it: ['Calendari'], tr: ['Takvimler'], ja: ['カレンダー'],
    },
    {
      pane: 'Reminders', anchor: true,
      en: ['Reminders'], pt: ['Lembretes'], es: ['Recordatorios'], fr: ['Rappels'], de: ['Erinnerungen'], it: ['Promemoria'], tr: ['Anımsatıcılar'], ja: ['リマインダー'],
    },
    {
      pane: 'Photos', anchor: true,
      en: ['Photos'], pt: ['Fotos', 'Fotografias'], it: ['Foto'], tr: ['Fotoğraflar'], ja: ['写真'],
    },
  ],
  'settings-system': [
    {
      pane: 'Sharing', anchor: true,
      en: ['Sharing'], pt: ['Compartilhamento', 'Partilha'], es: ['Compartir'], fr: ['Partage'], de: ['Teilen'], it: ['Condivisione'], tr: ['Paylaşma'], ja: ['共有'],
    },
    {
      pane: 'Device Management',
      en: ['Device Management'],
      pt: ['Gerenciamento de Dispositivo', 'Gestão de dispositivos'],
      es: ['Gestión de dispositivos', 'Administración de dispositivos'],
      fr: ['Gestion de l’appareil'],
      de: ['Geräteverwaltung'],
      it: ['Gestione dispositivo'],
      tr: ['Aygıt Yönetimi'],
      ja: ['デバイス管理'],
    },
    {
      pane: 'Profiles', anchor: true,
      en: ['Profiles'], pt: ['Perfis'], es: ['Perfiles'], fr: ['Profils'], de: ['Profile'], it: ['Profili'], tr: ['Profiller'], ja: ['プロファイル'],
    },
    {
      pane: 'Transfer or Reset',
      en: ['Transfer or Reset'],
      pt: ['Transferir ou Redefinir', 'Transferir ou repor'],
      es: ['Transferir o restablecer'],
      fr: ['Transférer ou réinitialiser'],
      de: ['Übertragen oder zurücksetzen'],
      it: ['Trasferisci o inizializza'],
      tr: ['Aktar veya Sıfırla'],
      ja: ['転送またはリセット'],
    },
    {
      pane: 'Startup Disk',
      en: ['Startup Disk'],
      pt: ['Disco de Inicialização', 'Disco de arranque'],
      fr: ['Disque de démarrage'],
      de: ['Startvolume'],
      it: ['Disco di Avvio'],
      tr: ['Başlangıç Diski'],
      ja: ['起動ディスク'],
    },
    {
      pane: 'Screen Time',
      en: ['Screen Time'],
      pt: ['Tempo de Uso', 'Tempo de ecrã'],
      es: ['Tiempo de uso', 'Tiempo en pantalla'],
      fr: ['Temps d’écran'],
      de: ['Bildschirmzeit'],
      it: ['Tempo di utilizzo'],
      tr: ['Ekran Süresi'],
      ja: ['スクリーンタイム'],
    },
    {
      pane: 'System Extensions',
      en: ['System Extensions'],
      pt: ['Extensões do Sistema', 'Extensões de sistema'],
      es: ['Extensiones del sistema'],
      fr: ['Extensions système'],
      de: ['Systemerweiterungen'],
      it: ['Estensioni di sistema'],
      tr: ['Sistem Genişletmeleri'],
      ja: ['システム機能拡張'],
    },
  ],
});

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
// Apostrophes and hyphens vary between releases and locales (’ ' ‑ -): any character.
const LOOSE_PUNCTUATION = /[’'‑-]/g;
// A space may be a no-break space (U+00A0) in the title: \s matches both in JS and ICU.
const ANY_SPACE = /\s+/g;

/** Every name of one table entry (all languages, then `old`). */
export function paneNames(entry = {}) {
  return [...SETTINGS_LANGS.flatMap((lang) => entry[lang] || []), ...(entry.old || [])];
}

/**
 * One case-insensitive window-title pattern (JS and ICU) from name-table
 * entries: each name NFC-normalized, regex-escaped, with ’ ' ‑ - turned into
 * "." and spaces into \s; `anchor` entries grouped as ^(?:…)$, the rest matched
 * anywhere in the title; duplicates (case-insensitive) dropped.
 */
export function titleRegexFrom(entries = []) {
  const anchored = [];
  const loose = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const raw of paneNames(entry)) {
      const name = String(raw).normalize('NFC').trim();
      const key = `${entry.anchor ? '^' : '~'}${name.toLowerCase()}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      const pattern = name.replace(REGEX_META, '\\$&').replace(LOOSE_PUNCTUATION, '.').replace(ANY_SPACE, '\\s');
      (entry.anchor ? anchored : loose).push(pattern);
    }
  }
  return [...(anchored.length ? [`^(?:${anchored.join('|')})$`] : []), ...loose].join('|');
}

/** The built titleRe of each System Settings rule, by rule id. */
export const SETTINGS_TITLE_RES = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS_PANE_NAMES).map(([id, entries]) => [id, titleRegexFrom(entries)]),
));

const SETTINGS_REASONS = Object.freeze({
  'settings-security': 'System Settings security panes',
  'settings-privacy': 'System Settings privacy pages (what apps may access)',
  'settings-system': 'System Settings sharing, device management, reset and startup panes',
});

function settingsRule(id) {
  return { id, bundleIds: [...SETTINGS_BUNDLES], titleRe: SETTINGS_TITLE_RES[id], reason: SETTINGS_REASONS[id] };
}

export const DESKTOP_DEFAULTS = Object.freeze({
  enabled: false,
  setupCompletedAt: null,
  defaultSessionOn: false,
  screenshot: { fit: { default: { w: 1280, h: 800 }, codex: { w: 1366, h: 768 } }, quality: 0.72, zoomFit: { w: 1280, h: 800 } },
  settleMs: { default: 350, click: 450, key: 250, type: 150, scroll: 300, open: 1200, drag: 400 },
  screenshotTtlMs: 120_000,
  lease: { idleTtlMs: 120_000 },
  userPauseMs: 2500,
  stop: { esc: true, failsafeCorner: true, cornerSizePt: 4, interruptTurn: true, stopKillsWorker: true },
  guards: {
    secureField: true,
    refuseWhenLocked: true,
    moneyWarnings: true,
    blockedApps: [
      { id: 'keychain', bundleIds: ['com.apple.keychainaccess'], reason: 'Keychain Access holds passwords and keys' },
      { id: 'passwords', bundleIds: ['com.apple.Passwords'], reason: 'The Passwords app' },
      {
        id: 'password-managers',
        bundleIds: ['com.1password.1password', 'com.agilebits.onepassword7', 'com.bitwarden.desktop', 'com.lastpass.LastPass', 'org.keepassxc.keepassxc', 'in.sinew.Enpass-Desktop', 'com.keepersecurity.passwordmanager', 'me.proton.pass.electron', 'com.dashlane.dashlanephonefinal'],
        nameRe: '1Password|Bitwarden|LastPass|KeePassXC|Enpass|Keeper|Proton Pass|Dashlane',
        reason: 'A password manager',
      },
      { id: 'auth-dialogs', bundleIds: ['com.apple.SecurityAgent', 'com.apple.LocalAuthentication.UIAgent', 'com.apple.coreautha'], nameRe: 'SecurityAgent|coreautha', reason: 'A system authentication dialog' },
      {
        id: 'terminals',
        bundleIds: ['com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty', 'com.github.wez.wezterm', 'org.alacritty', 'co.zeit.hyper'],
        reason: 'Terminal emulators are off-limits (your other agents run there); use your own shell tool instead',
      },
    ],
    // Arrays replace wholesale (mergeConfig): a user's own protectedWindows (or
    // blockedApps) list drops every default rule below, including the localized
    // System Settings rules and the SynaBun web-app rule.
    protectedWindows: [
      settingsRule('settings-security'),
      settingsRule('settings-privacy'),
      settingsRule('settings-system'),
      {
        id: 'synabun-ui',
        bundleIds: [...BROWSER_BUNDLES],
        bundlePrefixes: [...WEB_APP_BUNDLE_PREFIXES],
        titleRe: 'Neural Memory Interface|SynaBun|SynApp|Neural Interface',
        // A web app's name protects every window it has, whatever the page title
        // ("Restarting...", "SynaBun Stopped" …); opening it is refused too.
        appNameRe: '^(SynaBun|SynApp|Neural (Memory )?Interface)\\b',
        reason: "SynaBun's own interface",
      },
    ],
    // Web browsers and installed web apps: every action whose target is one is
    // refused (guards.js browserGuardRule → a blocked-app rule of the helper).
    browserApps: [...BROWSER_GUARD_BUNDLES],
    browserAppPrefixes: [...WEB_APP_BUNDLE_PREFIXES],
  },
  limits: { maxActionsPerMinute: 120, typeMaxChars: 5000, waitMaxSec: 10, axMaxNodes: 400, axMaxDepth: 12, axIntentMaxNodes: 600, axIntentTexts: 80 },
  audit: { retentionDays: 14 },
  frames: { memoryCount: 60 },
});

function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Deep merge where arrays replace wholesale (a user blocklist replaces the default list). */
export function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base?.[key])) out[key] = mergeConfig(base[key], value);
    else out[key] = value;
  }
  return out;
}

function configError(field, message) {
  const error = new Error(message);
  error.code = 'CONFIG_INVALID';
  error.field = field;
  error.status = 400;
  return error;
}

// A bundle id: dotted reverse-DNS, at least two segments, no trailing dot.
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** A list of bundle-id prefixes: dotted reverse-DNS ending in "." (protocol.js BUNDLE_PREFIX_RE). */
function validatePrefixList(list, field) {
  if (!Array.isArray(list)) throw configError(field, `${field} must be an array`);
  list.forEach((prefix, index) => {
    if (typeof prefix !== 'string' || !BUNDLE_PREFIX_RE.test(prefix)) {
      throw configError(`${field}[${index}]`, `${field}[${index}] must be a dotted bundle id prefix ending in "." (e.g. "com.apple.Safari.WebApp.")`);
    }
  });
}

const INTENT_LIMITS = Object.freeze({ axIntentMaxNodes: [10, 2000, 600], axIntentTexts: [0, 200, 80] });

/** Validate a user patch (only the user-facing knobs; setup fields are service-owned). */
export function validateConfigPatch(patch = {}) {
  if (!isPlainObject(patch)) throw configError('config', 'config must be an object');
  const allowed = new Set(['screenshot', 'settleMs', 'screenshotTtlMs', 'lease', 'userPauseMs', 'stop', 'guards', 'limits', 'audit', 'frames', 'defaultSessionOn']);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw configError(key, `Unknown or read-only desktop setting "${key}"`);
  const guards = patch.guards;
  if (guards !== undefined) {
    if (!isPlainObject(guards)) throw configError('guards', 'guards must be an object');
    for (const listKey of ['blockedApps', 'protectedWindows']) {
      const list = guards[listKey];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw configError(`guards.${listKey}`, `${listKey} must be an array`);
      list.forEach((rule, index) => {
        if (!isPlainObject(rule) || !rule.id) throw configError(`guards.${listKey}[${index}]`, 'Each rule needs an id');
        for (const re of ['nameRe', 'titleRe', 'windowTitleRe', 'appNameRe']) {
          if (rule[re] === undefined) continue;
          if (typeof rule[re] !== 'string') throw configError(`guards.${listKey}[${index}].${re}`, `${re} must be a string`);
          try { new RegExp(rule[re].normalize('NFC'), 'i'); } catch { throw configError(`guards.${listKey}[${index}].${re}`, `${re} is not a valid regular expression`); }
        }
        if (rule.bundlePrefixes !== undefined) validatePrefixList(rule.bundlePrefixes, `guards.${listKey}[${index}].bundlePrefixes`);
      });
    }
    if (guards.browserApps !== undefined) {
      if (!Array.isArray(guards.browserApps)) throw configError('guards.browserApps', 'guards.browserApps must be an array');
      guards.browserApps.forEach((id, index) => {
        if (typeof id !== 'string' || !BUNDLE_ID_RE.test(id)) throw configError(`guards.browserApps[${index}]`, `guards.browserApps[${index}] must be a bundle id (e.g. "com.google.Chrome")`);
      });
    }
    if (guards.browserAppPrefixes !== undefined) validatePrefixList(guards.browserAppPrefixes, 'guards.browserAppPrefixes');
  }
  if (patch.limits !== undefined) {
    if (!isPlainObject(patch.limits)) throw configError('limits', 'limits must be an object');
    for (const [field, [min, max]] of Object.entries(INTENT_LIMITS)) {
      const value = patch.limits[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw configError(`limits.${field}`, `limits.${field} must be a number between ${min} and ${max}`);
    }
  }
  for (const [field, min, max] of [['userPauseMs', 0, 60_000], ['screenshotTtlMs', 5_000, 3_600_000]]) {
    if (patch[field] !== undefined) {
      const n = Number(patch[field]);
      if (!Number.isFinite(n) || n < min || n > max) throw configError(field, `${field} must be between ${min} and ${max}`);
    }
  }
  return patch;
}

/**
 * Bounds for an intent snapshot, clamped whatever is stored:
 * maxNodes = limits.axIntentMaxNodes (10–2000, default 600),
 * maxTexts = limits.axIntentTexts (0–200, default 80).
 */
export function desktopIntentLimits(config = {}) {
  const pick = (field) => {
    const [min, max, fallback] = INTENT_LIMITS[field];
    const value = config?.limits?.[field];
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.round(Math.min(max, Math.max(min, n)));
  };
  return { maxNodes: pick('axIntentMaxNodes'), maxTexts: pick('axIntentTexts') };
}

/**
 * @param {object} deps
 * @param {(key:string)=>string|null} deps.get   getKvConfig
 * @param {(key:string, value:string)=>void} deps.set  setKvConfig
 */
export function createDesktopConfigStore({ get, set, ttlMs = 3000, now = Date.now, log = () => {} } = {}) {
  let cache = null; // { at, value }
  function readStored() {
    if (typeof get !== 'function') return {};
    try { const raw = get(DESKTOP_CONFIG_KEY); return raw ? JSON.parse(raw) : {}; }
    catch (error) { log('desktop:config-unreadable', error?.message || String(error)); return {}; }
  }
  function read() {
    if (cache && now() - cache.at < ttlMs) return cache.value;
    const value = mergeConfig(DESKTOP_DEFAULTS, readStored());
    cache = { at: now(), value };
    return value;
  }
  /** Service-owned write (setup fields included). */
  function write(patch = {}) {
    const next = mergeConfig(readStored(), patch);
    if (typeof set === 'function') set(DESKTOP_CONFIG_KEY, JSON.stringify(next));
    cache = null;
    return read();
  }
  /** User-facing write (validated). */
  function update(patch = {}) { return write(validateConfigPatch(patch)); }
  function invalidate() { cache = null; }
  return { read, write, update, invalidate };
}
