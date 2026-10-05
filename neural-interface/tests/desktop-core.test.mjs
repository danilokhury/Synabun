import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fitSize, imageToPoint, pointToImage, regionToRect, nudgeFromCorner, scrollDelta } from '../lib/desktop/coords.js';
import { parseCombo, looksLikeCardNumber, guardSpec, blockedAppRule, actionWarnings, clickModifiers, BROWSER_RULE_ID, browserGuardRule, isBrowserBundle } from '../lib/desktop/guards.js';
import { createLease } from '../lib/desktop/lease.js';
import { createFrameStore } from '../lib/desktop/frames.js';
import { createGrantRegistry, isGrantToken } from '../lib/desktop/grants.js';
import { createAuditLog } from '../lib/desktop/audit.js';
import {
  createDesktopConfigStore, DESKTOP_DEFAULTS, mergeConfig, desktopIntentLimits, SETTINGS_TITLE_RES, titleRegexFrom, WEB_APP_BUNDLE_PREFIXES,
  BROWSER_BUNDLES, BROWSER_GUARD_BUNDLES, validateConfigPatch,
} from '../lib/desktop/config.js';
import { BUNDLE_PREFIX_RE, matchGuard, validateGuardSpec } from '../lib/desktop/protocol.js';
import { AX_INVOCABLE_ACTIONS, axLabel, axLine } from '../lib/desktop/service.js';

// System Settings window titles read on macOS 26.6.2 (Tahoe) from the panes'
// loctables (en, pt_BR, pt_PT, es, es_419, fr, de, it, tr, ja) — exact code
// points, including Apple's no-break spaces (U+00A0), non-breaking hyphens
// (U+2011) and curly apostrophes (U+2019).
const PROTECTED_PANES_26 = [
  'Accessibility', 'Acessibilidade', 'Accesibilidad', 'Accessibilité', 'Bedienungshilfen', 'Accessibilità',
  'Erişilebilirlik', 'アクセシビリティ', 'Conta Apple', 'Cuenta de Apple', 'Compte Apple', 'Apple Account',
  'Apple Hesabı', 'Internet Accounts', 'Contas de Internet', 'Contas da internet', 'Cuentas de internet',
  'Cuentas de Internet', 'Comptes Internet', 'Internetaccounts', 'Account internet', 'İnternet Hesapları',
  'インターネットアカウント', 'Lock Screen', 'Tela Bloqueada', 'Ecrã bloqueado', 'Pantalla de bloqueo', 'Pantalla bloqueada',
  'Écran verrouillé', 'Sperrbildschirm', 'Schermata di blocco', 'Kilitli Ekran', 'ロック画面', 'Login Items',
  'Itens de Início', 'Início de sessão', 'Ítems de inicio', 'Elementos de inicio', 'Ouverture', 'Anmeldeobjekte',
  'Elementi login', 'Oturum Açma Öğeleri', 'ログイン項目', 'Device Management', 'Gerenciamento de Dispositivo',
  'Gestão de dispositivos', 'Gestión de dispositivos', 'Administración de dispositivos',
  'Gestion de l’appareil', 'Geräteverwaltung', 'Gestione dispositivo', 'Aygıt Yönetimi', 'デバイス管理',
  'Screen Time', 'Tempo de Uso', 'Tempo de ecrã', 'Tiempo de uso', 'Tiempo en pantalla', 'Temps d’écran',
  'Bildschirmzeit', 'Tempo di utilizzo', 'Ekran Süresi', 'スクリーンタイム', 'Privacy & Security', 'Privacidade e Segurança',
  'Privacidade e segurança', 'Privacidad y seguridad', 'Confidentialité et sécurité', 'Datenschutz & Sicherheit',
  'Privacy e sicurezza', 'Gizlilik ve Güvenlik', 'プライバシーとセキュリティ', 'System Extensions', 'Extensões do Sistema',
  'Extensões de sistema', 'Extensiones del sistema', 'Extensions système', 'Systemerweiterungen',
  'Estensioni di sistema', 'Sistem Genişletmeleri', 'システム機能拡張', 'Sharing', 'Compartilhamento', 'Partilha',
  'Compartir', 'Partage', 'Teilen', 'Condivisione', 'Paylaşma', '共有', 'Startup Disk', 'Disco de Inicialização',
  'Disco de arranque', 'Disque de démarrage', 'Startvolume', 'Disco di Avvio', 'Başlangıç Diski', '起動ディスク',
  'Touch ID e Senha', 'Touch ID e palavra‑passe', 'Touch ID y contraseña',
  'Touch ID y contraseña', 'Touch ID et mot de passe', 'Touch ID & Passwort', 'Touch ID e password',
  'Touch ID ve Parola', 'Touch IDとパスワード', 'Transfer or Reset', 'Transferir ou Redefinir', 'Transferir ou repor',
  'Transferir o restablecer', 'Transférer ou réinitialiser', 'Übertragen oder zurücksetzen',
  'Trasferisci o inizializza', 'Aktar veya Sıfırla', '転送またはリセット', 'Users & Groups', 'Usuários e Grupos',
  'Utilizadores e grupos', 'Usuarios y grupos', 'Utilisateurs et groupes', 'Benutzer:innen & Gruppen',
  'Utenti e gruppi', 'Kullanıcılar ve Gruplar', 'ユーザとグループ', 'Wallet & Apple Pay', 'Carteira e Apple Pay',
  'Cartera y Apple Pay', 'Wallet y Apple Pay', 'Cartes et Apple Pay', 'Wallet e Apple Pay',
  'Cüzdan ve Apple Pay', 'ウォレットとApple Pay', 'Input Monitoring', 'Monitoração de Entrada',
  'Monitorização de entrada', 'Monitorización de los dispositivos de entrada', 'Monitorización de entrada',
  'Surveillance de l’entrée', 'Eingabeüberwachung', 'Monitoraggio input', 'Giriş İzleme', '入力監視',
  'App Management', 'Gerenciamento de Apps', 'Gestão de aplicações', 'Gestión de las apps', 'Administración de apps',
  'Gestion des apps', 'App-Verwaltung', 'Gestione app', 'Uygulama Yönetimi', 'アプリ管理', 'Lockdown Mode',
  'Modo de Isolamento', 'Modo de bloqueio', 'Modo de aislamiento', 'Modo hermético', 'Mode Isolement',
  'Blockierungsmodus', 'Modalità di isolamento', 'Kilit Modu', 'ロックダウンモード', 'Passkeys Access for Web Browsers',
  'Acesso às Chaves‑senha para Navegadores', 'Acesso a chaves‑passe pelos navegadores',
  'Acceso de los navegadores web a las llaves de acceso', 'Acceso de navegadores a llaves de acceso',
  'Accès aux clés d’accès pour les navigateurs', 'Zugriff auf Passkeys für Webbrowser',
  'Accesso alle passkey per i browser web', 'Web Tarayıcıları İçin Geçiş Anahtarları Erişimi', 'Webブラウザのパスキーへのアクセス',
  'Screen & System Audio Recording', 'Gravação do Áudio do Sistema e da Tela',
  'Gravação do ecrã e de áudio do sistema', 'Grabación de pantalla y del audio del sistema',
  'Grabación de audio del sistema y pantalla', 'Enregistrement de l’écran et des sons du système',
  'Aufnahme von Bildschirm & Systemaudio', 'Registrazione schermo e audio di sistema', 'Ekran ve Sistem Sesi Kaydı',
  '画面収録とシステムオーディオ録音', 'Full Disk Access', 'Acesso Total ao Disco', 'Acesso completo ao disco',
  'Acceso total al disco', 'Acceso completo al disco', 'Accès complet au disque', 'Festplattenvollzugriff',
  'Accesso completo al disco', 'Tam Disk Erişimi', 'フルディスクアクセス', 'Reminders', 'Lembretes', 'Recordatorios',
  'Rappels', 'Erinnerungen', 'Promemoria', 'Anımsatıcılar', 'リマインダー', 'FileVault', 'Files & Folders',
  'Arquivos e Pastas', 'Ficheiros e pastas', 'Archivos y carpetas', 'Fichiers et dossiers', 'Dateien & Ordner',
  'File e cartelle', 'Dosyalar ve Klasörler', 'ファイルとフォルダ', 'System Audio Recording', 'Gravação do Áudio do Sistema',
  'Gravação de áudio do sistema', 'Grabación del audio del sistema', 'Grabación de audio del sistema',
  'Enregistrement des sons du système', 'Aufnahme von Systemaudio', 'Registrazione audio di sistema',
  'Sistem Ses Kaydı', 'システムオーディオ録音', 'Microphone', 'Microfone', 'Micrófono', 'Micro', 'Mikrofon', 'Microfono', 'マイク',
  'Remote Desktop', 'Escritorio remoto', 'Accesso remoto', 'Location Services', 'Serviços de Localização',
  'Serviços de localização', 'Localización', 'Service de localisation', 'Ortungsdienste', 'Localizzazione',
  'Konum Servisleri', '位置情報サービス', 'Automation', 'Automação', 'Automatização', 'Automatización', 'Automatisation',
  'Automazione', 'Otomasyon', 'オートメーション', 'Contacts', 'Contatos', 'Contactos', 'Kontakte', 'Contatti', 'Kişiler',
  '連絡先', 'Screen Recording', 'Gravação de Tela', 'Gravação do ecrã', 'Grabación de pantalla',
  'Enregistrement de l’écran', 'Bildschirmaufnahme', 'Registrazione schermo', 'Ekran Kaydı', '画面収録',
  'Calendars', 'Calendários', 'Calendarios', 'Calendriers', 'Kalender', 'Calendari', 'Takvimler', 'カレンダー', 'Privacy',
  'Privacidade', 'Privacidad', 'Confidentialité', 'Datenschutz', 'Gizlilik', 'プライバシー', 'Security', 'Segurança',
  'Seguridad', 'Sécurité', 'Sicherheit', 'Sicurezza', 'Güvenlik', 'セキュリティ', 'Developer Tools',
  'Ferramentas para Desenvolvedores', 'Ferramentas para programadores', 'Herramientas para desarrolladores',
  'Outils de développement', 'Entwickler-Werkzeuge', 'Strumenti per lo sviluppo', 'Geliştirici Araçları', 'デベロッパツール',
  'Camera', 'Câmera', 'Câmara', 'Cámara', 'Caméra', 'Kamera', 'Fotocamera', 'カメラ',
  'Photos', 'Fotos', 'Fotografias', 'Foto', 'Fotoğraflar', '写真',
  'Apple ID', 'ID Apple', 'ID de Apple', 'Identifiant Apple', 'Apple-ID', 'ID Apple', 'Apple Kimliği', 'Apple ID',
];
// Everyday panes that must stay usable (same source).
const OPEN_PANES_26 = [
  'Appearance', 'Aparência', 'Apresentação', 'Aspecto', 'Apparence', 'Erscheinungsbild', 'Aspetto', 'Görünüş', '外観',
  'Bluetooth', 'Displays', 'Telas', 'Monitores', 'Pantallas', 'Moniteurs', 'Schermi', 'Ekranlar', 'ディスプレイ',
  'Keyboard', 'Teclado', 'Clavier', 'Tastatur', 'Tastiera', 'Klavye', 'キーボード', 'Network', 'Rede', 'Red', 'Réseau',
  'Netzwerk', 'Rete', 'Ağ', 'ネットワーク', 'Software Update', 'Atualização de Software', 'Atualização de software',
  'Actualización de software', 'Mise à jour de logiciels', 'Softwareupdate', 'Aggiornamento software',
  'Yazılım Güncelleme', 'ソフトウェアアップデート', 'Sound', 'Som', 'Sonido', 'Son', 'Ton', 'Suono', 'Ses', 'サウンド',
  'Time Machine', 'Time Machine', 'Wi‑Fi', 'WLAN',
];
const SYNABUN_WEB_APP = 'com.apple.Safari.WebApp.7EF0F3F3-27FA-4C9A-9D7C-74020761B996';

test('coords: fit box, Retina and scaled modes, negative-origin displays, bounds, zoom regions', () => {
  // 2560x1664 panel at 2x → 1280x832 points; fits 1280x800 at f≈0.9615.
  const fit = fitSize({ w: 1280, h: 832 }, { w: 1280, h: 800 }, 2);
  assert.deepEqual([fit.w, fit.h], [1231, 800]);
  // A scaled mode 1470x956 pt: the mapping uses the capture bounds, never ×2.
  const frame = { bounds: { x: 0, y: 0, w: 1470, h: 956 }, image: { w: 1230, h: 800 } };
  const p = imageToPoint(frame, 615, 400);
  assert.ok(Math.abs(p.x - 735.6) < 1 && Math.abs(p.y - 478.6) < 1, JSON.stringify(p));
  assert.equal(imageToPoint(frame, 1230, 10), null, 'x == width is out of bounds');
  assert.equal(imageToPoint(frame, -1, 10), null);
  const left = { bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, image: { w: 1280, h: 720 } };
  const q = imageToPoint(left, 0, 0);
  assert.ok(q.x < -1918 && q.x > -1920, 'secondary display at a negative origin');
  assert.deepEqual(pointToImage(frame, 735.6, 478.6).inside, true);
  const rect = regionToRect(frame, [100, 100, 0, 0]);
  assert.ok(rect.w > 0 && rect.h > 0, 'regions normalize their corners');
  assert.deepEqual(nudgeFromCorner({ x: 1, y: 2 }, { cornerSizePt: 4 }), { x: 5, y: 5 }, 'agents never land in the failsafe corner');
  assert.deepEqual(nudgeFromCorner({ x: 1, y: 200 }, { cornerSizePt: 4 }), { x: 1, y: 200 });
  assert.deepEqual(scrollDelta('up', 5), { dx: 0, dy: -5 });
  assert.deepEqual(scrollDelta('right'), { dx: 3, dy: 0 });
});

test('guards: combos, click modifiers, card numbers, GuardSpec, app rules, warnings', () => {
  assert.deepEqual(parseCombo('cmd+shift+t'), { modifiers: ['cmd', 'shift'], key: 't', printable: false, paste: false });
  assert.equal(parseCombo('a').printable, true);
  assert.equal(parseCombo('cmd+v').paste, true);
  assert.equal(parseCombo('cmd+v').printable, true, 'paste counts as typing (password-field guard)');
  assert.deepEqual(clickModifiers('shift+cmd'), ['shift', 'cmd']);
  assert.equal(looksLikeCardNumber('pay with 4242 4242 4242 4242 today'), true);
  assert.equal(looksLikeCardNumber('order 1234 5678 9012 3456'), false, 'Luhn-invalid numbers pass');
  const spec = guardSpec(DESKTOP_DEFAULTS);
  assert.ok(spec.blockedApps.some((rule) => rule.id === 'keychain'));
  assert.ok(spec.blockedApps.some((rule) => rule.id === 'terminals' && rule.bundleIds.includes('com.apple.Terminal')));
  assert.ok(spec.protectedWindows.some((rule) => rule.id === 'synabun-ui'));
  assert.equal(spec.secureField, true);
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { bundleId: 'com.apple.keychainaccess' }).id, 'keychain');
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { name: '1Password 8' }).id, 'password-managers');
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { name: 'TextEdit' }), null);
  const lexicon = { lexiconClass: (label) => (/buy now/i.test(label) ? 'payment' : /publish/i.test(label) ? 'publish' : null) };
  const kinds = (w) => w.map((x) => x.kind);
  assert.deepEqual(kinds(actionWarnings({ action: 'left_click', probe: { title: 'Buy now', bundleId: 'com.apple.TextEdit' }, config: DESKTOP_DEFAULTS, lexicon })), ['payment']);
  assert.deepEqual(kinds(actionWarnings({ action: 'type', text: '4242424242424242', config: DESKTOP_DEFAULTS, lexicon })), ['card-number']);
  assert.deepEqual(kinds(actionWarnings({ action: 'left_click', probe: { title: 'Search', bundleId: 'com.google.Chrome' }, config: DESKTOP_DEFAULTS, lexicon })), [], 'a browser is refused, not warned about');
  assert.deepEqual(actionWarnings({ action: 'left_click', probe: { title: 'Buy now' }, config: { guards: { moneyWarnings: false } }, lexicon }), []);
});

test('web browsers: one blocked-app rule for the helper from browserApps / browserAppPrefixes, MoreLogin profile windows included, its manager app not', () => {
  const spec = guardSpec(DESKTOP_DEFAULTS);
  validateGuardSpec(spec); // the helper accepts it
  const rule = spec.blockedApps.at(-1);
  assert.equal(rule.id, BROWSER_RULE_ID);
  assert.equal(rule.id, 'web-browsers');
  assert.match(rule.reason, /^a web browser: use the SynaBun browser tools \(browser_navigate, browser_snapshot, browser_screenshot …\) for web pages$/);
  assert.deepEqual(rule.bundlePrefixes, [...WEB_APP_BUNDLE_PREFIXES]);
  for (const id of [...BROWSER_BUNDLES, 'com.google.Chrome.canary', 'com.microsoft.edgemac.Beta', 'org.mozilla.firefoxdeveloperedition', 'com.operasoftware.OperaGX']) {
    assert.ok(rule.bundleIds.includes(id), id);
  }
  assert.deepEqual(DESKTOP_DEFAULTS.guards.browserApps, [...BROWSER_GUARD_BUNDLES]);
  const refusedAs = (bundleId, app) => {
    const hit = matchGuard({ bundleId, app, windowTitle: 'Example' }, spec);
    return hit ? `${hit.code}:${hit.details.rule.id}` : null;
  };
  for (const [bundleId, app] of [
    ['com.google.Chrome', 'Google Chrome'], ['com.google.chrome.for.testing', 'Google Chrome for Testing'], ['org.chromium.Chromium', 'Chromium'],
    ['com.apple.Safari', 'Safari'], ['org.mozilla.firefox', 'Firefox'], ['com.microsoft.edgemac', 'Microsoft Edge'], ['com.brave.Browser', 'Brave Browser'],
    ['company.thebrowser.Browser', 'Arc'], ['com.operasoftware.Opera', 'Opera'], ['com.vivaldi.Vivaldi', 'Vivaldi'],
    ['org.HongKongZiXun.MoreLogin', 'MoreLogin'], ['ORG.HONGKONGZIXUN.MORELOGIN', 'MoreLogin'], ['com.google.Chrome.app.abcdef', 'Docs'], [SYNABUN_WEB_APP, 'SynaBun'],
  ]) assert.equal(refusedAs(bundleId, app), 'BLOCKED_APP:web-browsers', bundleId);
  for (const [bundleId, app] of [['com.zixun.MoreLoginPlus', 'MoreLogin'], ['com.apple.TextEdit', 'Chrome notes'], ['com.apple.Safari.WebAppX', 'x']]) {
    assert.equal(refusedAs(bundleId, app), null, bundleId);
  }
  // open / focus mirror: by bundle id only (MoreLogin's windows and manager share the name).
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { bundleId: 'com.google.Chrome' })?.id, 'web-browsers');
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { bundleId: 'org.HongKongZiXun.MoreLogin', name: 'org.HongKongZiXun.MoreLogin' })?.id, 'web-browsers');
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { bundleId: 'com.zixun.MoreLoginPlus', name: 'com.zixun.MoreLoginPlus' }), null);
  assert.equal(blockedAppRule(DESKTOP_DEFAULTS, { name: 'MoreLogin' }), null, 'the name resolves in the helper');
  assert.equal(isBrowserBundle(DESKTOP_DEFAULTS, 'com.apple.Safari.WebApp.1'), true);
  assert.equal(isBrowserBundle(DESKTOP_DEFAULTS, 'com.zixun.MoreLoginPlus'), false);
  // The knobs: empty lists turn the rule off; a saved list replaces the defaults; bad ids are refused.
  const off = { guards: { ...DESKTOP_DEFAULTS.guards, browserApps: [], browserAppPrefixes: [] } };
  assert.equal(browserGuardRule(off), null);
  assert.equal(guardSpec(off).blockedApps.some((r) => r.id === 'web-browsers'), false);
  assert.deepEqual(browserGuardRule({ guards: { browserApps: ['com.example.Browser'] } }), { id: 'web-browsers', bundleIds: ['com.example.Browser'], bundlePrefixes: [], reason: rule.reason });
  assert.doesNotThrow(() => validateConfigPatch({ guards: { browserApps: ['com.google.Chrome', 'org.HongKongZiXun.MoreLogin'] } }));
  for (const bad of [{ browserApps: 'com.google.Chrome' }, { browserApps: ['com.google.Chrome.'] }, { browserApps: ['Google Chrome'] }, { browserApps: [42] }]) {
    assert.throws(() => validateConfigPatch({ guards: bad }), (error) => error.code === 'CONFIG_INVALID' && /guards\.browserApps/.test(error.field), JSON.stringify(bad));
  }
});

test('System Settings guards: every pinned macOS 26.6.2 pane name is protected, in any form; everyday panes are not', () => {
  const spec = guardSpec(DESKTOP_DEFAULTS);
  validateGuardSpec(spec); // the helper accepts it
  assert.deepEqual(spec.protectedWindows.map((rule) => rule.id), ['settings-security', 'settings-privacy', 'settings-system', 'synabun-ui']);
  for (const id of ['settings-security', 'settings-privacy', 'settings-system']) {
    const rule = spec.protectedWindows.find((r) => r.id === id);
    assert.deepEqual(rule.bundleIds, ['com.apple.systempreferences', 'com.apple.Settings']);
    assert.equal(rule.titleRe, SETTINGS_TITLE_RES[id]);
  }
  const ruleFor = (title, bundleId = 'com.apple.systempreferences') =>
    matchGuard({ bundleId, app: 'Ajustes do Sistema', windowTitle: title }, spec)?.details.rule.id ?? null;
  const settingsRule = (id) => typeof id === 'string' && id.startsWith('settings-');
  assert.deepEqual(PROTECTED_PANES_26.filter((t) => !settingsRule(ruleFor(t))), [], 'every pinned name is protected');
  assert.deepEqual(PROTECTED_PANES_26.filter((t) => !settingsRule(ruleFor(t.normalize('NFD'), 'com.apple.Settings'))), [], 'decomposed titles too');
  assert.deepEqual(PROTECTED_PANES_26.filter((t) => !settingsRule(ruleFor(t.replace(/ /g, ' ').replace(/[‑’]/g, '-')))), [], 'plain spaces and punctuation too');
  assert.deepEqual(OPEN_PANES_26.filter((t) => ruleFor(t)), [], 'everyday panes stay usable');
  assert.deepEqual(OPEN_PANES_26.filter((t) => ruleFor(t.normalize('NFD'))), []);
  assert.equal(ruleFor('Privacidade e Segurança'), 'settings-security');
  assert.equal(ruleFor('Acesso Total ao Disco'), 'settings-privacy');
  assert.equal(ruleFor('Acessibilidade'), 'settings-privacy');
  assert.equal(ruleFor('Usuários e Grupos'), 'settings-security');
  assert.equal(ruleFor('Itens de Início'), 'settings-security');
  assert.equal(ruleFor('Compartilhamento'), 'settings-system');
  assert.equal(ruleFor('Câmera lenta'), null, 'short generic names are anchored');
  assert.equal(ruleFor('Acesso Total ao Disco', 'com.apple.TextEdit'), null, 'the rules are scoped to System Settings');
  for (const blank of ['', ' ', null]) assert.equal(ruleFor(blank), null, JSON.stringify(blank));
  // The builder: NFC, escaped, ’ ' ‑ - as any character, \s for spaces, anchors grouped first.
  assert.equal(
    titleRegexFrom([{ anchor: true, en: ['Photos', 'photos'] }, { en: ['Temps d’écran', 'A.B (c)', 'Segurança'] }]),
    '^(?:Photos)$|Temps\\sd.écran|A\\.B\\s\\(c\\)|Segurança',
  );
});

test('web apps: the SynaBun web app is protected by name and by title, Safari itself is not by that rule; with the browser rule on, both are refused as browsers', () => {
  // The protected-window rule on its own (browserApps / browserAppPrefixes emptied).
  const spec = guardSpec({ ...DESKTOP_DEFAULTS, guards: { ...DESKTOP_DEFAULTS.guards, browserApps: [], browserAppPrefixes: [] } });
  for (const title of ['Restarting...', 'Stopping...', 'SynaBun Stopped', 'Neural Memory Interface', null]) {
    const hit = matchGuard({ bundleId: SYNABUN_WEB_APP, app: 'SynaBun', windowTitle: title }, spec);
    assert.equal(hit?.code, 'PROTECTED_WINDOW', String(title));
    assert.equal(hit.details.rule.id, 'synabun-ui');
  }
  assert.equal(matchGuard({ bundleId: SYNABUN_WEB_APP, app: 'SynaBun', windowTitle: 'Restarting...' }, spec).details.rule.matched, 'appName');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari.WebApp.1234', app: 'Notes', windowTitle: 'SynaBun — Memories' }, spec)?.details.rule.matched, 'title');
  assert.equal(matchGuard({ bundleId: 'com.google.Chrome.app.abcdef', app: 'Neural Interface' }, spec)?.code, 'PROTECTED_WINDOW');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari', app: 'Safari', windowTitle: 'Restarting...' }, spec), null, 'Safari itself is not');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari', app: 'Safari', windowTitle: 'SynaBun' }, spec)?.code, 'PROTECTED_WINDOW', 'a Safari tab showing SynaBun still is');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari.WebApp.99', app: 'Gmail', windowTitle: 'Inbox' }, spec), null, 'other web apps are not');
  assert.equal(matchGuard({ bundleId: 'com.apple.TextEdit', app: 'SynaBun notes', windowTitle: 'x' }, spec), null, 'only browsers and web apps');
  const ui = spec.protectedWindows.find((rule) => rule.id === 'synabun-ui');
  assert.deepEqual(ui.bundlePrefixes, [...WEB_APP_BUNDLE_PREFIXES]);
  assert.equal(ui.appNameRe, '^(SynaBun|SynApp|Neural (Memory )?Interface)\\b');
  assert.equal(spec.protectedWindows.find((rule) => rule.id === 'settings-privacy').appNameRe, undefined);
  assert.equal(guardSpec({ guards: { protectedWindows: [{ id: 'n', appNameRe: 'X' }] } }).protectedWindows[0].titleRe, undefined, 'an app-name rule is not "every window"');
  assert.equal(guardSpec({ guards: { protectedWindows: [{ id: 'all' }] } }).protectedWindows[0].titleRe, '.*');
  assert.deepEqual(guardSpec({ guards: { blockedApps: [{ id: 'w', bundlePrefixes: ['com.a.b.'] }] } }).blockedApps[0].bundlePrefixes, ['com.a.b.']);
  for (const prefix of WEB_APP_BUNDLE_PREFIXES) assert.ok(BUNDLE_PREFIX_RE.test(prefix), prefix);
  assert.deepEqual(DESKTOP_DEFAULTS.guards.browserAppPrefixes, [...WEB_APP_BUNDLE_PREFIXES]);
  const withBrowsers = guardSpec(DESKTOP_DEFAULTS);
  assert.equal(matchGuard({ bundleId: SYNABUN_WEB_APP, app: 'SynaBun', windowTitle: 'Restarting...' }, withBrowsers).details.rule.id, 'web-browsers');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari', app: 'Safari', windowTitle: 'SynaBun' }, withBrowsers).code, 'BLOCKED_APP');
  assert.equal(matchGuard({ bundleId: 'com.apple.Safari.WebApp.99', app: 'Gmail', windowTitle: 'Inbox' }, withBrowsers).details.rule.id, 'web-browsers');
  const kinds = (w) => w.map((x) => x.kind);
  assert.deepEqual(kinds(actionWarnings({ action: 'left_click', probe: { title: 'Compose', bundleId: SYNABUN_WEB_APP }, config: DESKTOP_DEFAULTS })), []);
  assert.deepEqual(kinds(actionWarnings({ action: 'left_click', probe: { title: 'Compose', bundleId: 'com.apple.Safari.WebAppX' }, config: DESKTOP_DEFAULTS })), []);
  const blockWeb = { guards: { blockedApps: [{ id: 'web', bundlePrefixes: ['com.google.Chrome.app.'], reason: 'web apps' }] } };
  assert.equal(blockedAppRule(blockWeb, { bundleId: 'COM.GOOGLE.CHROME.APP.xyz' })?.id, 'web');
  assert.equal(blockedAppRule(blockWeb, { bundleId: 'com.google.Chrome' }), null);
});

test('computer_ax listing: only invocable actions, help / placeholder as the label of unnamed nodes', () => {
  assert.deepEqual([...AX_INVOCABLE_ACTIONS], ['press', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view', 'raise', 'show_menu']);
  const frame = { bounds: { x: 0, y: 0, w: 1000, h: 500 }, image: { w: 1000, h: 500 } };
  const node = { ref: 'e3', depth: 2, role: 'AXButton', title: '', help: 'Voltar', actions: ['cancel', 'confirm', 'decrement', 'increment', 'press', 'AXCustom', 'CustomThing'], frame: { x: 10, y: 20, w: 30, h: 10 }, group: 'toolbar' };
  assert.equal(axLine(node, { frame, indent: 2 }), '    e3 AXButton "Voltar" (press) [10,20,30,10 px]');
  assert.equal(axLine(node, { group: true, tags: ['destructive', null, 'in dialog'], agentText: true }), 'e3 AXButton "Voltar" (press) (in: toolbar) [destructive] [in dialog] [addresses-agent]');
  assert.equal(axLabel({ placeholder: 'Pesquisar' }), 'Pesquisar');
  assert.equal(axLabel({ title: ' ', description: 'Buscar', help: 'x' }), 'Buscar');
  assert.equal(axLabel({ contentLabel: 'Transferências', help: 'x' }), 'Transferências');
  assert.equal(axLabel({ titleElement: 'Nome', contentLabel: 'y' }), 'Nome');
  assert.equal(axLabel({}), '');
  assert.equal(axLine({ ref: 'e9', role: 'AXTextField', subrole: 'AXSecureTextField', secure: true, value: 'hunter2', title: 'Senha', actions: ['focus', 'set_value'] }), 'e9 AXTextField/AXSecureTextField "Senha" [secure] (focus,set_value)');
});

test('desktop config (protocol 2): prefix and appNameRe validation, intent limits, replace-wholesale', () => {
  let stored = null;
  const store = createDesktopConfigStore({ get: () => stored, set: (key, value) => { stored = value; } });
  assert.deepEqual([store.read().limits.axIntentMaxNodes, store.read().limits.axIntentTexts], [600, 80]);
  for (const bad of [
    { guards: { browserAppPrefixes: ['com.apple.Safari'] } },
    { guards: { browserAppPrefixes: 'com.apple.Safari.WebApp.' } },
    { guards: { blockedApps: [{ id: 'x', bundlePrefixes: ['com.'] }] } },
    { guards: { protectedWindows: [{ id: 'x', bundlePrefixes: ['.com.apple.'] }] } },
    { guards: { protectedWindows: [{ id: 'x', bundlePrefixes: ['com..apple.'] }] } },
    { guards: { protectedWindows: [{ id: 'x', appNameRe: '(' }] } },
    { guards: { protectedWindows: [{ id: 'x', titleRe: 5 }] } },
    { limits: { axIntentMaxNodes: 5 } }, { limits: { axIntentMaxNodes: 2001 } }, { limits: { axIntentTexts: -1 } }, { limits: { axIntentTexts: '80' } },
    { limits: [] },
  ]) {
    assert.throws(() => store.update(bad), (e) => e.code === 'CONFIG_INVALID', JSON.stringify(bad));
  }
  store.update({
    guards: { browserAppPrefixes: ['com.apple.Safari.WebApp.'], protectedWindows: [{ id: 'mine', appNameRe: '^Bank\\b', bundlePrefixes: ['com.apple.Safari.WebApp.'] }] },
    limits: { axIntentMaxNodes: 900 },
  });
  const cfg = store.read();
  assert.deepEqual(cfg.guards.protectedWindows.map((r) => r.id), ['mine'], 'a custom list replaces every default rule, the localized System Settings ones included');
  assert.equal(cfg.limits.axIntentTexts, 80, 'nested defaults survive');
  assert.deepEqual(desktopIntentLimits(cfg), { maxNodes: 900, maxTexts: 80 });
  assert.deepEqual(desktopIntentLimits({}), { maxNodes: 600, maxTexts: 80 });
  assert.deepEqual(desktopIntentLimits({ limits: { axIntentMaxNodes: 99999, axIntentTexts: -3 } }), { maxNodes: 2000, maxTexts: 0 });
  assert.deepEqual(desktopIntentLimits({ limits: { axIntentMaxNodes: 'lots' } }), { maxNodes: 600, maxTexts: 80 });
});

test('lease: one controller, a worker takes over from its session, others wait, idle expiry', () => {
  let clock = 0;
  const lease = createLease({ now: () => clock, idleTtlMs: 1000 });
  const session = { assistantSessionId: 's1', label: 'assistant' };
  const worker = { assistantSessionId: 's1', runId: 'run-1', label: 'worker' };
  const other = { assistantSessionId: 's2', label: 'other' };
  assert.deepEqual(lease.acquire(session), { ok: true, acquired: true, transferred: false });
  assert.deepEqual(lease.acquire(session), { ok: true, acquired: false, transferred: false });
  assert.equal(lease.acquire(other).ok, false);
  assert.deepEqual(lease.acquire(worker), { ok: true, acquired: true, transferred: true });
  assert.equal(lease.acquire(session).ok, false, 'the session waits while its worker drives');
  clock = 1500;
  assert.equal(lease.acquire(other).ok, true, 'idle lease expired');
  assert.equal(lease.release({ runId: 'run-1' }), null);
  assert.equal(lease.release({ assistantSessionId: 's2' }).owner.label, 'other');
  assert.equal(lease.current(), null);
});

test('frames: latest evidence per owner, stale marks, TTL, explicit screenshot ids, ring buffer', () => {
  let clock = 0;
  let n = 0;
  const frames = createFrameStore({ now: () => clock, ttlMs: 1000, memoryCount: 4, random: () => `${++n}` });
  const shot = { bounds: { x: 0, y: 0, w: 100, h: 50 }, image: { w: 100, h: 50, mime: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') } };
  const f1 = frames.add('session:s1', shot);
  assert.equal(frames.fresh('session:s1').ok, true);
  assert.match(f1.sha256, /^[0-9a-f]{64}$/);
  assert.equal(frames.fresh('session:s1', 'wrong').ok, false);
  frames.markStale('*', 'the user moved the mouse');
  assert.match(frames.fresh('session:s1').reason, /moved the mouse/);
  frames.add('session:s1', shot);
  clock = 2000;
  assert.match(frames.fresh('session:s1').reason, /too old/);
  const zoom = frames.add('session:s1', shot, { evidence: false, kind: 'zoom' });
  assert.notEqual(frames.latestFor('session:s1').id, zoom.id, 'zoom frames are never evidence');
  for (let i = 0; i < 6; i += 1) frames.add('session:s2', shot);
  assert.ok(frames.size() <= 4);
  assert.equal(frames.get(f1.id), null, 'oldest frames fall out of the ring');
});

test('grants are unforgeable-looking tokens revoked by token, run or session', () => {
  const grants = createGrantRegistry();
  const brain = grants.mint({ kind: 'brain', assistantSessionId: 's1', provider: 'opencode' });
  const run = grants.mint({ kind: 'run', assistantSessionId: 's1', runId: 'run-1' });
  assert.ok(isGrantToken(brain));
  assert.equal(grants.resolve(brain).kind, 'brain');
  assert.equal(grants.resolve('sbd_nope'), null);
  assert.equal(grants.revokeFor({ runId: 'run-1' }), 1);
  assert.equal(grants.resolve(run), null);
  assert.equal(grants.revokeFor({ assistantSessionId: 's1' }), 1);
  assert.equal(grants.resolve(brain), null);
});

test('audit: typed text is stored as length + hash only; retention prunes old days', (t) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-desktop-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-23T12:00:00Z');
  const audit = createAuditLog({ dir, now: () => clock, retentionDays: 2 });
  audit.record({ owner: { assistantSessionId: 's1' }, action: 'type', text: 'my secret note', code: 'OK' });
  const line = readFileSync(resolve(dir, '2026-09-23.jsonl'), 'utf8');
  assert.ok(!line.includes('secret'));
  assert.equal(JSON.parse(line).text.length, 14);
  assert.equal(audit.recent({ assistantSessionId: 's1' }).length, 1);
  writeFileSync(resolve(dir, '2026-09-10.jsonl'), '{}\n');
  assert.equal(audit.prune(), 1);
  assert.deepEqual(readdirSync(dir), ['2026-09-23.jsonl']);
});

test('desktop config: defaults merged with the stored row; arrays replace; patches validated', () => {
  let stored = null;
  const store = createDesktopConfigStore({ get: () => stored, set: (key, value) => { stored = value; } });
  assert.equal(store.read().enabled, false);
  assert.ok(store.read().guards.blockedApps.length >= 5);
  store.update({ guards: { blockedApps: [{ id: 'mine', bundleIds: ['com.example.app'] }] }, userPauseMs: 4000 });
  assert.deepEqual(store.read().guards.blockedApps.map((r) => r.id), ['mine'], 'user lists replace the defaults');
  assert.equal(store.read().guards.secureField, true, 'nested defaults survive');
  assert.throws(() => store.update({ enabled: true }), (e) => e.code === 'CONFIG_INVALID', 'setup fields are service-owned');
  assert.throws(() => store.update({ guards: { protectedWindows: [{ id: 'x', titleRe: '(' }] } }), (e) => e.field.includes('titleRe'));
  store.write({ enabled: true, setupCompletedAt: 'now' });
  assert.equal(store.read().enabled, true);
  assert.deepEqual(mergeConfig({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
});

test('a held grant resolves to nothing until it is activated; its remote origin rides on it', () => {
  const grants = createGrantRegistry();
  const plain = grants.mint({ kind: 'brain', assistantSessionId: 's1', provider: 'claude-code' });
  assert.deepEqual([grants.resolve(plain).held, grants.resolve(plain).remote], [false, null], 'a desktop session\'s grant: live, no origin');
  const held = grants.mint({ kind: 'brain', assistantSessionId: 'wa-1', provider: 'claude-code', held: true, remote: { channel: 'whatsapp' } });
  assert.ok(isGrantToken(held));
  assert.equal(grants.resolve(held), null, 'held: the token exists but resolves to nothing');
  assert.equal(grants.isHeld(held), true);
  // Activated for a turn nobody had to approve…
  assert.equal(grants.setActive(held, true, { remote: { channel: 'whatsapp', approval: 'unasked' } }), true);
  assert.deepEqual(grants.resolve(held).remote, { channel: 'whatsapp', approval: 'unasked' });
  // …held again, then live under an approved turn (who approved it is recorded).
  grants.setActive(held, false, { remote: { channel: 'whatsapp' } });
  assert.equal(grants.resolve(held), null);
  grants.setActive(held, true, { remote: { channel: 'whatsapp', approval: 'approved_turn', approvedBy: 'whatsapp' } });
  assert.deepEqual(grants.resolve(held).remote, { channel: 'whatsapp', approval: 'approved_turn', approvedBy: 'whatsapp' });
  // Only the two approvals and the two approvers exist; anything else is dropped, never trusted.
  grants.setActive(held, true, { remote: { channel: 'whatsapp', approval: 'always', approvedBy: 'model' } });
  assert.deepEqual(grants.resolve(held).remote, { channel: 'whatsapp', approval: null });
  grants.setActive(held, true, { remote: { channel: 'whatsapp', approval: 'unasked', approvedBy: 'whatsapp' } });
  assert.deepEqual(grants.resolve(held).remote, { channel: 'whatsapp', approval: 'unasked' }, 'nobody approves an unasked use');
  // Only `true` activates; an unknown token is not created by activating it.
  for (const value of ['true', 1, undefined]) { grants.setActive(held, value); assert.equal(grants.resolve(held), null, String(value)); }
  assert.equal(grants.setActive(`sbd_${'A'.repeat(43)}`, true), false);
  assert.equal(grants.resolve(`sbd_${'A'.repeat(43)}`), null);
  // Revoked for good with its session, held or not; the list never shows a whole token.
  assert.ok(grants.list().every((row) => row.token.length === 9 && typeof row.held === 'boolean'));
  assert.equal(grants.revokeFor({ assistantSessionId: 'wa-1' }), 1);
  assert.equal(grants.setActive(held, true), false);
  assert.equal(grants.resolve(held), null);
  assert.ok(grants.resolve(plain), 'another session\'s grant is untouched');
});
