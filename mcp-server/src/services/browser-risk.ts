/**
 * Deterministic risk of acting on a page element, the URL sanitizer, and the
 * target fingerprint.
 *
 * Pure: no DOM, no sqlite, no TypeSafe client. The Neural Interface imports
 * the compiled copy to classify what its collector found, the MCP layer uses
 * it to veto intents, and the browser benchmark runs fixtures through it, so
 * "is this safe to click again" has one definition everywhere.
 *
 * `navigation` is an allow-list verdict. An element earns it only by passing
 * every clause below; anything not positively recognised is `unknown`, and
 * only `navigation` may ever be auto-healed. Jev never sees this module's
 * inputs and cannot influence its output: no page text can talk an element
 * into eligibility.
 */

import { createHash } from 'node:crypto';

export type TargetRisk = 'navigation' | 'form' | 'write' | 'publish' | 'payment' | 'destructive' | 'authentication' | 'file' | 'unknown';

/**
 * What the in-page collector reports about one element. Travels page → Neural
 * Interface (Node) and stops there: it holds raw hrefs and every name source,
 * so it is NEVER serialized to the MCP layer, to Jev, or to a log.
 */
export interface RawTargetFacts {
  tag: string;
  role: string | null;
  inputType: string | null;
  editable: boolean;
  containsEditable: boolean;
  insideForm: boolean;
  isSubmit: boolean;
  disabled: boolean;
  /** aria-pressed / aria-checked / aria-expanded, or a checkbox, radio or switch. */
  toggles: boolean;
  hasPopup: boolean;
  download: boolean;
  ping: boolean;
  target: string;
  /** The document has a <base target> other than _self. */
  baseTarget: boolean;
  /** Names of the write-ish attributes found on the element, from HANDLER_ATTRS. */
  handlerAttrs: string[];
  hrefAttr: string | null;
  hrefRaw: string | null;
  names: { aria: string; labelledby: string; label: string; text: string; alt: string; title: string; placeholder: string };
  /** Primary language subtag of the document, lowercased; '' when the page declares none. */
  lang: string;
  inDraftZone: boolean;
  engagement: boolean;
  /** The element is, or wraps, a password / one-time-code / credential field. */
  credentialField: boolean;
}

/**
 * Neural Interface → MCP. `selector` / `nth` are for showing the agent how to
 * retry, exactly as legacy hints do; they are never sent to Jev and never used
 * by a heal (the server keeps its own copy in the heal context). Fingerprints
 * stay on the server.
 */
export interface AssistCandidate {
  id: string;
  hintIndex: number | null;
  selector?: string;
  nth?: number;
  role: string;
  kind: 'link' | 'button' | 'field' | 'toggle' | 'other';
  inputType?: string;
  name: string;
  group?: string;
  hrefPath?: string;
  disabled: boolean;
  inDialog: boolean;
  risk: TargetRisk;
  healable: boolean;
}

/** Attributes that make an anchor a write, whatever its href says. The collector probes exactly these. */
export const HANDLER_ATTRS = [
  'onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup',
  'data-method', 'data-turbo-method', 'data-remote', 'data-confirm', 'data-turbo-confirm', 'data-action',
  'hx-post', 'hx-put', 'hx-patch', 'hx-delete', 'formaction',
  'wire:click', 'x-on:click', '@click', 'v-on:click', 'ng-click',
] as const;

/** Query keys that page through or filter a view. Any other key makes a link's effect unknowable. */
export const BENIGN_QUERY_KEYS = new Set(['page', 'p', 'tab', 'view', 'sort', 'order', 'lang', 'locale', 'hl', 'q', 'ref', 'source']);
/** Languages the lexicons below cover. A page in any other language cannot be classified `navigation`. */
export const LEXICON_LANGS = new Set(['en', 'pt', 'es', 'de', 'fr', 'it', 'tr', 'ja']);
const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp']);

// --- Text normalisation ---

const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

/** NFKC, zero-width and bidi controls removed, whitespace collapsed, lowercased. Used for display-independent comparison. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/[‘’ʼ]/g, '\'').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** normalizeName plus diacritic folding, so "Déconnexion" and "deconnexion" meet the same lexicon entry. */
function fold(value: unknown): string {
  // Turkish dotless ı has no decomposition, so NFD alone would leave "satın al" unequal to "satin al".
  return normalizeName(value).normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC').replace(/ı/g, 'i').replace(/ß/g, 'ss');
}

/** "d e l e t e" → "delete". Only when every token is a single letter, so ordinary phrases are left alone. */
function despaced(folded: string): string | null {
  return /^(?:\p{L}\s){3,}\p{L}$/u.test(folded) ? folded.replace(/\s/g, '') : null;
}

// --- Lexicons ---

const TERMS: Record<'payment' | 'authentication' | 'file' | 'publish' | 'destructive' | 'write', string[]> = {
  payment: [
    // Everything the server's MONEY_TEXT_RE names, then the general vocabulary of spending.
    'boost', 'boost post', 'turbinar', 'impulsionar', 'promote', 'promote post', 'promover', 'promocionar', 'promouvoir', 'bewerben',
    'advertise', 'anuncie', 'criar anuncio', 'create ad', 'ad manager', 'ads manager', 'gerenciador de anuncios',
    'orcamento', 'orcamento diario', 'daily budget', 'set budget', 'set a budget', 'definir orcamento',
    'add payment', 'payment method', 'forma de pagamento', 'metodo de pagamento', 'spend limit',
    'confirm and pay', 'confirm payment', 'confirm pagamento', 'confirmar and pay', 'confirmar payment', 'confirmar pagamento',
    'buy', 'buy now', 'purchase', 'pay', 'pay now', 'checkout', 'check out', 'place order', 'order now', 'add to cart', 'add to bag', 'cart', 'basket',
    'upgrade', 'donate', 'send tip', 'leave a tip', 'billing', 'payment', 'payments', 'subscribe now', 'start trial', 'start free trial',
    'comprar', 'pagar', 'finalizar compra', 'carrinho', 'assinar', 'doar', 'pagamento',
    'carrito', 'suscribirse', 'donar', 'pago',
    'kaufen', 'jetzt kaufen', 'bezahlen', 'zur kasse', 'warenkorb', 'abonnieren', 'spenden', 'zahlung',
    'acheter', 'payer', 'panier', 'commander', 's\'abonner', 'faire un don', 'paiement',
    'acquista', 'compra', 'paga', 'carrello', 'abbonati', 'dona', 'pagamento',
    'satin al', 'ode', 'sepet', 'odeme',
    '購入', '支払', 'カート', '注文', '課金',
    // Moving money and the billing area, per language. Bare subscription nouns are left out on purpose: payment is
    // tested first, so "Cancelar assinatura" would stop reading as the destructive control it is. A link to such a page is navigation in the DOM's eyes and
    // payment in ours: auto-heal stays away from paid surfaces altogether, as the money guard does.
    'transfer money', 'send money', 'wire transfer', 'withdraw', 'top up', 'add funds', 'renew subscription', 'renew plan', 'pay tuition',
    'transferir', 'transferencia', 'transferencias', 'pix', 'faturamento', 'cobranca', 'fatura', 'faturas', 'assine', 'renovar',
    'facturacion', 'factura', 'facturas', 'tramitar pedido',
    'uberweisen', 'uberweisung', 'abrechnung', 'rechnung', 'rechnungen', 'verlangern',
    'virement', 'facturation', 'facture', 'factures', 'renouveler',
    'bonifico', 'fatturazione', 'fattura', 'fatture', 'rinnova',
    'havale', 'para gonder', 'faturalandirma', 'abone ol',
    '振込', '送金', '請求', '料金',
  ],
  authentication: [
    'log out', 'logout', 'sign out', 'signout', 'log in', 'login', 'sign in', 'signin', 'sign up', 'signup', 'register', 'create account',
    'forgot password', 'reset password', 'verify', 'authenticate', 'continue with google', 'continue with facebook', 'continue with apple',
    'sair', 'entrar', 'encerrar sessao', 'terminar sessao', 'iniciar sessao', 'cadastrar', 'cadastre-se', 'criar conta', 'esqueci a senha',
    'cerrar sesion', 'salir', 'iniciar sesion', 'acceder', 'registrarse', 'crear cuenta',
    'abmelden', 'ausloggen', 'anmelden', 'einloggen', 'registrieren', 'konto erstellen', 'passwort vergessen',
    'deconnexion', 'se deconnecter', 'connexion', 'se connecter', 's\'inscrire', 'creer un compte', 'mot de passe oublie',
    'esci', 'disconnetti', 'accedi', 'registrati', 'crea account',
    'cikis', 'cıkıs', 'oturumu kapat', 'giris', 'giris yap', 'kaydol', 'kayit ol',
    'ログアウト', 'ログイン', 'サインアウト', 'サインイン', '登録', '新規登録',
  ],
  file: [
    'upload', 'attach', 'attachment', 'import', 'choose file', 'browse files', 'download', 'export',
    'enviar arquivo', 'anexar', 'importar', 'baixar', 'exportar', 'carregar arquivo',
    'subir archivo', 'adjuntar', 'descargar',
    'hochladen', 'anhangen', 'importieren', 'herunterladen', 'exportieren',
    'televerser', 'joindre', 'importer', 'telecharger', 'exporter',
    'carica', 'allega', 'scarica', 'esporta',
    'yukle', 'indir', 'ice aktar', 'disa aktar',
    'アップロード', 'ダウンロード', '添付', 'インポート', 'エクスポート',
  ],
  publish: [
    'publish', 'post', 'send', 'share', 'tweet', 'reply', 'comment', 'repost', 'retweet', 'like', 'unlike', 'follow', 'unfollow', 'invite',
    'approve', 'accept', 'confirm', 'vote', 'rsvp', 'join', 'message', 'react', 'submit', 'submit for approval', 'send for approval',
    'publicar', 'postar', 'enviar', 'compartilhar', 'comentar', 'responder', 'curtir', 'seguir', 'aprovar', 'aceitar', 'confirmar', 'participar', 'convidar',
    'compartir', 'me gusta', 'aprobar', 'aceptar', 'unirse', 'invitar',
    'veroffentlichen', 'posten', 'senden', 'an gruppe senden', 'zur genehmigung senden', 'zur bestatigung senden', 'teilen', 'kommentieren', 'antworten',
    'gefallt mir', 'folgen', 'genehmigen', 'akzeptieren', 'bestatigen', 'beitreten', 'einladen', 'absenden',
    'publier', 'envoyer', 'partager', 'commenter', 'repondre', 'j\'aime', 'suivre', 'approuver', 'accepter', 'confirmer', 'rejoindre', 'inviter',
    'pubblica', 'pubblicare', 'invia', 'condividi', 'commenta', 'rispondi', 'mi piace', 'segui', 'approva', 'accetta', 'conferma', 'partecipa',
    'paylas', 'gonder', 'yanitla', 'begen', 'takip et', 'onayla', 'katil', 'davet et',
    '投稿', '送信', '共有', '返信', 'いいね', 'フォロー', '承認', '参加', 'opublikuj', 'wyslij', 'udostepnij',
  ],
  destructive: [
    'delete', 'remove', 'erase', 'discard', 'destroy', 'clear all', 'clear history', 'reset', 'revoke', 'deactivate', 'close account', 'delete account',
    'cancel subscription', 'cancel order', 'unsubscribe', 'block', 'ban', 'leave group', 'leave', 'archive', 'trash', 'empty trash', 'disconnect', 'uninstall',
    'excluir', 'apagar', 'remover', 'deletar', 'descartar', 'desativar', 'cancelar assinatura', 'sair do grupo', 'bloquear', 'redefinir', 'arquivar', 'lixeira',
    'eliminar', 'borrar', 'quitar', 'desactivar', 'cancelar suscripcion', 'salir del grupo', 'restablecer', 'archivar', 'papelera',
    'loschen', 'entfernen', 'verwerfen', 'deaktivieren', 'kundigen', 'blockieren', 'zurucksetzen', 'abbestellen', 'konto loschen', 'gruppe verlassen', 'archivieren', 'papierkorb',
    'supprimer', 'effacer', 'retirer', 'desactiver', 'resilier', 'bloquer', 'se desabonner', 'reinitialiser', 'quitter le groupe', 'archiver', 'corbeille',
    'elimina', 'cancella', 'rimuovi', 'disattiva', 'blocca', 'annulla iscrizione', 'reimposta', 'archivia', 'cestino',
    'sil', 'kaldir', 'engelle', 'iptal et', 'sifirla', 'gruptan ayril', 'arsivle',
    '削除', '消去', '解除', 'ブロック', '退会', 'リセット', 'ゴミ箱', 'usun',
  ],
  write: [
    // Deliberately no bare "new", "move" or "book": they are adjectives and nouns far more often
    // than verbs ("What's new", "?sort=new", "Address book"), and a non-anchor is `unknown` anyway.
    'save', 'save changes', 'apply', 'update', 'add', 'create', 'create new', 'edit', 'rename', 'move to', 'duplicate', 'enable', 'disable', 'turn on', 'turn off',
    'subscribe', 'mark as read', 'mark as', 'pin', 'unpin', 'mute', 'unmute', 'hide', 'report', 'flag', 'book now', 'reserve', 'schedule', 'assign', 'merge',
    'salvar', 'aplicar', 'atualizar', 'adicionar', 'criar', 'editar', 'renomear', 'ativar', 'denunciar', 'agendar',
    'guardar', 'actualizar', 'anadir', 'agregar', 'crear', 'renombrar', 'activar', 'reportar', 'programar',
    'speichern', 'anwenden', 'aktualisieren', 'hinzufugen', 'erstellen', 'bearbeiten', 'umbenennen', 'aktivieren', 'melden', 'planen',
    'enregistrer', 'appliquer', 'mettre a jour', 'ajouter', 'creer', 'modifier', 'renommer', 'activer', 'signaler', 'planifier',
    'salva', 'applica', 'aggiorna', 'aggiungi', 'crea', 'modifica', 'rinomina', 'attiva', 'segnala',
    'kaydet', 'uygula', 'guncelle', 'ekle', 'olustur', 'duzenle', 'etkinlestir', 'bildir',
    '保存', '適用', '更新', '追加', '作成', '編集', '有効', '無効', '報告',
  ],
};

/** Path-only vocabulary: API-ish and action-ish segments a label lexicon would never see. */
const PATH_TERMS = ['oauth', 'oauth2', 'sso', 'auth', 'saml', 'api', 'action', 'actions', 'do', 'cmd', 'rpc', 'graphql', 'webhook', 'callback', 'redirect', 'redir', 'goto', 'out', 'exit', 'track', 'click'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isCjk = (s: string) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(s);

function lexicon(terms: string[]): RegExp {
  const folded = [...new Set(terms.map(fold).filter(Boolean))].sort((a, b) => b.length - a.length);
  const cjk = folded.filter(isCjk).map(escapeRe);
  // Up to two filler words may sit inside a multi-word term: "cancel my subscription", "close this account",
  // "Konto jetzt löschen", "turn notifications off". People and interfaces both write them that way.
  const words = folded.filter(t => !isCjk(t)).map(t => escapeRe(t).replace(/ /g, "(?:\\s+[\\p{L}\\p{N}']+){0,2}\\s+"));
  const parts: string[] = [];
  if (words.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`);
  if (cjk.length) parts.push(`(?:${cjk.join('|')})`);
  return new RegExp(parts.join('|'), 'u');
}

export const PAYMENT_RE = lexicon(TERMS.payment);
export const AUTH_RE = lexicon(TERMS.authentication);
export const FILE_RE = lexicon(TERMS.file);
export const PUBLISH_RE = lexicon(TERMS.publish);
export const DESTRUCTIVE_RE = lexicon(TERMS.destructive);
export const WRITE_RE = lexicon(TERMS.write);
const PATH_RE = lexicon(PATH_TERMS);
/** Anything that is not plain navigation. */
export const DANGER_RE = lexicon([...TERMS.authentication, ...TERMS.file, ...TERMS.publish, ...TERMS.destructive, ...TERMS.write]);

function hits(re: RegExp, text: string): boolean {
  const folded = fold(text);
  if (!folded) return false;
  if (re.test(folded)) return true;
  const joined = despaced(folded);
  return joined ? re.test(joined) : false;
}

/** Does this text name something other than plain navigation? Used for labels, intents and selectors alike. */
export function lexiconClass(text: string): Exclude<TargetRisk, 'navigation' | 'form' | 'unknown'> | null {
  if (hits(PAYMENT_RE, text)) return 'payment';
  if (hits(AUTH_RE, text)) return 'authentication';
  if (hits(FILE_RE, text)) return 'file';
  if (hits(PUBLISH_RE, text)) return 'publish';
  if (hits(DESTRUCTIVE_RE, text)) return 'destructive';
  if (hits(WRITE_RE, text)) return 'write';
  return null;
}

// --- URLs ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long opaque strings: session ids, magic-link tokens, JWT heads. */
export function isTokenLike(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('eyJ') && value.length >= 16) return true;
  return value.length >= 24 && /^[A-Za-z0-9_\-+=.~%]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

function redactSegment(raw: string): string {
  let segment = raw.split(';')[0];
  try { segment = decodeURIComponent(segment); } catch { /* keep the encoded form */ }
  if (!segment) return '';
  if (segment.includes('@')) return ':email';
  if (UUID_RE.test(segment) || /^[0-9a-f]{12,}$/i.test(segment) || /^\d{6,}$/.test(segment)) return ':id';
  if (isTokenLike(segment)) return ':token';
  // Mixed letters-and-digits handles (video ids, short links) identify a thing, not a place.
  // "iphone-15-pro" and "browser-v2" are words with a number in them and stay.
  if (/^[A-Za-z0-9_-]{10,}$/.test(segment) && /[A-Za-z]/.test(segment)) {
    const digits = segment.match(/\d/g)?.length ?? 0;
    const mixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
    if ((digits >= 2 && mixedCase) || (digits >= 3 && !/[-_]/.test(segment))) return ':id';
  }
  return segment.slice(0, 40);
}

export interface SanitizedUrl { scheme: string; origin: string; path: string }

/**
 * What may leave the machine about a URL: scheme, host and a redacted path.
 * Never userinfo, query, fragment or matrix parameters. Non-http(s) schemes
 * keep only the scheme: file:, data: and blob: carry paths or content.
 */
export function sanitizeUrl(raw: unknown, base?: string): SanitizedUrl {
  let url: URL;
  try { url = new URL(String(raw ?? ''), base); } catch { return { scheme: '', origin: '', path: '' }; }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https') return { scheme, origin: '', path: '' };
  const host = url.hostname.split('.').map(label => (isTokenLike(label) || /^[0-9a-f]{16,}$/i.test(label) ? ':token' : label)).join('.');
  const port = url.port ? `:${url.port}` : '';
  const segments = url.pathname.split('/').filter(Boolean).slice(0, 6).map(redactSegment).filter(Boolean);
  return { scheme, origin: `${scheme}://${host}${port}`, path: `/${segments.join('/')}`.slice(0, 120) };
}

// --- Names ---

/** The name a person would read, in accessible-name priority order. */
export function bestName(facts: Pick<RawTargetFacts, 'names'>): string {
  const n = facts.names;
  return (n.aria || n.labelledby || n.label || n.text || n.alt || n.title || n.placeholder || '').replace(/\s+/g, ' ').trim();
}

const allNames = (facts: RawTargetFacts) => Object.values(facts.names).filter(Boolean).join(' \n ');

export function candidateKind(facts: Pick<RawTargetFacts, 'tag' | 'role' | 'editable' | 'toggles' | 'inputType'>): AssistCandidate['kind'] {
  if (facts.toggles) return 'toggle';
  if (facts.editable) return 'field';
  if (facts.tag === 'a' || facts.role === 'link') return 'link';
  if (facts.tag === 'button' || facts.role === 'button' || facts.role === 'tab' || facts.role === 'menuitem' || (facts.tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(facts.inputType ?? ''))) return 'button';
  return 'other';
}

/** Latin text mixed with Cyrillic or Greek is the homoglyph pattern ("Dеlete" with a Cyrillic е). CJK beside Latin is ordinary. */
function mixedConfusableScripts(text: string): boolean {
  return /\p{Script=Latin}/u.test(text) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(text);
}

// --- Classification ---

export interface RiskContext { pageUrl: string }
export interface RiskVerdict { risk: TargetRisk; clause: string }

/** Why an anchor is not plain navigation, or null when every clause holds. */
function navigationFailure(facts: RawTargetFacts, ctx: RiskContext): string | null {
  if (facts.tag !== 'a' || !facts.hrefAttr || !facts.hrefRaw || (facts.role !== null && facts.role !== 'link')) return 'N1 not a plain anchor with an href';
  if (facts.editable || facts.containsEditable || facts.insideForm || facts.isSubmit || facts.disabled) return 'N2 editable, inside a form, a submit control, or disabled';
  if (facts.download || facts.ping || (facts.target !== '' && facts.target !== '_self') || facts.baseTarget) return 'N3 download, ping, or a target other than the current tab';
  if (facts.handlerAttrs.length || facts.hasPopup || facts.toggles) return 'N4 carries a handler attribute, opens a popup, or toggles state';
  let href: URL;
  let page: URL;
  try { href = new URL(facts.hrefRaw); page = new URL(ctx.pageUrl); } catch { return 'N5 unparsable URL'; }
  if ((href.protocol !== 'http:' && href.protocol !== 'https:') || href.username || href.password) return 'N5 not http(s), or carries userinfo';
  if (href.origin !== page.origin) return 'N5 leaves the current origin';
  const attr = facts.hrefAttr.trim();
  if (!attr || attr.startsWith('#') || (href.pathname === page.pathname && href.search === page.search)) return 'N6 same-document link';
  for (const [key, value] of href.searchParams) {
    const k = key.toLowerCase();
    if (!BENIGN_QUERY_KEYS.has(k) && !k.startsWith('utm_')) return 'N7 query key outside the benign set';
    if (value.length > 64 || isTokenLike(value)) return 'N7 long or token-like query value';
  }
  const segments = href.pathname.split('/').filter(Boolean);
  if (segments.length > 8) return 'N8 path deeper than eight segments';
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(segments[segments.length - 1] ?? '')?.[1]?.toLowerCase() ?? '';
  if (!PAGE_EXTENSIONS.has(extension)) return 'N8 href points at a file';
  for (const segment of segments) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep */ }
    if (isTokenLike(decoded) && !UUID_RE.test(decoded)) return 'N8 opaque token in the path';
  }
  const pathWords = decodeSafe(href.pathname).replace(/[/_.\-+]+/g, ' ');
  const queryWords = [...href.searchParams].map(([k, v]) => `${k} ${v}`).join(' ').replace(/[/_.\-+]+/g, ' ');
  const name = bestName(facts);
  const normalized = normalizeName(name);
  const letters = normalized.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2 || normalized.length > 80 || mixedConfusableScripts(normalized)) return 'N9 name missing, overlong, or mixing confusable scripts';
  // A label that reads like a selector or markup is written for a tool, not for a person.
  if (/>>|["\][{}<>`\\]|\b(?:css|xpath|text|role)\s*=/i.test(name)) return 'N9 name carries selector or markup syntax';
  // A label written for an automated reader is bait, whatever it links to.
  if (addressesAgent(name)) return 'N9 name addresses an automated reader';
  if (!LEXICON_LANGS.has(facts.lang)) return 'N9 page language not covered by the lexicon';
  const union = `${allNames(facts)} \n ${pathWords} \n ${queryWords}`;
  if (lexiconClass(union) || hits(PATH_RE, pathWords)) return 'N10 name, path or query names an action';
  if (facts.engagement || facts.inDraftZone) return 'N11 engagement control, or inside a draft zone';
  return null;
}

function decodeSafe(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }

/** First match wins; `navigation` has to be earned, everything unrecognised is `unknown`. */
export function explainTargetRisk(facts: RawTargetFacts, ctx: RiskContext): RiskVerdict {
  const names = allNames(facts);
  const url = facts.hrefRaw ? (() => { try { return new URL(facts.hrefRaw!); } catch { return null; } })() : null;
  const pathAndQuery = url ? `${decodeSafe(url.pathname)} ${decodeSafe(url.search)}`.replace(/[/_.\-+?&=]+/g, ' ') : '';
  if (hits(PAYMENT_RE, names) || hits(PAYMENT_RE, pathAndQuery)) return { risk: 'payment', clause: 'payment vocabulary in a name or the href' };
  if (facts.credentialField || hits(AUTH_RE, names) || hits(AUTH_RE, pathAndQuery)) return { risk: 'authentication', clause: 'credential field or sign-in vocabulary' };
  if (facts.inputType === 'file' || facts.download || hits(FILE_RE, names)) return { risk: 'file', clause: 'file input, download attribute or file vocabulary' };
  if (facts.engagement || hits(PUBLISH_RE, names)) return { risk: 'publish', clause: 'engagement control or publishing vocabulary' };
  if (hits(DESTRUCTIVE_RE, names) || hits(DESTRUCTIVE_RE, pathAndQuery)) return { risk: 'destructive', clause: 'destructive vocabulary in a name or the href' };
  if (facts.editable || facts.toggles || hits(WRITE_RE, names)) return { risk: 'write', clause: 'editable, toggle, or write vocabulary' };
  if (facts.insideForm || facts.isSubmit) return { risk: 'form', clause: 'inside a form or a submit control' };
  const failure = navigationFailure(facts, ctx);
  return failure ? { risk: 'unknown', clause: failure } : { risk: 'navigation', clause: 'N1-N11 hold' };
}

export function classifyTargetRisk(facts: RawTargetFacts, ctx: RiskContext): TargetRisk {
  return explainTargetRisk(facts, ctx).risk;
}

/** The only elements one auto-heal click may ever touch. */
export function isHealable(facts: RawTargetFacts, ctx: RiskContext): boolean {
  return !facts.disabled && classifyTargetRisk(facts, ctx) === 'navigation';
}

/**
 * Identity of a target across the gap between recommending and clicking.
 * Covers the full href (query included, hashed so it is not recoverable), so
 * `?id=1` swapped for `?id=2&action=delete` is a different target. No values,
 * no position: a rect or an index is not what makes an element the same one.
 */
export function fingerprintTarget(facts: RawTargetFacts): string {
  const href = createHash('sha256').update(facts.hrefRaw ?? '').digest('hex');
  return createHash('sha256').update(JSON.stringify(['v1', facts.tag, facts.role, normalizeName(bestName(facts)), href, facts.inputType, facts.insideForm, facts.isSubmit])).digest('hex');
}

// --- Pages that talk to the agent ---

const AGENT_ADDRESS_RE = new RegExp([
  String.raw`\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:task|instructions?|prompt|previous|above|rules?)\b`,
  String.raw`\b(?:ai|llm|gpt|claude|assistant|agents?|bots?|crawlers?|language models?|automation)\b[^.]{0,60}\b(?:click|choose|select|pick|press|tap|must|should|answer)\b`,
  String.raw`\b(?:click|choose|select|pick|press)\s+(?:me|this|here)\b[^.]{0,40}\b(?:to continue|instead|now|first)\b`,
  String.raw`\b(?:system|assistant|developer)\s*(?:prompt|message|note)?\s*:`,
  String.raw`\bas an ai\b|\byou are (?:an? )?(?:ai|assistant|agent|language model)\b`,
  // The text is folded before it is tested (lowercase, no diacritics), so the patterns are written that way.
  String.raw`\bignor\w*\b[^.]{0,40}\b(?:tarefa|instruc\w+|instrucoes|aufgabe\w*|anweisung\w*|tache|consignes?|tarea|compito|istruzion\w+|gorev\w*|talimat\w*)\b`,
  String.raw`\b(?:ia|ki|agentes?|asistentes?|assistentes?|ki-assistent\w*|assistent\w*|robots?|yapay zeka)\b[^.]{0,60}\b(?:cliqu\w+|clic|pulsa\w*|klick\w*|wahle\w*|selecion\w+|seleccion\w+|escolh\w+|elige\w*|choisi\w+|scegli\w*|tikla\w*)\b`,
  String.raw`(?:指示|命令|タスク)[^。]{0,12}(?:無視|従わ)|(?:ai|エージェント|アシスタント)[^。]{0,20}(?:クリック|選択|押し)`,
].join('|'), 'iu');

/**
 * Identity of the rules above, for the benchmark basis. The classifier decides
 * what may be healed just as much as the model and the thresholds do, so a
 * recorded pass must stop vouching once a lexicon, a path term, a benign query
 * key or the agent-address pattern changes. The data is hashed; bump
 * RISK_RULES_VERSION for a change in logic that the data cannot show.
 */
export const RISK_RULES_VERSION = 'rk1';
export const RISK_RULES_HASH = createHash('sha256').update(JSON.stringify([
  RISK_RULES_VERSION, TERMS, PATH_TERMS, [...BENIGN_QUERY_KEYS].sort(), [...HANDLER_ATTRS], [...LEXICON_LANGS].sort(), [...PAGE_EXTENSIONS].sort(), AGENT_ADDRESS_RE.source,
])).digest('hex').slice(0, 12);

/**
 * Does this text address an automated reader rather than a person? A page that
 * carries such a control is adversarial ground: whatever Jev concludes there,
 * nothing on it is acted on without a person asking again.
 */
export function addressesAgent(text: unknown): boolean {
  const folded = fold(text);
  return folded.length >= 8 && AGENT_ADDRESS_RE.test(folded);
}

// --- Intent (MCP side) ---

export interface TargetPhrase { phrase: string; source: 'textHint' | 'selector-text' | 'selector-generic' }

/**
 * What the caller was trying to reach. An explicit textHint wins; otherwise
 * only text-semantic selector forms count. The generic quoted-string fallback
 * is kept for ranking but flagged, because it turns `[data-testid="tweetButton"]`
 * into the intent "tweetButton" — good enough to sort hints, never to act on.
 */
export function extractTargetPhrase(selector: string | undefined | null, textHint?: string | null): TargetPhrase | null {
  const hint = String(textHint ?? '').replace(/\s+/g, ' ').trim();
  if (hint.length >= 2) return { phrase: hint.slice(0, 120), source: 'textHint' };
  const sel = String(selector ?? '');
  const semantic = /(?::has-text|:text|:text-is|:text-matches)\(\s*["']([^"']{2,80})["']/i.exec(sel)
    || /(?:^|>>\s*)text\s*=\s*["']?([^"'>]{2,80})["']?/i.exec(sel)
    || /\[\s*name\s*[~*^$|]?=\s*["']([^"']{2,80})["']/i.exec(sel)
    || /\[\s*aria-label\s*[~*^$|]?=\s*["']([^"']{2,80})["']/i.exec(sel)
    || /\[\s*(?:title|placeholder|alt)\s*[~*^$|]?=\s*["']([^"']{2,80})["']/i.exec(sel);
  if (semantic) return { phrase: semantic[1].replace(/\s+/g, ' ').trim().slice(0, 120), source: 'selector-text' };
  const generic = /["']([^"']{3,80})["']/.exec(sel);
  return generic ? { phrase: generic[1].replace(/\s+/g, ' ').trim().slice(0, 120), source: 'selector-generic' } : null;
}

/**
 * Reasons an intent may be advised on but never healed: it names an action,
 * it aims at an editable, its selector is scoped (page-wide healing would
 * silently drop the scope), or the phrase is a guess.
 */
export function intentVeto(phrase: TargetPhrase | null, selector: string | undefined | null): string | null {
  if (!phrase) return 'no target phrase';
  if (phrase.source === 'selector-generic') return 'target phrase is a guess from a quoted selector fragment';
  const named = lexiconClass(`${phrase.phrase} \n ${String(selector ?? '').replace(/[[\]="'():>~+.#_-]+/g, ' ')}`);
  if (named) return `intent names a ${named} action`;
  const sel = String(selector ?? '');
  if (/>>/.test(sel)) return 'selector is scoped with >>';
  // `text=Help center` is one Playwright text selector: the space belongs to the text, it is not a descendant combinator.
  const bare = /^text=/i.test(sel.trim()) ? '' : sel.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'|\([^)]*\)/g, '');
  if (/[^\s>+~]\s*[>+~]\s*[^\s>+~]|\S\s+\S/.test(bare.trim())) return 'selector is scoped with a combinator';
  const leaf = bare.trim().split(/\s+/).pop() ?? '';
  if (/^(?:input|textarea|select)\b/i.test(leaf) || /contenteditable|\[type\s*=/i.test(sel) || /^role=(?:textbox|combobox|searchbox|checkbox|radio|switch|slider|spinbutton)\b/i.test(sel.trim())) return 'selector targets an editable or a toggle';
  return null;
}
