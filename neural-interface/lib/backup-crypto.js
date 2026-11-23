// ═══════════════════════════════════════════
// BACKUP ENCRYPTION — the container format and its keys
// ═══════════════════════════════════════════
//
// An encrypted backup is the backup's ZIP inside one authenticated container (docs/backup-encryption.md is the
// reference; this file is the code of it). Node's own crypto only.
//
//   file      = prefix(16) || header JSON || header MAC(32) || chunk*
//   prefix    = "SYNBKENC" || version(1) || 0x000000 || uint32be(header JSON length)
//   chunk     = AES-256-GCM(payloadKey, nonce, plaintext ≤ chunkSize, aad = header MAC) || tag(16)
//   nonce     = noncePrefix(7) || uint32be(chunk index) || 0x01 for the last chunk, 0x00 for every other
//
// Keys. The owner's password never encrypts a backup. It wraps (scrypt, then AES-256-GCM) the private half of an
// X25519 key pair together with a random authentication key; a backup gets a random file key that is wrapped to the
// public half (an ephemeral X25519 key, HKDF, AES-256-GCM), so a backup is made without the password and opened only
// with it. Each backup's header carries that wrapped block as it was when the backup was made: the file and the
// password of that day open it anywhere. A new password wraps the same two keys again (rewrapRecipient): the keys
// themselves change only when encryption is turned off and on.
//
// Why the authentication key: a public key lets anybody encrypt. Without a secret the writer holds, whoever has one
// backup could take its public header and write a new file that the real password opens and every check accepts. The
// header MAC is therefore keyed by the authentication key too. It sits in the data home's 0600 key file (a scheduled
// backup needs it and has no password) and inside the password-wrapped block (a restore on a new machine gets it from
// the password). It can sign a backup and can decrypt nothing.
//
//   payloadKey = HKDF-SHA256(fileKey, info "synabun-backup/v1/payload")
//   macKey     = HKDF-SHA256(authKey || fileKey, info "synabun-backup/v1/header-mac")
//   header MAC = HMAC-SHA256(macKey, prefix || header JSON)        every chunk's associated data
//
// What a reader checks before it allocates or derives anything: the magic and version, the header's length
// (MAX_HEADER_BYTES), the chunk size (MIN/MAX_CHUNK_SIZE), the scrypt parameters (SCRYPT_LIMITS) and the length of
// every key and nonce. Reordered, missing, added or changed bytes fail a chunk's tag: the index and the last-chunk
// mark are in its nonce, and the number of chunks is the file's size.
//
// This file holds no I/O of its own beyond reading a header; backup-crypto-io.js writes and reads the files.

import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';
import { open } from 'node:fs/promises';

export const BACKUP_ENC_MAGIC = Buffer.from('SYNBKENC', 'latin1');
export const BACKUP_ENC_VERSION = 1;
export const BACKUP_ENC_EXTENSION = '.enc';
export const PREFIX_BYTES = 16;
export const MAC_BYTES = 32;
export const TAG_BYTES = 16;
export const MAX_HEADER_BYTES = 16 * 1024;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MIN_CHUNK_SIZE = 4096;
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
/** A nonce counts chunks in 32 bits. */
export const MAX_CHUNKS = 0xffffffff;
/** scrypt as a new key is wrapped: 128 MiB, about a third of a second on a current laptop. */
export const DEFAULT_SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1 });
/** What a reader accepts before it derives: a power of two for N, and at most 1 GiB of scrypt memory. */
export const SCRYPT_LIMITS = Object.freeze({ minN: 16384, maxN: 1048576, minR: 8, maxR: 16, minP: 1, maxP: 4, maxMemoryBytes: 1024 * 1024 * 1024 });
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

const INFO_PAYLOAD = 'synabun-backup/v1/payload';
const INFO_HEADER_MAC = 'synabun-backup/v1/header-mac';
const INFO_FILE_KEY = 'synabun-backup/v1/file-key';
const INFO_SNAPSHOT_RECORD = 'synabun-backup/v1/snapshot-record';
const AAD_PRIVATE_KEY = 'synabun-backup/v1/private-key';
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const ZERO_NONCE = Buffer.alloc(12);
const KEY_BYTES = 32;
/** What the password wraps: the X25519 private key, then the authentication key. */
const WRAPPED_KEYS_BYTES = KEY_BYTES * 2;

/** Every failure of this module. `code` says which; a message never holds a password or a key. */
export class BackupEncryptionError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'BackupEncryptionError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, options) => new BackupEncryptionError(code, message, options);
const damaged = (what) => fail('BACKUP_ENC_DAMAGED', `This encrypted backup is damaged or was changed: ${what}.`);

function b64(value, bytes, what) {
  if (typeof value !== 'string' || value.length > bytes * 2 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw damaged(`${what} is not readable`);
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== bytes) throw damaged(`${what} has the wrong length`);
  return buffer;
}

function hkdf(key, info, salt = Buffer.alloc(0)) {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from(info, 'utf8'), 32));
}

function seal(key, nonce, plaintext, aad) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** The plaintext, or null when the tag does not hold. */
function unseal(key, nonce, sealed, aad) {
  if (sealed.length < TAG_BYTES) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try { return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]); }
  catch { return null; }
}

// ── The password ──

/**
 * The password as it is derived from: a string, NFKC, between MIN_ and MAX_PASSWORD_LENGTH characters.
 * `forNew`: the length rule of a password being set; one that opens an existing backup only has to be a string.
 */
export function normalizePassword(password, { forNew = false } = {}) {
  if (typeof password !== 'string' || !password.length) throw fail('PASSWORD_REQUIRED', 'Enter the backup password.');
  if (password.length > MAX_PASSWORD_LENGTH) throw fail('PASSWORD_TOO_LONG', `A backup password has at most ${MAX_PASSWORD_LENGTH} characters.`);
  const normal = password.normalize('NFKC');
  if (forNew && [...normal].length < MIN_PASSWORD_LENGTH) throw fail('PASSWORD_TOO_SHORT', `A backup password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  return Buffer.from(normal, 'utf8');
}

/** The scrypt parameters of a header or key file, checked against SCRYPT_LIMITS before anything is derived. */
export function checkScryptParams(kdf) {
  const { N, r, p } = kdf || {};
  const L = SCRYPT_LIMITS;
  const whole = (value) => Number.isInteger(value) && value > 0;
  if (kdf?.kdf !== 'scrypt' || !whole(N) || !whole(r) || !whole(p)) throw damaged('its key settings are not readable');
  if (N < L.minN || N > L.maxN || (N & (N - 1)) !== 0 || r < L.minR || r > L.maxR || p < L.minP || p > L.maxP || 128 * N * r > L.maxMemoryBytes) {
    throw fail('BACKUP_ENC_UNSUPPORTED', 'This encrypted backup asks for key settings SynaBun does not accept.');
  }
  return { N, r, p };
}

function derivePasswordKey(passwordBytes, salt, { N, r, p }) {
  return new Promise((resolveKey, reject) => {
    // Asynchronous: scrypt runs on the thread pool, never on the thread that calls it.
    scrypt(passwordBytes, salt, 32, { N, r, p, maxmem: 128 * N * r + 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolveKey(key));
  });
}

// ── The key pair ──

function publicKeyOf(privateRaw) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateRaw]), format: 'der', type: 'pkcs8' });
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
}

function sharedSecret(privateRaw, publicRaw) {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateRaw]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, publicRaw]), format: 'der', type: 'spki' }),
  });
  if (shared.every(byte => byte === 0)) throw damaged('its key exchange is not valid');
  return shared;
}

/** A short public name of a key pair: the first 8 bytes of SHA-256 of its public key, in hex. */
export function keyIdOf(publicRaw) {
  return createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);
}

/**
 * The 32-byte authentication key of a recipient as the key file holds it. A recipient read from a backup's header has
 * none (a header never carries it in the clear): BACKUP_ENC_KEY_UNREADABLE, so nothing can be written for it.
 */
export function authKeyOf(recipient) {
  const missing = () => fail('BACKUP_ENC_KEY_UNREADABLE', 'Backup encryption has no usable authentication key. Set it up again in Settings → Backups.', { status: 500 });
  if (typeof recipient?.authKey !== 'string') throw missing();
  try { return b64(recipient.authKey, KEY_BYTES, 'its authentication key'); }
  catch { throw missing(); }
}

/** A keyed digest for the record beside an encrypted upgrade snapshot: it can be compared, and says nothing of a file. */
export function snapshotRecordDigest(authKey, text) {
  const key = hkdf(authKey, INFO_SNAPSHOT_RECORD);
  try { return createHmac('sha256', key).update(text, 'utf8').digest('hex'); }
  finally { key.fill(0); }
}

/**
 * A new key pair whose private half only `password` opens, with a new authentication key. Resolves the recipient as
 * the key file stores it: { type, keyId, publicKey, wrappedPrivateKey: { kdf, N, r, p, salt, nonce, ciphertext },
 * authKey } (base64). A backup's header carries all of it but `authKey`. Neither the password nor the private key is
 * in it, or anywhere after this returns.
 */
export async function createRecipient(password, { kdf = DEFAULT_SCRYPT } = {}) {
  const passwordBytes = normalizePassword(password, { forNew: true });
  const params = checkScryptParams({ kdf: 'scrypt', ...kdf });
  const { privateKey } = generateKeyPairSync('x25519');
  const privateRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length);
  const publicRaw = publicKeyOf(privateRaw);
  const authKey = randomBytes(KEY_BYTES);
  const wrappedKeys = Buffer.concat([privateRaw, authKey]);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const passwordKey = await derivePasswordKey(passwordBytes, salt, params);
  try {
    const ciphertext = seal(passwordKey, nonce, wrappedKeys, Buffer.concat([Buffer.from(AAD_PRIVATE_KEY, 'utf8'), publicRaw]));
    return {
      type: 'x25519-scrypt',
      keyId: keyIdOf(publicRaw),
      publicKey: publicRaw.toString('base64'),
      wrappedPrivateKey: { kdf: 'scrypt', ...params, salt: salt.toString('base64'), nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') },
      authKey: authKey.toString('base64'),
    };
  } finally {
    passwordKey.fill(0); privateRaw.fill(0); passwordBytes.fill(0); authKey.fill(0); wrappedKeys.fill(0);
  }
}

/** A recipient read from a header or the key file, every field checked; the raw public key comes with it. */
export function readRecipient(recipient) {
  if (!recipient || typeof recipient !== 'object' || recipient.type !== 'x25519-scrypt') throw fail('BACKUP_ENC_UNSUPPORTED', 'This encrypted backup uses a kind of key SynaBun does not know.');
  const publicRaw = b64(recipient.publicKey, 32, 'its public key');
  const wrapped = recipient.wrappedPrivateKey;
  const params = checkScryptParams(wrapped);
  return {
    publicRaw,
    keyId: keyIdOf(publicRaw),
    params,
    salt: b64(wrapped?.salt, 16, 'its key salt'),
    nonce: b64(wrapped?.nonce, 12, 'its key nonce'),
    ciphertext: b64(wrapped?.ciphertext, WRAPPED_KEYS_BYTES + TAG_BYTES, 'its wrapped key'),
  };
}

/**
 * The keys of `recipient`, opened with `password`: { privateKey, authKey } (32 raw bytes each: the caller zeroes them
 * when done). WRONG_PASSWORD when the password does not open them. The private key that comes out must be the one the
 * public key belongs to.
 */
export async function unlockRecipient(recipient, password) {
  const read = readRecipient(recipient);
  const passwordBytes = normalizePassword(password);
  const passwordKey = await derivePasswordKey(passwordBytes, read.salt, read.params);
  try {
    const opened = unseal(passwordKey, read.nonce, read.ciphertext, Buffer.concat([Buffer.from(AAD_PRIVATE_KEY, 'utf8'), read.publicRaw]));
    if (!opened) throw fail('WRONG_PASSWORD', 'That password does not open this backup.', { status: 401 });
    const privateKey = Buffer.alloc(KEY_BYTES);
    const authKey = Buffer.alloc(KEY_BYTES);
    opened.copy(privateKey, 0, 0, KEY_BYTES);
    opened.copy(authKey, 0, KEY_BYTES, WRAPPED_KEYS_BYTES);
    opened.fill(0);
    if (!timingSafeEqual(publicKeyOf(privateKey), read.publicRaw)) {
      privateKey.fill(0); authKey.fill(0);
      throw damaged('its key pair does not match');
    }
    return { privateKey, authKey };
  } finally {
    passwordKey.fill(0); passwordBytes.fill(0);
  }
}

/**
 * `recipient` under a new password: the same key pair and the same authentication key, wrapped again (a new salt and
 * nonce). Nothing a backup depends on changes: backups made before keep opening with the password of their day
 * (their headers carry the block as it was), new ones carry this block, and all of them are signed by the one
 * authentication key. WRONG_PASSWORD when `currentPassword` does not open the stored block. Resolves the recipient as
 * the key file stores it; its `authKey` is the one the password wrapped, so a key file whose clear copy was changed
 * is put right by it.
 */
export async function rewrapRecipient(recipient, currentPassword, newPassword, { kdf = DEFAULT_SCRYPT } = {}) {
  const read = readRecipient(recipient);
  const newBytes = normalizePassword(newPassword, { forNew: true });
  let keys = null;
  let wrappedKeys = null;
  let passwordKey = null;
  try {
    const params = checkScryptParams({ kdf: 'scrypt', ...kdf });
    keys = await unlockRecipient(recipient, currentPassword);
    wrappedKeys = Buffer.concat([keys.privateKey, keys.authKey]);
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    passwordKey = await derivePasswordKey(newBytes, salt, params);
    const ciphertext = seal(passwordKey, nonce, wrappedKeys, Buffer.concat([Buffer.from(AAD_PRIVATE_KEY, 'utf8'), read.publicRaw]));
    return {
      type: 'x25519-scrypt',
      keyId: read.keyId,
      publicKey: read.publicRaw.toString('base64'),
      wrappedPrivateKey: { kdf: 'scrypt', ...params, salt: salt.toString('base64'), nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') },
      authKey: keys.authKey.toString('base64'),
    };
  } finally {
    newBytes.fill(0); passwordKey?.fill(0); wrappedKeys?.fill(0); keys?.privateKey.fill(0); keys?.authKey.fill(0);
  }
}

// ── The header ──

function fileKeyWrapKey(shared, ephemeralPublic, recipientPublic) {
  return hkdf(shared, INFO_FILE_KEY, Buffer.concat([ephemeralPublic, recipientPublic]));
}

function prefixFor(headerLength) {
  const prefix = Buffer.alloc(PREFIX_BYTES);
  BACKUP_ENC_MAGIC.copy(prefix, 0);
  prefix.writeUInt8(BACKUP_ENC_VERSION, 8);
  prefix.writeUInt32BE(headerLength, 12);
  return prefix;
}

function sessionFor(fileKey, noncePrefix, chunkSize, mac) {
  return { payloadKey: hkdf(fileKey, INFO_PAYLOAD), noncePrefix, chunkSize, aad: mac };
}

function headerMac(authKey, fileKey, start) {
  const ikm = Buffer.concat([authKey, fileKey]);
  const key = hkdf(ikm, INFO_HEADER_MAC);
  try { return createHmac('sha256', key).update(start).digest(); }
  finally { ikm.fill(0); key.fill(0); }
}

/**
 * The start of a new encrypted backup for `recipient` (its public key and authentication key: no password is asked).
 * Returns { bytes, fileKey, authKey, session, header }: `bytes` is what the file begins with (prefix, header JSON,
 * MAC), `fileKey` the random key of this one file and `authKey` a copy of the authentication key (both kept by the
 * caller only until the file is verified), `session` what sealChunk / openChunk take.
 */
export function createBackupHeader(recipient, { chunkSize = DEFAULT_CHUNK_SIZE, now = () => new Date() } = {}) {
  const read = readRecipient(recipient);
  const authKey = authKeyOf(recipient);
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) throw new RangeError(`chunkSize must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`);
  const fileKey = randomBytes(32);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPrivate = ephemeral.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length);
  const ephemeralPublic = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
  const shared = sharedSecret(ephemeralPrivate, read.publicRaw);
  const wrapKey = fileKeyWrapKey(shared, ephemeralPublic, read.publicRaw);
  const noncePrefix = randomBytes(7);
  const header = {
    v: BACKUP_ENC_VERSION,
    cipher: 'AES-256-GCM',
    chunkSize,
    noncePrefix: noncePrefix.toString('base64'),
    created: now().toISOString(),
    recipient: { type: recipient.type, keyId: read.keyId, publicKey: recipient.publicKey, wrappedPrivateKey: { ...recipient.wrappedPrivateKey } },
    // The wrap key is used once (a new ephemeral key per file), so its nonce is fixed.
    fileKey: { ephemeralPublicKey: ephemeralPublic.toString('base64'), ciphertext: seal(wrapKey, ZERO_NONCE, fileKey, Buffer.from(INFO_FILE_KEY, 'utf8')).toString('base64') },
  };
  shared.fill(0); wrapKey.fill(0); ephemeralPrivate.fill(0);
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (json.length > MAX_HEADER_BYTES) throw new Error('The backup header is too large');
  const start = Buffer.concat([prefixFor(json.length), json]);
  const mac = headerMac(authKey, fileKey, start);
  return { bytes: Buffer.concat([start, mac]), fileKey, authKey, session: sessionFor(fileKey, noncePrefix, chunkSize, mac), header };
}

/** True when `bytes` (at least 8) begin as an encrypted backup does. */
export function hasEncryptedBackupMagic(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= BACKUP_ENC_MAGIC.length && bytes.subarray(0, BACKUP_ENC_MAGIC.length).equals(BACKUP_ENC_MAGIC);
}

/**
 * The header of an encrypted backup, read through `readAt(position, length)` (a Buffer of exactly that length, or
 * shorter at the end of the file). Nothing here trusts the file: every length is bounded before it is read.
 * Resolves { header, recipient (readRecipient), start (prefix + JSON), mac, dataOffset, chunkSize, noncePrefix }.
 */
export async function readBackupHeader(readAt) {
  const prefix = await readAt(0, PREFIX_BYTES);
  if (!hasEncryptedBackupMagic(prefix)) throw fail('BACKUP_NOT_ENCRYPTED', 'This file is not an encrypted SynaBun backup.');
  if (prefix.length < PREFIX_BYTES) throw damaged('it ends inside its header');
  const version = prefix.readUInt8(8);
  if (version < 1) throw damaged('its format version is not readable');
  if (version > BACKUP_ENC_VERSION) throw fail('BACKUP_ENC_UNSUPPORTED', `This backup was encrypted by a newer SynaBun (format ${version}). Update SynaBun to restore it.`);
  const length = prefix.readUInt32BE(12);
  if (length < 2 || length > MAX_HEADER_BYTES) throw damaged('its header has an impossible length');
  const rest = await readAt(PREFIX_BYTES, length + MAC_BYTES);
  if (rest.length < length + MAC_BYTES) throw damaged('it ends inside its header');
  let header;
  try { header = JSON.parse(rest.subarray(0, length).toString('utf8')); } catch { throw damaged('its header is not readable'); }
  if (!header || typeof header !== 'object' || header.v !== BACKUP_ENC_VERSION || header.cipher !== 'AES-256-GCM') throw fail('BACKUP_ENC_UNSUPPORTED', 'This encrypted backup uses a format SynaBun does not know.');
  const chunkSize = header.chunkSize;
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) throw damaged('its chunk size is out of range');
  return {
    header,
    recipient: readRecipient(header.recipient),
    start: Buffer.concat([prefix, rest.subarray(0, length)]),
    mac: Buffer.from(rest.subarray(length)),
    dataOffset: PREFIX_BYTES + length + MAC_BYTES,
    chunkSize,
    noncePrefix: b64(header.noncePrefix, 7, 'its nonce prefix'),
    ephemeralPublic: b64(header.fileKey?.ephemeralPublicKey, 32, 'its file key'),
    wrappedFileKey: b64(header.fileKey?.ciphertext, 32 + TAG_BYTES, 'its file key'),
  };
}

/** The header of the file at `path` (readBackupHeader over the file). */
export async function readBackupHeaderFile(path) {
  const handle = await open(path, 'r');
  try {
    return await readBackupHeader(async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    });
  } finally {
    await handle.close();
  }
}

/** True when the file at `path` begins as an encrypted backup does. False for a file that cannot be read. */
export async function isEncryptedBackupFile(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(BACKUP_ENC_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return hasEncryptedBackupMagic(buffer.subarray(0, bytesRead));
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}

/** The file key of a parsed header (readBackupHeader), opened with the private key. */
export function unwrapFileKey(parsed, privateRaw) {
  const shared = sharedSecret(privateRaw, parsed.ephemeralPublic);
  const wrapKey = fileKeyWrapKey(shared, parsed.ephemeralPublic, parsed.recipient.publicRaw);
  try {
    const fileKey = unseal(wrapKey, ZERO_NONCE, parsed.wrappedFileKey, Buffer.from(INFO_FILE_KEY, 'utf8'));
    if (!fileKey) throw damaged('its file key does not open');
    return fileKey;
  } finally { shared.fill(0); wrapKey.fill(0); }
}

/**
 * The session of a parsed header for `fileKey` and `authKey`: the header's MAC is checked first, so a header changed
 * in any byte (the chunk size, the nonce prefix, the recipient), or a whole file written by somebody who does not hold
 * the authentication key, is refused before a chunk is read.
 */
export function openBackupSession(parsed, fileKey, authKey) {
  if (!Buffer.isBuffer(fileKey) || fileKey.length !== KEY_BYTES) throw new TypeError('fileKey must be 32 bytes');
  if (!Buffer.isBuffer(authKey) || authKey.length !== KEY_BYTES) throw new TypeError('authKey must be 32 bytes');
  const mac = headerMac(authKey, fileKey, parsed.start);
  if (!timingSafeEqual(mac, parsed.mac)) throw damaged('its header does not match its key');
  return sessionFor(fileKey, parsed.noncePrefix, parsed.chunkSize, mac);
}

/** The file key, authentication key and session of the backup whose header is `parsed`, opened with `password`. */
export async function unlockBackupHeader(parsed, password) {
  const { privateKey, authKey } = await unlockRecipient(parsed.header.recipient, password);
  let fileKey = null;
  try {
    fileKey = unwrapFileKey(parsed, privateKey);
    return { fileKey, authKey, session: openBackupSession(parsed, fileKey, authKey) };
  } catch (error) {
    fileKey?.fill(0);
    authKey.fill(0);
    throw error;
  } finally { privateKey.fill(0); }
}

// ── The chunks ──

function chunkNonce(session, index, last) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) throw new RangeError('chunk index out of range');
  const nonce = Buffer.alloc(12);
  session.noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 7);
  nonce.writeUInt8(last ? 1 : 0, 11);
  return nonce;
}

/** Chunk `index` of the plaintext, sealed (ciphertext then its 16-byte tag). `last`: it is the file's final chunk. */
export function sealChunk(session, index, last, plaintext) {
  if (plaintext.length > session.chunkSize) throw new RangeError('a chunk is larger than the chunk size');
  return seal(session.payloadKey, chunkNonce(session, index, last), plaintext, session.aad);
}

/** The plaintext of chunk `index`, or a BACKUP_ENC_DAMAGED error: wrong place, wrong last mark, or changed bytes. */
export function openChunk(session, index, last, sealed) {
  const plaintext = unseal(session.payloadKey, chunkNonce(session, index, last), sealed, session.aad);
  if (!plaintext) throw damaged(`part ${index + 1} does not pass its check`);
  return plaintext;
}

/**
 * Where the chunks of a file are: { chunks, plaintextSize, lastSealedSize } for a payload of `payloadBytes` (the
 * file's size less the header). A payload that no whole file could have is refused here, before any chunk is read:
 * shorter than one tag, or ending in a chunk with a tag and no data after another chunk.
 */
export function chunkLayout(payloadBytes, chunkSize) {
  const sealedSize = chunkSize + TAG_BYTES;
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < TAG_BYTES) throw damaged('it ends before its first part');
  const chunks = Math.ceil(payloadBytes / sealedSize);
  if (chunks > MAX_CHUNKS) throw damaged('it holds more parts than a backup can');
  const lastSealedSize = payloadBytes - (chunks - 1) * sealedSize;
  if (lastSealedSize < TAG_BYTES || (lastSealedSize === TAG_BYTES && chunks > 1)) throw damaged('its last part is cut short');
  return { chunks, plaintextSize: payloadBytes - chunks * TAG_BYTES, lastSealedSize, sealedSize };
}

/**
 * Turns a stream of plaintext into sealed chunks, in order. `push(bytes)` returns the sealed chunks that are now
 * complete (possibly none: the last chunk of a file is only known at `finish()`, which returns the rest). Synchronous;
 * the writer of backup-crypto-worker.js runs it on a thread of its own.
 */
export function createChunkSealer(session) {
  let held = Buffer.alloc(0);
  let index = 0;
  let finished = false;
  return {
    push(bytes) {
      if (finished) throw new Error('the backup was already finished');
      held = held.length ? Buffer.concat([held, bytes]) : bytes;
      const out = [];
      // A full chunk is sealed only once a byte after it exists: until then it may be the last one.
      while (held.length > session.chunkSize) {
        out.push(sealChunk(session, index++, false, held.subarray(0, session.chunkSize)));
        held = held.subarray(session.chunkSize);
      }
      return out;
    },
    finish() {
      if (finished) throw new Error('the backup was already finished');
      finished = true;
      const last = sealChunk(session, index++, true, held);
      held = Buffer.alloc(0);
      return [last];
    },
  };
}
