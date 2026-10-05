/**
 * Deterministic risk of pressing a Mac control, and the candidate list Jev may
 * be shown for a `computer_ax` intent.
 *
 * Pure: no AX, no sqlite, no TypeSafe client. The Neural Interface imports the
 * compiled copy to classify what the helper's accessibility snapshot found and
 * to re-check a candidate at press time; the MCP layer and the desktop bench
 * run the same functions, so "may this be pressed by intent" has one
 * definition everywhere. `lib/desktop/*` never imports this file: server.js
 * injects it.
 *
 * `navigation` is an allow-list verdict, as in browser-risk.ts. A control
 * earns it only by passing every clause; anything not positively recognised is
 * `unknown`, and only `navigation` may ever be pressed by intent. Jev never
 * sees this module's inputs beyond the Jev-bound candidate fields and cannot
 * influence its output: no on-screen text can talk a control into it.
 *
 * What may leave the Neural Interface for Jev is `DesktopCandidate`: an opaque
 * id, a plain role name, a kind, the visible label, a tooltip, the nearest
 * labelled container and two flags. Never a value, a window title, an
 * identifier, a ref, a frame, a bundle id, static text, a password field (not
 * even its name) or web content from a browser. Everything else a candidate
 * carries (`DesktopCandidateEntry`) stays on the server.
 */

import { createHash } from 'node:crypto';
import { lexiconClass, addressesAgent, normalizeName, LEXICON_LANGS } from './browser-risk.js';

export type DesktopRisk =
  | 'navigation' | 'payment' | 'authentication' | 'file' | 'publish' | 'destructive' | 'write'
  | 'grant' | 'dialog' | 'web' | 'field' | 'toggle' | 'value' | 'menu' | 'selection' | 'window' | 'launch'
  | 'restricted-app' | 'unknown';

/** What sort of control a candidate is, in the words Jev reads. */
export type DesktopKind = 'button' | 'link' | 'tab' | 'disclosure' | 'menu' | 'field' | 'toggle' | 'value' | 'item' | 'other';

export interface DesktopFrame { x: number; y: number; w: number; h: number }

/**
 * One node of the helper's `ax_snapshot` (protocol 2). Travels helper → Neural
 * Interface and stops there: it holds values, identifiers and every label
 * source, so it is NEVER serialized to the MCP layer, to Jev or to a log.
 */
export interface DesktopNode {
  ref?: string;
  parent?: string | null;
  depth?: number;
  role?: string | null;
  subrole?: string | null;
  title?: string | null;
  description?: string | null;
  value?: unknown;
  secure?: boolean;
  enabled?: boolean;
  focused?: boolean;
  actions?: string[];
  frame?: DesktopFrame | null;
  help?: string | null;
  placeholder?: string | null;
  identifier?: string | null;
  /** Nearest labelled container, "<role without AX, lowercased> <label>"; never a window title. */
  group?: string | null;
  /** Under a sheet, a popover, or a dialog / modal window. */
  modal?: boolean;
  /** Under an AXWebArea. */
  web?: boolean;
  /** enrich only: AXValue or AXTitle of AXTitleUIElement. */
  titleElement?: string | null;
  /** enrich only: rows and cells without a title — the first static text within two levels. */
  contentLabel?: string | null;
}

/** The helper's snapshot result, as far as this module reads it. */
export interface DesktopSnapshot {
  snapshotId?: string;
  app?: { pid?: number | null; bundleId?: string | null; name?: string | null; lang?: string | null } | null;
  window?: { id?: number | null; title?: string | null; subrole?: string | null; modal?: boolean } | null;
  nodes?: DesktopNode[];
  /** enrich only: static texts, read here for text that addresses the agent and never forwarded. */
  texts?: string[];
  truncated?: boolean;
}

export interface DesktopRiskContext { bundleId?: string | null; lang?: string | null }
export interface DesktopRiskVerdict { risk: DesktopRisk; clause: string }

/**
 * The only shape that may be sent to Jev for a candidate. `id` is opaque
 * (`c1…cN`), never a ref.
 */
export interface DesktopCandidate {
  id: string;
  role: string;
  kind: DesktopKind;
  name: string;
  hint?: string;
  group?: string;
  disabled: boolean;
  inDialog: boolean;
}

/**
 * What the helper re-checks, inside the same queued command as AXPress, before
 * it presses (protocol 2 `ax_action … verify`). Built from the snapshot's own
 * node fields, trimmed; never sent to the MCP layer.
 */
export interface DesktopVerifyFacts {
  pid: number | null;
  role: string | null;
  subrole: string | null;
  title: string | null;
  description: string | null;
  help: string | null;
  identifier: string | null;
}

/** Server-only companion of a candidate. Stays in the Neural Interface. */
export interface DesktopCandidateEntry {
  id: string;
  ref: string;
  candidate: DesktopCandidate;
  risk: DesktopRisk;
  clause: string;
  pressable: boolean;
  /** Intent tokens found in name, hint and group. */
  lex: number;
  weight: number;
  /** Position in the snapshot (tree order). */
  order: number;
  verify: DesktopVerifyFacts;
  context: { bundleId: string | null; lang: string; pid: number | null };
  node: DesktopNode;
}

/**
 * What the Neural Interface may hand to the MCP layer per candidate: the
 * Jev-bound fields plus what the agent and the eligibility check need. The MCP
 * layer strips it back to `DesktopCandidate` before anything is sent to Jev.
 */
export interface DesktopCandidateView extends DesktopCandidate {
  ref: string;
  risk: DesktopRisk;
  pressable: boolean;
  weight: number;
  lex: number;
}

export interface DesktopCandidateCounts {
  /** Every node in the snapshot. */
  nodes: number;
  /** Named, invocable controls that could be offered: `ranked + notRanked`. */
  considered: number;
  ranked: number;
  notRanked: number;
  secure: number;
  unnamed: number;
  chrome: number;
  web: number;
  inert: number;
}

export interface DesktopCandidateSet {
  snapshotId: string | null;
  intent: string;
  /** Jev-bound: the app's name and interface language, nothing else about it. */
  app: { name: string; lang: string };
  /** Jev-bound, tree order, `c1…cN`. */
  candidates: DesktopCandidate[];
  /** Server-only, the same order and ids. */
  entries: DesktopCandidateEntry[];
  dialogOpen: boolean;
  /** Nodes and static texts whose text addresses an automated reader. */
  agentText: number;
  /** The helper cut the tree short, or ranking left controls out. */
  truncated: boolean;
  counts: DesktopCandidateCounts;
}

// --- Text normalisation ---

/** normalizeName plus diacritic folding, identical to browser-risk's, so both lexicons meet the same text. */
function fold(value: unknown): string {
  return normalizeName(value).normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC').replace(/ı/g, 'i').replace(/ß/g, 'ss');
}

/** "d e l e t e" → "delete". Only when every token is a single letter. */
function despaced(folded: string): string | null {
  return /^(?:\p{L}\s){3,}\p{L}$/u.test(folded) ? folded.replace(/\s/g, '') : null;
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const hasAlnum = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);
const trimmed = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Primary subtag, lowercased: "pt-BR" → "pt". Anything else (Base, garbage, empty) → '' — no language, no navigation. */
export function normalizeLang(value: unknown): string {
  const primary = String(value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

// --- Vocabularies (dk1) ---

type DesktopTermClass = 'destructive' | 'grant' | 'dialog' | 'write' | 'publish';

/**
 * Desktop command vocabulary in the eight interface languages the browser
 * lexicon covers. Matched as whole words on a control's labels (and on the
 * intent), after the same folding as the browser lexicon; up to two filler
 * words may sit inside a multi-word entry. Checked in this order, first class
 * wins. The browser lexicon (rk1) still applies after it; this adds what a Mac
 * says that a web page does not.
 */
const DESKTOP_TERMS: Record<DesktopTermClass, string[]> = {
  destructive: [
    "don't save", 'dont save', 'do not save', 'quit', 'force quit', 'replace', 'revert', 'revert to saved', 'overwrite',
    'move to trash', 'move to bin', 'empty trash', 'empty bin', 'erase', 'eject', 'restart', 'shut down', 'shutdown',
    'não salvar', 'não guardar', 'encerrar', 'forçar encerramento', 'substituir', 'reverter', 'mover para o lixo', 'esvaziar lixo', 'esvaziar o lixo', 'ejetar', 'reiniciar', 'desligar',
    'no guardar', 'salir', 'forzar salida', 'reemplazar', 'revertir', 'trasladar a la papelera', 'mover a la papelera', 'vaciar papelera', 'vaciar la papelera', 'expulsar', 'apagar',
    'ne pas enregistrer', 'quitter', 'forcer à quitter', 'remplacer', 'revenir à la version', 'placer dans la corbeille', 'mettre à la corbeille', 'vider la corbeille', 'éjecter', 'redémarrer', 'éteindre',
    'nicht sichern', 'nicht speichern', 'beenden', 'sofort beenden', 'ersetzen', 'in den papierkorb legen', 'papierkorb entleeren', 'auswerfen', 'neustart', 'neu starten', 'ausschalten',
    'non salvare', 'esci', 'uscita forzata', 'forza uscita', 'sostituisci', 'ripristina', 'sposta nel cestino', 'svuota il cestino', 'svuota cestino', 'inizializza', 'espelli', 'riavvia', 'spegni',
    'kaydetme', 'çık', 'çıkmaya zorla', 'zorla çık', 'değiştir', 'yerine koy', 'geri döndür', 'çöp sepetine taşı', 'çöp sepetini boşalt', 'çıkar', 'yeniden başlat', 'kapat', 'sistemi kapat',
    '保存しない', '終了', '強制終了', '置き換え', '復帰', 'ゴミ箱に入れる', 'ゴミ箱を空にする', '取り出す', '再起動', 'システム終了', 'アーカイブ',
  ],
  grant: [
    'allow', "don't allow", 'always allow', 'deny', 'trust', 'open anyway', 'install', 'authorize', 'authorise',
    'permitir', 'não permitir', 'negar', 'confiar', 'abrir mesmo assim', 'instalar', 'autorizar',
    'no permitir', 'denegar', 'abrir igualmente', 'abrir de todos modos',
    'autoriser', 'ne pas autoriser', 'refuser', 'faire confiance', 'ouvrir quand même', 'installer',
    'erlauben', 'zulassen', 'nicht erlauben', 'ablehnen', 'vertrauen', 'trotzdem öffnen', 'installieren',
    'consenti', 'consentire', 'non consentire', 'rifiuta', 'autorizza', 'fidati', 'apri comunque', 'installa',
    'izin ver', 'izin verme', 'reddet', 'güven', 'yine de aç', 'yükle',
    '許可', '拒否', '信頼', 'このまま開く', 'インストール',
  ],
  dialog: [
    'continue', 'cancel', 'done',
    'continuar', 'cancelar', 'concluído', 'concluir',
    'continuer', 'annuler', 'terminé',
    'fortfahren', 'abbrechen', 'fertig',
    'continua', 'annulla',
    'devam', 'devam et', 'vazgeç', 'iptal',
    '続ける', 'キャンセル', '完了',
  ],
  write: [
    'new', 'paste', 'undo', 'redo', 'print', 'record', 'connect', 'compose', 'rotate', 'crop', 'insert', 'bold', 'italic', 'underline', 'strikethrough', 'checklist', 'run', 'execute', 'lock', 'unlock', 'sichern',
    'novo', 'nova', 'colar', 'desfazer', 'refazer', 'imprimir', 'gravar', 'conectar', 'escrever', 'girar', 'recortar', 'inserir', 'negrito', 'itálico', 'sublinhado', 'executar', 'desbloquear',
    'nuevo', 'nueva', 'pegar', 'deshacer', 'rehacer', 'grabar', 'redactar', 'insertar', 'negrita', 'cursiva', 'subrayado', 'ejecutar',
    'nouveau', 'nouvelle', 'coller', 'rétablir', 'imprimer', 'connecter', 'rédiger', 'faire pivoter', 'pivoter', 'rogner', 'insérer', 'gras', 'italique', 'souligné', 'exécuter', 'verrouiller', 'déverrouiller',
    'neu', 'neue', 'neuer', 'neues', 'einsetzen', 'einfügen', 'widerrufen', 'wiederholen', 'drucken', 'aufnehmen', 'verbinden', 'verfassen', 'drehen', 'beschneiden', 'zuschneiden', 'fett', 'kursiv', 'unterstrichen', 'ausführen', 'sperren', 'entsperren',
    'nuovo', 'nuova', 'incolla', 'ripeti', 'stampa', 'registra', 'connetti', 'componi', 'ruota', 'ritaglia', 'inserisci', 'grassetto', 'corsivo', 'sottolineato', 'esegui', 'sblocca',
    'yeni', 'yapıştır', 'geri al', 'yinele', 'yazdır', 'kaydı başlat', 'bağlan', 'döndür', 'kırp', 'kalın', 'italik', 'altı çizili', 'çalıştır', 'kilitle', 'kilidi aç',
    '新規', 'ペースト', '貼り付け', '取り消す', 'やり直す', 'プリント', '印刷', '録音', '録画', '接続', '回転', 'トリミング', '挿入', '太字', '斜体', '下線', '実行', 'ロック',
  ],
  publish: [
    'call', 'facetime', 'forward', 'reply all', 'airdrop', 'decline', 'answer', 'start meeting', 'start call', 'video call', 'voice call', 'collaborate', 'dial',
    'ligar', 'encaminhar', 'responder a todos', 'recusar', 'atender', 'colaborar', 'chamada',
    'llamar', 'reenviar', 'rechazar', 'contestar',
    'appeler', 'transférer', 'répondre à tous', 'décrocher', 'collaborer',
    'anrufen', 'weiterleiten', 'allen antworten', 'annehmen', 'zusammenarbeiten',
    'chiama', 'chiamata', 'inoltra', 'rispondi a tutti', 'collabora',
    'ara', 'arama', 'ilet', 'yönlendir', 'tümünü yanıtla', 'cevapla', 'birlikte çalış',
    '電話', '発信', '通話', '転送', '全員に返信', '応答', '共同制作',
  ],
};

/** Short answers that mean a dialog button only when they are the whole label ("OK", "Não", "はい"). */
const DESKTOP_EXACT_TERMS: Record<'dialog', string[]> = {
  dialog: ['ok', 'okay', 'yes', 'no', 'sim', 'não', 'sí', 'si', 'oui', 'non', 'ja', 'nein', 'sì', 'fine', 'fatto', 'evet', 'hayır', 'tamam', 'bitti', 'はい', 'いいえ'],
};

/**
 * Matched on the intent only, never on labels: an intent to type into a field
 * or to flip a switch. Pressing by intent never types or toggles, so such an
 * intent is advised on and never pressed, whatever Jev picks.
 */
const DESKTOP_INTENT_TERMS: Record<'field' | 'toggle', string[]> = {
  field: [
    'type', 'write', 'fill', 'fill in', 'fill out', 'input', 'search for', 'look up',
    'digitar', 'digite', 'escreva', 'preencher', 'preencha', 'pesquisar', 'pesquise', 'buscar', 'busque', 'procurar', 'procure',
    'escribir', 'escribe', 'teclear', 'rellenar', 'rellena', 'introducir', 'introduce', 'busca',
    'taper', 'tape', 'saisir', 'saisis', 'écrire', 'écris', 'remplir', 'remplis', 'rechercher', 'recherche', 'chercher', 'cherche',
    'tippen', 'tippe', 'eingeben', 'gib ein', 'schreiben', 'schreibe', 'ausfüllen', 'fülle aus', 'suchen', 'suche',
    'digitare', 'digita', 'scrivere', 'scrivi', 'compilare', 'compila', 'inserire', 'cercare', 'cerca',
    'yaz', 'yazın', 'doldur', 'arat',
    '入力', '記入', '書く', '書いて', '検索',
  ],
  toggle: [
    'toggle', 'tick', 'untick', 'uncheck', 'checkbox', 'check box', 'switch on', 'switch off', 'activate',
    'marcar', 'marque', 'desmarcar', 'desmarque', 'ligue', 'desligue',
    'marca', 'desmarca', 'encender', 'enciende', 'apaga',
    'cocher', 'coche', 'décocher', 'décoche', 'allumer',
    'ankreuzen', 'abhaken', 'einschalten', 'anschalten',
    'spuntare', 'spunta', 'accendere', 'accendi', 'spegnere',
    'işaretle', 'işareti kaldır',
    'チェック', 'オンにする', 'オフにする', '有効にする', '無効にする',
  ],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isCjk = (s: string) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(s);

/** The browser lexicon's matcher, rebuilt here because browser-risk does not export it. */
function lexicon(terms: string[]): RegExp {
  const folded = [...new Set(terms.map(fold).filter(Boolean))].sort((a, b) => b.length - a.length);
  const cjk = folded.filter(isCjk).map(escapeRe);
  const words = folded.filter(t => !isCjk(t)).map(t => escapeRe(t).replace(/ /g, "(?:\\s+[\\p{L}\\p{N}']+){0,2}\\s+"));
  const parts: string[] = [];
  if (words.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`);
  if (cjk.length) parts.push(`(?:${cjk.join('|')})`);
  return new RegExp(parts.join('|'), 'u');
}

const TERM_ORDER: DesktopTermClass[] = ['destructive', 'grant', 'dialog', 'write', 'publish'];
const TERM_RES = Object.fromEntries(TERM_ORDER.map(name => [name, lexicon(DESKTOP_TERMS[name])])) as Record<DesktopTermClass, RegExp>;
const INTENT_RES = { field: lexicon(DESKTOP_INTENT_TERMS.field), toggle: lexicon(DESKTOP_INTENT_TERMS.toggle) };
const EXACT_DIALOG = new Set(DESKTOP_EXACT_TERMS.dialog.map(fold));

function hits(re: RegExp, text: string): boolean {
  const folded = fold(text);
  if (!folded) return false;
  if (re.test(folded)) return true;
  const joined = despaced(folded);
  return joined ? re.test(joined) : false;
}

/** The whole label, folded and stripped of punctuation: "OK…" → "ok". */
const bare = (value: unknown) => fold(value).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Desktop vocabulary class of a text: a control's labels, or an intent. Exact
 * dialog answers are checked on each label on its own, so pass the labels as
 * separate strings where there are several.
 */
export function desktopTermClass(...texts: unknown[]): DesktopTermClass | null {
  const strings = texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  if (!strings.length) return null;
  const joined = strings.join(' \n ');
  for (const name of TERM_ORDER) {
    if (name === 'dialog' && strings.some(s => EXACT_DIALOG.has(bare(s)))) return 'dialog';
    if (hits(TERM_RES[name], joined)) return name;
  }
  return null;
}

/** An intent to type or to toggle (intent vocabulary only). */
export function desktopIntentClass(intent: unknown): 'field' | 'toggle' | null {
  const text = typeof intent === 'string' ? intent : '';
  if (hits(INTENT_RES.field, text)) return 'field';
  if (hits(INTENT_RES.toggle, text)) return 'toggle';
  return null;
}

/**
 * The class an intent names, if any: the shared browser lexicon, the desktop
 * vocabulary, or the typing / toggling vocabulary. An intent that names one is
 * advised on and never pressed.
 */
export function intentClass(intent: unknown): string | null {
  const text = typeof intent === 'string' ? intent : '';
  if (!text.trim()) return null;
  return lexiconClass(text) ?? desktopTermClass(text) ?? desktopIntentClass(text);
}

// --- Roles ---

/** Plain names Jev reads instead of AX roles. Unknown roles fall back to the role without "AX", spaced and lowercased. */
export const ROLE_NAMES: Record<string, string> = {
  AXButton: 'button', AXLink: 'link', AXTab: 'tab', AXDisclosureTriangle: 'disclosure triangle',
  AXCheckBox: 'checkbox', AXRadioButton: 'radio button', AXSwitch: 'switch',
  AXTextField: 'text field', AXTextArea: 'text area', AXComboBox: 'combo box', AXSearchField: 'search field', AXSecureTextField: 'password field',
  AXPopUpButton: 'pop-up button', AXMenuButton: 'menu button', AXMenuItem: 'menu item', AXMenuBarItem: 'menu bar item',
  AXSlider: 'slider', AXIncrementor: 'stepper', AXColorWell: 'color well',
  AXRow: 'row', AXCell: 'cell', AXOutlineRow: 'row', AXDockItem: 'dock item',
  AXImage: 'image', AXStaticText: 'text', AXGroup: 'group', AXToolbar: 'toolbar',
};
/** Subrole overrides: a tab is a radio button to AX and a tab to a person. */
const SUBROLE_NAMES: Record<string, string> = { AXTabButton: 'tab', AXSearchField: 'search field', AXSecureTextField: 'password field', AXSwitch: 'switch' };

const TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXSecureTextField'];
const TOGGLE_ROLES = ['AXCheckBox', 'AXRadioButton', 'AXSwitch'];
const VALUE_ROLES = ['AXSlider', 'AXIncrementor', 'AXColorWell'];
const MENU_ROLES = ['AXMenuItem', 'AXMenuButton', 'AXPopUpButton', 'AXMenuBarItem'];
const SELECTION_ROLES = ['AXRow', 'AXCell', 'AXOutlineRow'];
const LAUNCH_ROLES = ['AXDockItem'];
/** Window chrome: never offered, and `window` risk if classified directly. */
const CHROME_ROLES = ['AXScrollBar', 'AXSplitter', 'AXGrowArea', 'AXValueIndicator', 'AXWindow', 'AXMenuBar', 'AXMenuBarItem'];
const CHROME_SUBROLES = ['AXCloseButton', 'AXMinimizeButton', 'AXZoomButton', 'AXFullScreenButton', 'AXToolbarButton', 'AXDecrementArrow', 'AXIncrementArrow', 'AXDecrementPage', 'AXIncrementPage'];
const TAB_SUBROLES = ['AXTabButton'];
/** Windows whose every control counts as inside a dialog. */
const DIALOG_WINDOW_SUBROLES = ['AXDialog', 'AXSystemDialog'];
/** Actions that make a node a control; `raise` and `scroll_into_view` alone do not. */
const INVOCABLE_ACTIONS = ['press', 'focus', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'show_menu'];

const has = (list: string[], value: unknown) => typeof value === 'string' && list.includes(value);

function isSecure(node: DesktopNode): boolean {
  return node.secure === true || node.subrole === 'AXSecureTextField' || node.role === 'AXSecureTextField';
}
function isChrome(node: DesktopNode): boolean {
  return has(CHROME_ROLES, node.role) || has(CHROME_SUBROLES, node.subrole);
}
function isTextRole(node: DesktopNode): boolean {
  return has(TEXT_ROLES, node.role) || has(TEXT_ROLES, node.subrole);
}
function isTab(node: DesktopNode): boolean {
  return node.role === 'AXTab' || (node.role === 'AXRadioButton' && has(TAB_SUBROLES, node.subrole));
}

/** "AXButton" → "button"; "AXRadioButton" + AXTabButton → "tab"; "AXFooBar" → "foo bar". */
export function roleName(node: Pick<DesktopNode, 'role' | 'subrole'>): string {
  if (typeof node.subrole === 'string' && SUBROLE_NAMES[node.subrole]) return SUBROLE_NAMES[node.subrole];
  const role = typeof node.role === 'string' ? node.role : '';
  if (ROLE_NAMES[role]) return ROLE_NAMES[role];
  const plain = role.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return plain.slice(0, 24) || 'control';
}

export function kindOf(node: DesktopNode): DesktopKind {
  if (isTab(node)) return 'tab';
  if (isTextRole(node)) return 'field';
  if (has(TOGGLE_ROLES, node.role) || node.subrole === 'AXSwitch') return 'toggle';
  if (node.role === 'AXButton') return 'button';
  if (node.role === 'AXLink') return 'link';
  if (node.role === 'AXDisclosureTriangle') return 'disclosure';
  if (has(MENU_ROLES, node.role)) return 'menu';
  if (has(VALUE_ROLES, node.role)) return 'value';
  if (has(SELECTION_ROLES, node.role)) return 'item';
  return 'other';
}

// --- Names ---

/** Label sources in precedence order; the placeholder only names a text field. */
function labelSources(node: DesktopNode): string[] {
  return [node.title, node.description, node.titleElement, node.contentLabel, node.help, isTextRole(node) ? node.placeholder : null].map(clean).filter(Boolean);
}

/** Every label a person could read on or about the control, for classification. Values are never read. */
function allLabels(node: DesktopNode): string[] {
  return [node.title, node.description, node.titleElement, node.contentLabel, node.help, node.placeholder].map(clean).filter(Boolean);
}

/** The name a person would read: title → description → titleElement → contentLabel → help → placeholder (fields only). */
export function axName(node: DesktopNode): string {
  return labelSources(node).find(hasAlnum) ?? '';
}

/** Latin mixed with Cyrillic or Greek is the homoglyph pattern ("Bаck" with a Cyrillic а). */
function mixedConfusableScripts(text: string): boolean {
  return /\p{Script=Latin}/u.test(text) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(text);
}

/** A label that reads like a selector or markup is written for a tool, not a person. */
const MARKUP_RE = /(?:>>|["\][{}<>`\\]|\b(?:css|xpath|text|role)\s*=)/i;

// --- Money ---

/** A price: a currency marker next to digits, either side. Read on labels only. */
const CURRENCY_RE = /(?:US\$|R\$|A\$|C\$|NZ\$|HK\$|\$|€|£|¥|₺|₹|₩|₽|CHF|zł)\s?\d|\d(?:[\d.,'   ]*\d)?\s?(?:€|£|¥|₺|₹|₩|₽|CHF|zł|円|US\$|R\$|\$)/i;

/**
 * Place names that the shared payment vocabulary misreads in a system app:
 * the Portuguese Finder calls Downloads "Transferências", which the web
 * lexicon rightly reads as money transfers. Exact, folded, full names only;
 * rows and cells of the listed app only. Everything else about the node is
 * still classified (a row stays `selection`, never pressable).
 */
const SYSTEM_PLACE_NAMES: Record<string, string[]> = {
  'com.apple.finder': ['transferências'],
};

function isSystemPlace(node: DesktopNode, ctx: DesktopRiskContext): boolean {
  const names = SYSTEM_PLACE_NAMES[String(ctx.bundleId ?? '').toLowerCase()];
  if (!names || !has(SELECTION_ROLES, node.role)) return false;
  const folded = names.map(fold);
  const labels = allLabels(node);
  return labels.length > 0 && labels.every(label => folded.includes(fold(label)));
}

// --- Apps ---

/** Browsers: the same list as neural-interface/lib/desktop/config.js BROWSER_BUNDLES. */
export const DESKTOP_BROWSER_BUNDLES = [
  'com.google.Chrome', 'com.google.chrome.for.testing', 'org.chromium.Chromium', 'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'company.thebrowser.Browser', 'com.microsoft.edgemac', 'org.mozilla.firefox', 'com.brave.Browser', 'com.operasoftware.Opera', 'com.vivaldi.Vivaldi',
] as const;
/** Installed web apps (config.js WEB_APP_BUNDLE_PREFIXES). Only the Safari prefix is verified; the Chromium ones follow Chromium's naming. */
export const DESKTOP_WEB_APP_PREFIXES = [
  'com.apple.Safari.WebApp.', 'com.google.Chrome.app.', 'com.google.Chrome.canary.app.', 'org.chromium.Chromium.app.',
  'com.microsoft.edgemac.app.', 'com.brave.Browser.app.', 'com.vivaldi.Vivaldi.app.',
] as const;
/**
 * Apps where a press can buy something, change the system, or act on a device
 * or another machine. Everything in them is advice only. The browsers and web
 * apps are added below.
 */
const SYSTEM_RESTRICTED_BUNDLES = [
  'com.apple.systempreferences', 'com.apple.Settings', 'com.apple.AppStore', 'com.apple.Music', 'com.apple.TV', 'com.apple.iBooksX',
  'com.apple.Home', 'com.apple.findmy', 'com.apple.shortcuts', 'com.apple.DiskUtility', 'com.apple.installer',
  'com.apple.MigrateAssistant', 'com.apple.bootcampassistant', 'com.apple.ScreenSharing',
];
export const RESTRICTED_APP_BUNDLES: readonly string[] = [...SYSTEM_RESTRICTED_BUNDLES, ...DESKTOP_BROWSER_BUNDLES];
export const RESTRICTED_APP_PREFIXES: readonly string[] = [...DESKTOP_WEB_APP_PREFIXES];

const lowerBundles = new Set(RESTRICTED_APP_BUNDLES.map(b => b.toLowerCase()));
const lowerBrowsers = new Set<string>(DESKTOP_BROWSER_BUNDLES.map(b => b.toLowerCase()));
const lowerPrefixes = RESTRICTED_APP_PREFIXES.map(p => p.toLowerCase());

/** Where a press is never made by intent: System Settings, stores, media stores, device and system tools, browsers, web apps. */
export function isRestrictedApp(bundleId: unknown): boolean {
  const id = String(bundleId ?? '').trim().toLowerCase();
  if (!id) return false;
  return lowerBundles.has(id) || lowerPrefixes.some(prefix => id.startsWith(prefix));
}

/** A browser or an installed web app: its web content is dropped from the candidates altogether. */
export function isBrowserApp(bundleId: unknown): boolean {
  const id = String(bundleId ?? '').trim().toLowerCase();
  if (!id) return false;
  return lowerBrowsers.has(id) || lowerPrefixes.some(prefix => id.startsWith(prefix));
}

// --- Classification ---

/** Why a control is not plain navigation, or null when every clause holds. */
function navigationFailure(node: DesktopNode, ctx: DesktopRiskContext): string | null {
  const role = node.role ?? '';
  const plainButton = role === 'AXButton' && !node.subrole;
  if (!(plainButton || role === 'AXLink' || isTab(node) || role === 'AXDisclosureTriangle')) return 'N1 not a plain button, link, tab or disclosure triangle';
  if (node.enabled === false) return 'N2 disabled';
  if (!Array.isArray(node.actions) || !node.actions.includes('press')) return 'N2 has no press action';
  const name = axName(node);
  const normalized = normalizeName(name);
  const letters = normalized.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2 || normalized.length > 80 || mixedConfusableScripts(normalized)) return 'N3 name missing, overlong, or mixing confusable scripts';
  if (MARKUP_RE.test(name)) return 'N3 name carries selector or markup syntax';
  if (addressesAgent(name) || addressesAgent(node.help) || addressesAgent(node.group)) return 'N4 text addresses an automated reader';
  if (!LEXICON_LANGS.has(normalizeLang(ctx.lang))) return 'N5 interface language not covered by the vocabularies';
  return null;
}

/** First match wins; `navigation` has to be earned, everything unrecognised is `unknown`. */
export function explainDesktopTarget(node: DesktopNode, ctx: DesktopRiskContext = {}): DesktopRiskVerdict {
  if (!node || typeof node !== 'object') return { risk: 'unknown', clause: 'D0 not a node' };
  if (isSecure(node)) return { risk: 'authentication', clause: 'D1 password field' };
  const labels = allLabels(node);
  const text = labels.join(' \n ');
  if (CURRENCY_RE.test(text.normalize('NFKC'))) return { risk: 'payment', clause: 'D2 a price next to a currency' };
  const shared = lexiconClass(text);
  if (shared === 'payment' && !isSystemPlace(node, ctx)) return { risk: 'payment', clause: 'D3 payment vocabulary' };
  const term = desktopTermClass(...labels);
  if (term) return { risk: term, clause: `D4 desktop ${term} vocabulary` };
  if (shared && shared !== 'payment') return { risk: shared, clause: `D5 ${shared} vocabulary` };
  const container = lexiconClass(clean(node.group));
  if (container) return { risk: container, clause: `D6 ${container} vocabulary in the container label` };
  if (node.modal === true) return { risk: 'dialog', clause: 'D7 inside a sheet, popover or dialog' };
  if (node.web === true) return { risk: 'web', clause: 'D7 web content' };
  if (isTextRole(node)) return { risk: 'field', clause: 'D8 text field' };
  if (!isTab(node) && (has(TOGGLE_ROLES, node.role) || node.subrole === 'AXSwitch')) return { risk: 'toggle', clause: 'D8 checkbox, radio button or switch' };
  if (has(VALUE_ROLES, node.role)) return { risk: 'value', clause: 'D8 slider, stepper or color well' };
  if (has(MENU_ROLES, node.role)) return { risk: 'menu', clause: 'D8 menu, menu button or pop-up button' };
  if (has(SELECTION_ROLES, node.role)) return { risk: 'selection', clause: 'D8 row or cell' };
  if (isChrome(node)) return { risk: 'window', clause: 'D8 window chrome' };
  if (has(LAUNCH_ROLES, node.role)) return { risk: 'launch', clause: 'D8 dock item' };
  if (isRestrictedApp(ctx.bundleId)) return { risk: 'restricted-app', clause: 'D9 restricted app' };
  const failure = navigationFailure(node, ctx);
  return failure ? { risk: 'unknown', clause: failure } : { risk: 'navigation', clause: 'N1-N5 hold' };
}

export function classifyDesktopTarget(node: DesktopNode, ctx: DesktopRiskContext = {}): DesktopRisk {
  return explainDesktopTarget(node, ctx).risk;
}

/** Tags the compact list shows after a control; risks without one show none. */
export const DESKTOP_RISK_TAGS: Partial<Record<DesktopRisk, string>> = {
  payment: '[payment]', authentication: '[sign-in]', file: '[file]', publish: '[publish]', destructive: '[destructive]',
  write: '[write]', grant: '[permission]', dialog: '[dialog]', web: '[web]',
};

// --- Candidates ---

/** Ranking and caps for the candidate list. Part of the dk1 hash: a different cut is a different experiment. */
export const DESKTOP_CANDIDATE_POLICY = {
  candidates: 24,
  minTokenChars: 3,
  lexWeight: 10,
  modalWeight: 3,
  kindWeights: { button: 2, link: 2, tab: 2, disclosure: 1, menu: 1 } as Record<string, number>,
  disabledPenalty: 2,
  nameChars: 80,
  hintChars: 60,
  groupChars: 60,
  appNameChars: 40,
  intentChars: 120,
} as const;

/** NFKD, marks stripped, lowercased: what ranking compares. */
const rankFold = (value: unknown) => String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ı/g, 'i');

/** Intent words of three or more characters, folded, once each. */
export function intentTokens(intent: unknown): string[] {
  return [...new Set(rankFold(intent).split(/[^\p{L}\p{N}]+/u).filter(t => [...t].length >= DESKTOP_CANDIDATE_POLICY.minTokenChars))];
}

function verifyFacts(node: DesktopNode, pid: number | null): DesktopVerifyFacts {
  return {
    pid, role: trimmed(node.role), subrole: trimmed(node.subrole), title: trimmed(node.title),
    description: trimmed(node.description), help: trimmed(node.help), identifier: trimmed(node.identifier),
  };
}

const textsOf = (node: DesktopNode) => [node.title, node.description, node.titleElement, node.contentLabel, node.help, node.placeholder, node.group];

/**
 * Filter, classify and rank the controls of one snapshot for an intent.
 *
 * Dropped (and counted): password fields, window chrome, web content in a
 * browser or web app, nodes with nothing to invoke, and controls with no
 * letter or digit in their name. Disabled controls stay, marked. What is left
 * is ranked by `lex*10 + modal 3 + kind weight − disabled 2`, cut to 24 (tree
 * order breaks ties), put back in tree order and numbered `c1…cN`.
 */
export function buildDesktopCandidates(snapshot: DesktopSnapshot, options: { intent: string; limit?: number }): DesktopCandidateSet {
  const policy = DESKTOP_CANDIDATE_POLICY;
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes.filter(n => n && typeof n === 'object') : [];
  const app = snapshot?.app ?? {};
  const bundleId = typeof app.bundleId === 'string' && app.bundleId ? app.bundleId : null;
  const lang = normalizeLang(app.lang);
  const pid = typeof app.pid === 'number' && Number.isFinite(app.pid) ? app.pid : null;
  const ctx: DesktopRiskContext = { bundleId, lang };
  const browser = isBrowserApp(bundleId);
  const intent = clip(clean(options.intent), policy.intentChars);
  const tokens = intentTokens(intent);
  const limit = Math.max(1, Math.min(Math.floor(Number(options.limit) || policy.candidates), policy.candidates));

  let agentText = 0;
  for (const node of nodes) if (textsOf(node).some(t => typeof t === 'string' && addressesAgent(t))) agentText++;
  for (const text of Array.isArray(snapshot?.texts) ? snapshot.texts : []) if (typeof text === 'string' && addressesAgent(text)) agentText++;

  const win = snapshot?.window ?? null;
  const dialogOpen = nodes.some(n => n.modal === true) || has(DIALOG_WINDOW_SUBROLES, win?.subrole) || win?.modal === true;

  const counts: DesktopCandidateCounts = { nodes: nodes.length, considered: 0, ranked: 0, notRanked: 0, secure: 0, unnamed: 0, chrome: 0, web: 0, inert: 0 };
  const found: DesktopCandidateEntry[] = [];
  nodes.forEach((node, order) => {
    if (isSecure(node)) { counts.secure++; return; }
    if (isChrome(node)) { counts.chrome++; return; }
    if (node.web === true && browser) { counts.web++; return; }
    if (!Array.isArray(node.actions) || !node.actions.some(a => INVOCABLE_ACTIONS.includes(a))) { counts.inert++; return; }
    const name = axName(node);
    if (!hasAlnum(name)) { counts.unnamed++; return; }
    const verdict = explainDesktopTarget(node, ctx);
    const disabled = node.enabled === false;
    const inDialog = node.modal === true;
    const kind = kindOf(node);
    const help = clean(node.help);
    const group = clean(node.group);
    const candidate: DesktopCandidate = { id: '', role: roleName(node), kind, name: clip(name, policy.nameChars), disabled, inDialog };
    if (help && hasAlnum(help) && normalizeName(help) !== normalizeName(name)) candidate.hint = clip(help, policy.hintChars);
    if (group && hasAlnum(group)) candidate.group = clip(group, policy.groupChars);
    const hay = rankFold(`${name} ${candidate.hint ?? ''} ${candidate.group ?? ''}`);
    const lex = tokens.filter(t => hay.includes(t)).length;
    const weight = lex * policy.lexWeight + (inDialog ? policy.modalWeight : 0) + (policy.kindWeights[kind] ?? 0) - (disabled ? policy.disabledPenalty : 0);
    found.push({
      id: '', ref: String(node.ref ?? ''), candidate, risk: verdict.risk, clause: verdict.clause,
      pressable: verdict.risk === 'navigation' && !disabled, lex, weight, order,
      verify: verifyFacts(node, pid), context: { bundleId, lang, pid }, node,
    });
  });
  counts.considered = found.length;
  const kept = found.length > limit
    ? [...found].sort((a, b) => b.weight - a.weight || a.order - b.order).slice(0, limit).sort((a, b) => a.order - b.order)
    : found;
  kept.forEach((entry, index) => { entry.id = `c${index + 1}`; entry.candidate.id = entry.id; });
  counts.ranked = kept.length;
  counts.notRanked = found.length - kept.length;
  return {
    snapshotId: typeof snapshot?.snapshotId === 'string' ? snapshot.snapshotId : null,
    intent,
    app: { name: clip(clean(app.name) || 'app', policy.appNameChars), lang },
    candidates: kept.map(entry => entry.candidate),
    entries: kept,
    dialogOpen,
    agentText,
    truncated: snapshot?.truncated === true || counts.notRanked > 0,
    counts,
  };
}

/** The per-candidate view the Neural Interface hands to the MCP layer (the Jev-bound fields plus ref, risk, pressability and rank). */
export function candidateViews(set: Pick<DesktopCandidateSet, 'entries'>): DesktopCandidateView[] {
  return set.entries.map(entry => ({ ...entry.candidate, ref: entry.ref, risk: entry.risk, pressable: entry.pressable, weight: entry.weight, lex: entry.lex }));
}

/** Compact-list order: Jev's pick, then its alternatives, then the rest by word overlap, then tree order. */
export function displayOrder<T extends { id: string; lex: number; order?: number }>(entries: T[], pick?: string | null, alternatives: string[] = []): T[] {
  const first = [pick, ...alternatives].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const position = (entry: T, index: number) => (typeof entry.order === 'number' ? entry.order : index);
  const rest = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => !first.includes(entry.id))
    .sort((a, b) => b.entry.lex - a.entry.lex || position(a.entry, a.index) - position(b.entry, b.index)).map(({ entry }) => entry);
  const lead = first.map(id => entries.find(entry => entry.id === id)).filter((entry): entry is T => Boolean(entry));
  return [...lead, ...rest];
}

/**
 * Point of effect, in the Neural Interface: may this stored entry be pressed?
 * Re-derived from the node the server kept, never from a flag that travelled
 * anywhere: the risk must still be `navigation` under the rules loaded now,
 * the control enabled with a press action, and the verify facts must still be
 * the node's own.
 */
export function pressableEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Partial<DesktopCandidateEntry>;
  const node = e.node;
  if (!node || typeof node !== 'object' || typeof e.ref !== 'string' || !/^e\d+$/.test(e.ref) || node.ref !== e.ref) return false;
  if (node.enabled === false || !Array.isArray(node.actions) || !node.actions.includes('press')) return false;
  const context = e.context && typeof e.context === 'object' ? e.context : { bundleId: null, lang: '', pid: null };
  if (explainDesktopTarget(node, { bundleId: context.bundleId, lang: context.lang }).risk !== 'navigation') return false;
  const expected = verifyFacts(node, typeof context.pid === 'number' ? context.pid : null);
  const verify = e.verify as DesktopVerifyFacts | undefined;
  if (!verify || typeof verify !== 'object') return false;
  return (Object.keys(expected) as (keyof DesktopVerifyFacts)[]).every(key => verify[key] === expected[key]);
}

// --- Identity of the rules ---

/**
 * Identity of everything above, for the desktop benchmark basis. The
 * classifier and the candidate cut decide what may be pressed as much as the
 * model and the thresholds do, so a recorded pass stops vouching once a
 * vocabulary, a role table, an app list or the ranking policy changes. The
 * data is hashed; bump DESKTOP_RISK_RULES_VERSION for a change in logic the
 * data cannot show (and for helper labelling changes, which live in Swift).
 */
export const DESKTOP_RISK_RULES_VERSION = 'dk1';
export const DESKTOP_RISK_RULES_HASH = createHash('sha256').update(JSON.stringify([
  DESKTOP_RISK_RULES_VERSION, DESKTOP_TERMS, DESKTOP_EXACT_TERMS, DESKTOP_INTENT_TERMS, TERM_ORDER,
  ROLE_NAMES, SUBROLE_NAMES, TEXT_ROLES, TOGGLE_ROLES, VALUE_ROLES, MENU_ROLES, SELECTION_ROLES, LAUNCH_ROLES, CHROME_ROLES, CHROME_SUBROLES, TAB_SUBROLES,
  DIALOG_WINDOW_SUBROLES, INVOCABLE_ACTIONS, CURRENCY_RE.source, MARKUP_RE.source, SYSTEM_PLACE_NAMES,
  SYSTEM_RESTRICTED_BUNDLES, DESKTOP_BROWSER_BUNDLES, DESKTOP_WEB_APP_PREFIXES, DESKTOP_CANDIDATE_POLICY,
])).digest('hex').slice(0, 12);
