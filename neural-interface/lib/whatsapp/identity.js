// Who is who on the WhatsApp side: JID parsing, the owner, the claim code and
// the one decision that matters most — whether an incoming message is the
// owner talking to SynaBun. Pure (no runtime import), so the host core and the
// tests share one definition.
//
// Identity is an ACCOUNT: same server kind AND same user. Baileys'
// areJidsSameUser compares users only, which would make 123@lid equal to
// 123@s.whatsapp.net — two different accounts. sameAccount never does.

import { randomInt, timingSafeEqual } from 'node:crypto';
import { maskNumber } from './redact.js';

const KIND_BY_SERVER = Object.freeze({
  's.whatsapp.net': 'pn',
  lid: 'lid',
  'g.us': 'group',
  broadcast: 'broadcast',
  newsletter: 'newsletter',
  hosted: 'hosted',
  'hosted.lid': 'hosted_lid',
  bot: 'bot',
  call: 'call',
});

const ACCOUNT_KINDS = new Set(['pn', 'lid']);

/**
 * Baileys' jidDecode, plus c.us → s.whatsapp.net and validation.
 * @returns {{user:string, server:string, kind:string, agent:number|undefined, device:number|undefined} | null}
 */
export function parseJid(jid) {
  if (typeof jid !== 'string') return null;
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) return null;
  let server = jid.slice(sepIdx + 1);
  const userCombined = jid.slice(0, sepIdx);
  const [userAgent, device] = userCombined.split(':');
  const [user, agent] = userAgent.split('_');
  if (server === 'c.us') server = 's.whatsapp.net';
  if (!user || !server) return null;
  const kind = KIND_BY_SERVER[server] || 'other';
  const deviceNum = device ? Number(device) : undefined;
  if (device !== undefined && !(Number.isInteger(deviceNum) && deviceNum >= 0)) return null;
  const agentNum = agent ? Number(agent) : undefined;
  if (agent !== undefined && !(Number.isInteger(agentNum) && agentNum >= 0)) return null;
  if (ACCOUNT_KINDS.has(kind) && !/^\d{1,24}$/.test(user)) return null;
  return { user, server, kind, agent: agentNum, device: deviceNum };
}

/** `user@server` without device or agent; null when the JID is malformed. */
export function normalizeUserJid(jid) {
  const p = parseJid(jid);
  return p ? `${p.user}@${p.server}` : null;
}

export function isAccountJid(jid) {
  const p = parseJid(jid);
  return !!p && ACCOUNT_KINDS.has(p.kind);
}

/** Same server kind AND same user, and both are user accounts (PN or LID). */
export function sameAccount(a, b) {
  const pa = parseJid(a);
  const pb = parseJid(b);
  if (!pa || !pb) return false;
  if (!ACCOUNT_KINDS.has(pa.kind) || pa.kind !== pb.kind) return false;
  return pa.user === pb.user;
}

/** Display form of an account: phone numbers keep at most four digits, LIDs two. */
export function maskJid(jid) {
  const p = parseJid(jid);
  if (!p) return '••••';
  if (p.kind === 'pn') return maskNumber(p.user);
  if (p.kind === 'lid') return `linked id ••${p.user.slice(-2)}`;
  return '••••';
}

/**
 * The owner as the host sees it.
 *   self       the linked account itself: {pn: normalized creds.me.id, lid: creds.me.lid}
 *   dedicated  the account bound by a claim code: {pn, lid}; an alternate id is
 *              learned only when the other id of the same message already matches.
 */
export function createOwnerState({ mode = 'self', self = null, bound = null } = {}) {
  const st = { mode, pn: null, lid: null, via: null, boundAt: null, lastChat: null };

  function assign({ pn = null, lid = null } = {}) {
    const npn = pn ? normalizeUserJid(pn) : null;
    const nlid = lid ? normalizeUserJid(lid) : null;
    st.pn = npn && parseJid(npn).kind === 'pn' ? npn : null;
    st.lid = nlid && parseJid(nlid).kind === 'lid' ? nlid : null;
    if (st.lastChat && !isOwnerJid(st.lastChat)) st.lastChat = null;
  }

  function isOwnerJid(jid) {
    if (!jid) return false;
    return (!!st.pn && sameAccount(jid, st.pn)) || (!!st.lid && sameAccount(jid, st.lid));
  }

  /** The id slot this JID would fill ('pn' | 'lid'), or null. */
  function slotOf(jid) {
    const p = parseJid(jid);
    return p && ACCOUNT_KINDS.has(p.kind) ? p.kind : null;
  }

  if (mode === 'self' && self) assign(self);
  if (mode === 'dedicated' && bound) {
    assign(bound);
    st.via = bound.via || 'claim';
    st.boundAt = bound.boundAt ?? bound.bound_at ?? null;
  }

  return {
    get mode() { return st.mode; },
    get pn() { return st.pn; },
    get lid() { return st.lid; },
    get bound() { return !!(st.pn || st.lid); },
    get via() { return st.via; },
    get boundAt() { return st.boundAt; },
    isOwnerJid,
    /** Whether `jid` may name the owner: it matches, or its slot is still empty. */
    slotFree(jid) {
      const slot = slotOf(jid);
      return !!slot && !st[slot];
    },
    /** Self mode: refresh from creds.me (the LID arrives after the first login). */
    setSelf({ pn = null, lid = null } = {}) {
      if (st.mode !== 'self') return;
      assign({ pn, lid });
    },
    /** Dedicated mode: bind the claimant. */
    bind({ pn = null, lid = null, via = 'claim', boundAt = Date.now() } = {}) {
      st.mode = 'dedicated';
      assign({ pn, lid });
      st.via = via;
      st.boundAt = boundAt;
      st.lastChat = null;
    },
    /**
     * Learn the other id of the same account, only when one side already
     * matches and the other side's slot is empty. Never overwrites.
     * @returns {'pn'|'lid'|null} the slot learned
     */
    learnAlternate(a, b) {
      for (const [known, other] of [[a, b], [b, a]]) {
        if (!known || !other || !isOwnerJid(known) || isOwnerJid(other)) continue;
        const slot = slotOf(other);
        if (!slot || st[slot]) continue;
        st[slot] = normalizeUserJid(other);
        return slot;
      }
      return null;
    },
    /** Remember which of the owner's ids the conversation uses, to reply there. */
    noteChat(jid) {
      if (isOwnerJid(jid)) st.lastChat = normalizeUserJid(jid);
    },
    replyJid() {
      return st.lastChat || st.pn || st.lid || null;
    },
    clear() {
      st.pn = null;
      st.lid = null;
      st.via = null;
      st.boundAt = null;
      st.lastChat = null;
    },
    snapshot() {
      return { pn: st.pn, lid: st.lid, via: st.via, boundAt: st.boundAt };
    },
    masked() {
      if (st.pn) return maskJid(st.pn);
      if (st.lid) return maskJid(st.lid);
      return null;
    },
  };
}

function textAfterPrefix(text, prefix) {
  if (typeof text !== 'string' || !prefix) return null;
  const trimmed = text.replace(/^\s+/, '');
  if (trimmed.length < prefix.length) return null;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  const rest = trimmed.slice(prefix.length);
  if (rest && !/^[\s:,.-]/.test(rest)) return null; // "sbrown" is not "sb"
  return rest.replace(/^[\s:,.-]+/, '');
}

/**
 * Accept or drop one incoming message (content filtering happens before).
 *
 * @param {object} msg       a Baileys WAMessage ({key, message, ...})
 * @param {object} owner     createOwnerState()
 * @param {{mode:'self'|'dedicated', sentIds?:{has(id):boolean}, prefix?:string|null,
 *          stanza?:{from:string|null, alt:string|null, device:number}|null, text?:string}} opts
 *   stanza  what the raw <message> stanza said about its sender (host-core taps
 *           the socket); a message no real stanza announced is never accepted.
 *   prefix  self mode: only messages starting with it (case-insensitive) are for SynaBun.
 * @returns {{accept:true, chat:'self'|'dm', text:string|undefined} | {accept:false, reason:string}}
 */
export function classifyInbound(msg, owner, { mode, sentIds = null, prefix = null, stanza = null, text } = {}) {
  const key = msg?.key;
  if (!key || typeof key.id !== 'string' || !key.id) return { accept: false, reason: 'malformed' };
  const chat = parseJid(key.remoteJid);
  if (!chat) return { accept: false, reason: 'malformed' };
  if (chat.kind === 'group') return { accept: false, reason: 'group' };
  if (chat.kind === 'newsletter') return { accept: false, reason: 'newsletter' };
  if (chat.kind === 'broadcast') return { accept: false, reason: key.remoteJid.startsWith('status@') ? 'status' : 'broadcast' };
  if (!ACCOUNT_KINDS.has(chat.kind)) return { accept: false, reason: 'unsupported_chat' };
  if (sentIds?.has?.(key.id)) return { accept: false, reason: 'own_echo' };
  if (!owner?.bound) return { accept: false, reason: 'no_owner' };
  const noStanza = !stanza || !stanza.from;

  if (mode === 'self') {
    if (key.fromMe !== true) return { accept: false, reason: 'not_owner' };
    if (!owner.isOwnerJid(key.remoteJid)) return { accept: false, reason: 'own_other_chat' };
    if (noStanza) return { accept: false, reason: 'stanza_unknown' };
    if (!owner.isOwnerJid(stanza.from)) return { accept: false, reason: 'stanza_mismatch' };
    if (stanza.device !== 0) return { accept: false, reason: 'companion_device' };
    let body = text;
    if (prefix) {
      body = textAfterPrefix(text, prefix);
      if (body === null) return { accept: false, reason: 'no_prefix' };
    }
    return { accept: true, chat: 'self', text: body };
  }

  if (mode === 'dedicated') {
    if (key.fromMe === true) return { accept: false, reason: 'own_message' };
    const alt = key.remoteJidAlt || null;
    const direct = owner.isOwnerJid(key.remoteJid);
    const viaAlt = !direct && !!alt && owner.isOwnerJid(alt);
    if (!direct && !viaAlt) return { accept: false, reason: 'not_owner' };
    // Matched through the alternate id: the chat id must be the owner's own
    // (still unknown) slot, never an id already bound to somebody else.
    if (viaAlt && !owner.slotFree(key.remoteJid)) return { accept: false, reason: 'owner_conflict' };
    if (noStanza) return { accept: false, reason: 'stanza_unknown' };
    // The stanza must say the same: sent by the owner, or by this chat's
    // account while the server vouches (sender_pn/sender_lid) for the owner.
    const stanzaMatches = owner.isOwnerJid(stanza.from)
      || (!!stanza.alt && owner.isOwnerJid(stanza.alt) && sameAccount(stanza.from, key.remoteJid));
    if (!stanzaMatches) return { accept: false, reason: 'stanza_mismatch' };
    return { accept: true, chat: 'dm', text };
  }

  return { accept: false, reason: 'no_mode' };
}

const CLAIM_SHAPE = /^SB-\d{6}$/;

/**
 * One-time code that binds the owner in dedicated mode: `SB-` + 6 digits,
 * 10 minutes, 5 wrong attempts. Only code-shaped texts count as attempts, so
 * strangers saying "hi" cannot burn them.
 */
export function createClaim({ now = Date.now, ttlMs = 10 * 60_000, attempts = 5, rng = randomInt } = {}) {
  const code = `SB-${String(rng(0, 1_000_000)).padStart(6, '0')}`;
  const expiresAt = now() + Math.max(1000, Math.min(ttlMs, 60 * 60_000));
  let attemptsLeft = attempts;
  let done = false;

  return {
    code,
    expiresAt,
    get attemptsLeft() { return attemptsLeft; },
    get active() { return !done && attemptsLeft > 0 && now() < expiresAt; },
    /** @returns {'match'|'mismatch'|'exhausted'|'expired'|'ignored'|'inactive'} */
    check(text) {
      if (done) return 'inactive';
      if (now() >= expiresAt) { done = true; return 'expired'; }
      if (typeof text !== 'string') return 'ignored';
      const guess = text.trim().toUpperCase();
      if (guess.length !== code.length || !CLAIM_SHAPE.test(guess)) return 'ignored';
      if (timingSafeEqual(Buffer.from(guess), Buffer.from(code))) {
        done = true;
        return 'match';
      }
      attemptsLeft -= 1;
      if (attemptsLeft <= 0) {
        done = true;
        return 'exhausted';
      }
      return 'mismatch';
    },
    cancel() { done = true; },
  };
}
