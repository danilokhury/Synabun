/**
 * Authenticode signing of the Windows build (docs/windows-code-signing.md).
 *
 * Off unless the environment asks for it: with no SYNABUN_WIN_SIGN_PROVIDER
 * (or `none`) the build stays exactly what it was, unsigned, and says so once.
 * When a provider is named, the build is cross-made on macOS, so nothing here
 * needs Windows: jsign (Java) signs, osslsigncode verifies.
 *
 *   azure-artifact-signing  Microsoft's Artifact Signing (formerly Trusted Signing): jsign --storetype TRUSTEDSIGNING
 *   pkcs11                  a hardware token or a cloud HSM with a PKCS#11 module (or a jsign token type such as
 *                           CRYPTOCERTUM / YUBIKEY / ETOKEN / PIV): jsign --storetype PKCS11 (or that type)
 *   ssl-esigner             SSL.com eSigner cloud signing: jsign --storetype ESIGNER
 *
 * SynaBun executables, Electron DLLs, payload native modules/helpers and owned PowerShell scripts, before packing.
 * Existing verified vendor signatures are preserved; Node, cloudflared and Git bundles remain immutable.
 *
 * Secrets are read from the environment only, reach jsign through its own `env:NAME` form (never its command line),
 * and are taken out of every line this module prints (createRedactor). Every signature is verified right after it is
 * made, and a bad one stops the build.
 *
 * Pure parts (plan, command lines, parsing, policy, app-update.yml) are tested in packaging/tests/win-sign.test.mjs;
 * the hook electron-builder calls is win-sign-hook.mjs. Run `node packaging/lib/win-sign.mjs check` for a dry run.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_FILE = join(dirname(fileURLToPath(import.meta.url)), 'win-sign-hook.mjs');
export const PUBLISHER_ENV = 'SYNABUN_WIN_PUBLISHER_NAME';
export const SIGN_ENV_PREFIX = 'SYNABUN_WIN_SIGN_';
export const AZURE_CREDENTIALS = Object.freeze(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']);
/** The variable the composed jsign store password travels in, to the jsign child only. */
export const STOREPASS_VAR = 'SYNABUN_JSIGN_STOREPASS';
export const APP_NAME = 'SynaBun';
export const APP_URL = 'https://synabun.ai';
/** Our own executables in the app folder: the window and the native entry (packaging/launcher). */
export const OWN_EXECUTABLES = Object.freeze(['SynaBun.exe', 'synabun-cli.exe']);

/** Every value that must never be printed, by variable name. */
export const SECRET_NAMES = Object.freeze([
  'SYNABUN_WIN_SIGN_AZURE_TOKEN', 'AZURE_CLIENT_SECRET', 'SYNABUN_WIN_SIGN_PKCS11_PIN',
  'SYNABUN_WIN_SIGN_ESIGNER_PASSWORD', 'SYNABUN_WIN_SIGN_ESIGNER_TOTP_SECRET', STOREPASS_VAR,
  // The certificate-file path earlier builds read (electron-builder's own signing).
  'SYNABUN_WIN_SIGN_PASSWORD', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD',
]);

const PROVIDERS = Object.freeze({
  none: 'none', off: 'none', '': 'none',
  'azure-artifact-signing': 'azure-artifact-signing', 'azure-trusted-signing': 'azure-artifact-signing',
  'artifact-signing': 'azure-artifact-signing', 'trusted-signing': 'azure-artifact-signing', azure: 'azure-artifact-signing',
  pkcs11: 'pkcs11', token: 'pkcs11',
  'ssl-esigner': 'ssl-esigner', esigner: 'ssl-esigner',
});
export const PROVIDER_NAMES = Object.freeze(['azure-artifact-signing', 'pkcs11', 'ssl-esigner', 'none']);

/** RFC 3161 servers, per provider, when SYNABUN_WIN_SIGN_TIMESTAMP_URL names none (comma-separated fallbacks). */
export const DEFAULT_TIMESTAMP = Object.freeze({
  'azure-artifact-signing': ['http://timestamp.acs.microsoft.com'],
  pkcs11: ['http://timestamp.digicert.com', 'http://timestamp.sectigo.com'],
  'ssl-esigner': ['http://ts.ssl.com', 'http://timestamp.digicert.com'],
});

/** jsign's token store types the pkcs11 provider accepts besides the generic PKCS11. */
export const TOKEN_TYPES = Object.freeze(['PKCS11', 'CRYPTOCERTUM', 'YUBIKEY', 'ETOKEN', 'PIV', 'OPENSC', 'NITROKEY', 'OPENPGP']);

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
const text = (value) => String(value ?? '').trim();

export function resolveProvider(value) {
  const key = text(value).toLowerCase();
  return Object.hasOwn(PROVIDERS, key) ? PROVIDERS[key] : null;
}

/** The publisher names updates are checked against, from SYNABUN_WIN_PUBLISHER_NAME ("|" between names). */
export function publisherNamesFrom(env = process.env) {
  return text(env[PUBLISHER_ENV]).split('|').map(name => name.trim()).filter(Boolean);
}

/**
 * What the environment asks for. { provider, enabled, dryRun, required, problems[], ... }. Pure: nothing is run and
 * no file is read (paths are only checked to be absolute; `checkTools` looks at the disk).
 */
export function windowsSigningPlan(env = process.env) {
  const raw = text(env.SYNABUN_WIN_SIGN_PROVIDER);
  const provider = resolveProvider(raw);
  const required = truthy(env.SYNABUN_WIN_SIGN_REQUIRED);
  const dryRun = truthy(env.SYNABUN_WIN_SIGN_DRY_RUN);
  const problems = [];
  const plan = {
    provider: provider || raw, enabled: false, dryRun, required, problems,
    publisherNames: publisherNamesFrom(env),
    timestampUrls: [], jsign: text(env.SYNABUN_WIN_SIGN_JSIGN), java: text(env.SYNABUN_WIN_SIGN_JAVA) || (env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', 'java') : 'java'),
    osslsigncode: text(env.SYNABUN_WIN_SIGN_OSSLSIGNCODE),
    caFile: text(env.SYNABUN_WIN_SIGN_CA_FILE), tsaCaFile: text(env.SYNABUN_WIN_SIGN_TSA_CA_FILE) || text(env.SYNABUN_WIN_SIGN_CA_FILE),
    verifyMode: text(env.SYNABUN_WIN_SIGN_VERIFY).toLowerCase() || 'full',
    store: null,
  };
  if (provider === null) {
    problems.push(`SYNABUN_WIN_SIGN_PROVIDER is "${raw}": use one of ${PROVIDER_NAMES.join(', ')}`);
    return plan;
  }
  if (provider === 'none') {
    if (required) problems.push('SYNABUN_WIN_SIGN_REQUIRED is set but no signing provider is configured (SYNABUN_WIN_SIGN_PROVIDER)');
    return plan;
  }
  plan.enabled = true;
  const urls = text(env.SYNABUN_WIN_SIGN_TIMESTAMP_URL).split(',').map(url => url.trim()).filter(Boolean);
  plan.timestampUrls = urls.length ? urls : [...DEFAULT_TIMESTAMP[provider]];
  for (const url of plan.timestampUrls) if (!/^https?:\/\/[^\s/]+/.test(url)) problems.push(`timestamp server "${url}" is not an http(s) URL`);
  if (!plan.jsign) problems.push('SYNABUN_WIN_SIGN_JSIGN must name the jsign launcher or jsign-<version>.jar (absolute path)');
  if (!plan.osslsigncode) problems.push('SYNABUN_WIN_SIGN_OSSLSIGNCODE must name osslsigncode (absolute path): every signature is verified');
  for (const [name, value] of [['SYNABUN_WIN_SIGN_JSIGN', plan.jsign], ['SYNABUN_WIN_SIGN_OSSLSIGNCODE', plan.osslsigncode], ['SYNABUN_WIN_SIGN_CA_FILE', plan.caFile], ['SYNABUN_WIN_SIGN_TSA_CA_FILE', text(env.SYNABUN_WIN_SIGN_TSA_CA_FILE)]]) {
    if (value && !isAbsolutePath(value)) problems.push(`${name} must be an absolute path (the release build runs with a minimal PATH)`);
  }
  if (!['full', 'integrity'].includes(plan.verifyMode)) problems.push(`SYNABUN_WIN_SIGN_VERIFY is "${plan.verifyMode}": use full or integrity`);
  if (!plan.publisherNames.length) {
    problems.push(`${PUBLISHER_ENV} must give the certificate's subject as Windows shows it (e.g. "CN=Jane Doe, O=Jane Doe, L=City, S=State, C=BR"): signed builds write it into app-update.yml so updates are checked against it`);
  }
  if (provider === 'azure-artifact-signing') {
    const endpoint = text(env.SYNABUN_WIN_SIGN_AZURE_ENDPOINT).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const account = text(env.SYNABUN_WIN_SIGN_AZURE_ACCOUNT);
    const profile = text(env.SYNABUN_WIN_SIGN_AZURE_PROFILE);
    if (!/^[a-z0-9-]+\.codesigning\.azure\.net$/i.test(endpoint)) problems.push('SYNABUN_WIN_SIGN_AZURE_ENDPOINT must be the account\'s region endpoint, e.g. https://eus.codesigning.azure.net');
    if (!account) problems.push('SYNABUN_WIN_SIGN_AZURE_ACCOUNT must name the Artifact Signing account');
    if (!profile) problems.push('SYNABUN_WIN_SIGN_AZURE_PROFILE must name the certificate profile');
    const token = !!text(env.SYNABUN_WIN_SIGN_AZURE_TOKEN);
    const credentials = AZURE_CREDENTIALS.every(name => text(env[name]));
    if (!token && !credentials) problems.push('Artifact Signing needs SYNABUN_WIN_SIGN_AZURE_TOKEN (an access token for https://codesigning.azure.net) or AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET');
    plan.store = { type: 'TRUSTEDSIGNING', keystore: endpoint, alias: `${account}/${profile}`, auth: token ? 'token' : 'client-secret' };
  } else if (provider === 'pkcs11') {
    const type = (text(env.SYNABUN_WIN_SIGN_TOKEN_TYPE) || 'PKCS11').toUpperCase();
    if (!TOKEN_TYPES.includes(type)) problems.push(`SYNABUN_WIN_SIGN_TOKEN_TYPE is "${type}": use one of ${TOKEN_TYPES.join(', ')}`);
    const config = text(env.SYNABUN_WIN_SIGN_PKCS11_CONFIG);
    const library = text(env.SYNABUN_WIN_SIGN_PKCS11_LIBRARY);
    const slot = text(env.SYNABUN_WIN_SIGN_PKCS11_SLOT);
    let keystore = null;
    if (type === 'PKCS11') {
      if (config && library) problems.push('give SYNABUN_WIN_SIGN_PKCS11_CONFIG or SYNABUN_WIN_SIGN_PKCS11_LIBRARY, not both');
      else if (config) keystore = config;
      else if (library) keystore = `--name=SynaBunSigning\\nlibrary=${library}${slot ? `\\nslot=${slot}` : ''}`;
      else problems.push('a PKCS#11 token needs SYNABUN_WIN_SIGN_PKCS11_LIBRARY (the module, e.g. a .dylib) or SYNABUN_WIN_SIGN_PKCS11_CONFIG (a SunPKCS11 configuration file)');
      for (const [name, value] of [['SYNABUN_WIN_SIGN_PKCS11_CONFIG', config], ['SYNABUN_WIN_SIGN_PKCS11_LIBRARY', library]]) if (value && !isAbsolutePath(value)) problems.push(`${name} must be an absolute path`);
      if (slot && !/^\d+$/.test(slot)) problems.push('SYNABUN_WIN_SIGN_PKCS11_SLOT must be a number');
    } else if (text(env.SYNABUN_WIN_SIGN_PKCS11_KEYSTORE)) {
      keystore = text(env.SYNABUN_WIN_SIGN_PKCS11_KEYSTORE);
    }
    if (!text(env.SYNABUN_WIN_SIGN_PKCS11_PIN)) problems.push('SYNABUN_WIN_SIGN_PKCS11_PIN must give the token\'s PIN');
    const certfile = text(env.SYNABUN_WIN_SIGN_CERTFILE);
    if (certfile && !isAbsolutePath(certfile)) problems.push('SYNABUN_WIN_SIGN_CERTFILE must be an absolute path');
    plan.store = { type, keystore, alias: text(env.SYNABUN_WIN_SIGN_ALIAS) || null, certfile: certfile || null, auth: 'pin' };
  } else if (provider === 'ssl-esigner') {
    for (const name of ['SYNABUN_WIN_SIGN_ESIGNER_USERNAME', 'SYNABUN_WIN_SIGN_ESIGNER_PASSWORD', 'SYNABUN_WIN_SIGN_ESIGNER_CREDENTIAL_ID', 'SYNABUN_WIN_SIGN_ESIGNER_TOTP_SECRET']) {
      if (!text(env[name])) problems.push(`SSL.com eSigner needs ${name}`);
    }
    const endpoint = text(env.SYNABUN_WIN_SIGN_ESIGNER_ENDPOINT);
    if (endpoint && !/^https:\/\//.test(endpoint)) problems.push('SYNABUN_WIN_SIGN_ESIGNER_ENDPOINT must be an https URL (the sandbox is https://cs-try.ssl.com)');
    plan.store = { type: 'ESIGNER', keystore: endpoint || null, alias: text(env.SYNABUN_WIN_SIGN_ESIGNER_CREDENTIAL_ID), auth: 'password+totp' };
  }
  return plan;
}

const isAbsolutePath = (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

/** The names of the environment a Windows build's signing reads (for passing them to an isolated build). */
export function signingEnvNames(env = process.env) {
  return Object.keys(env).filter(name => name.startsWith(SIGN_ENV_PREFIX) || name === PUBLISHER_ENV || AZURE_CREDENTIALS.includes(name)
    || (name === 'JAVA_HOME' && !!text(env.SYNABUN_WIN_SIGN_PROVIDER))).sort();
}

/** The part of an environment the signing reads, to hand to an isolated child (scripts/release builds). */
export function windowsSigningEnv(env = process.env) {
  const out = {};
  for (const name of signingEnvNames(env)) if (env[name] !== undefined) out[name] = env[name];
  return out;
}

/**
 * What changes a signed build, without its secrets: part of a release build's cache key, so an unsigned build is not
 * kept as the result of a signed one (or the other way round).
 */
export function signingFingerprint(env = process.env) {
  const plan = windowsSigningPlan(env);
  if (!plan.enabled) return 'unsigned';
  if (plan.dryRun) return 'unsigned (dry run)';
  return JSON.stringify({ coverage: 'sac-all-v1', provider: plan.provider, store: plan.store && { type: plan.store.type, keystore: plan.store.keystore, alias: plan.store.alias }, publisherNames: plan.publisherNames, timestamp: plan.timestampUrls });
}

// ── Redaction ──

/** A function that takes every secret value (and every part of a composed one) out of a text. */
export function createRedactor(env = process.env, extra = []) {
  const values = new Set();
  const add = (value) => {
    const v = String(value ?? '');
    if (v.trim().length >= 4) values.add(v);
    if (v.includes('|')) for (const part of v.split('|')) if (part.trim().length >= 4) values.add(part);
  };
  for (const name of SECRET_NAMES) add(env[name]);
  for (const value of extra) add(value);
  const list = [...values].sort((a, b) => b.length - a.length);
  return (input) => {
    let out = String(input ?? '');
    for (const value of list) out = out.split(value).join('[redacted]');
    // Bearer tokens and JWTs, wherever they come from (an error body quoting the request, a debug line).
    out = out.replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '[redacted]');
    out = out.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[redacted]');
    return out;
  };
}

// ── Command lines ──

/**
 * The jsign invocation for one file: { file: executable, args, env } with every secret only in `env` and named in the
 * arguments as env:NAME. `baseEnv` is the environment of the build (PATH, HOME, proxies are kept).
 */
export function jsignCommand(plan, target, baseEnv = process.env) {
  if (!plan.enabled) throw new Error('signing is not configured');
  const childEnv = childEnvironment(baseEnv);
  const args = ['--storetype', plan.store.type];
  if (plan.store.keystore) args.push('--keystore', plan.store.keystore);
  if (plan.store.alias) args.push('--alias', plan.store.alias);
  if (plan.provider === 'azure-artifact-signing') {
    if (plan.store.auth === 'token') {
      childEnv.SYNABUN_WIN_SIGN_AZURE_TOKEN = baseEnv.SYNABUN_WIN_SIGN_AZURE_TOKEN;
      args.push('--storepass', 'env:SYNABUN_WIN_SIGN_AZURE_TOKEN');
    } else {
      childEnv[STOREPASS_VAR] = AZURE_CREDENTIALS.map(name => text(baseEnv[name])).join('|');
      args.push('--storepass', `env:${STOREPASS_VAR}`);
    }
  } else if (plan.provider === 'pkcs11') {
    childEnv.SYNABUN_WIN_SIGN_PKCS11_PIN = baseEnv.SYNABUN_WIN_SIGN_PKCS11_PIN;
    args.push('--storepass', 'env:SYNABUN_WIN_SIGN_PKCS11_PIN');
    if (plan.store.certfile) args.push('--certfile', plan.store.certfile);
  } else if (plan.provider === 'ssl-esigner') {
    childEnv[STOREPASS_VAR] = `${text(baseEnv.SYNABUN_WIN_SIGN_ESIGNER_USERNAME)}|${baseEnv.SYNABUN_WIN_SIGN_ESIGNER_PASSWORD ?? ''}`;
    childEnv.SYNABUN_WIN_SIGN_ESIGNER_TOTP_SECRET = baseEnv.SYNABUN_WIN_SIGN_ESIGNER_TOTP_SECRET;
    args.push('--storepass', `env:${STOREPASS_VAR}`, '--keypass', 'env:SYNABUN_WIN_SIGN_ESIGNER_TOTP_SECRET');
  }
  args.push(
    '--alg', 'SHA-256',
    '--tsaurl', plan.timestampUrls.join(','), '--tsmode', 'RFC3161', '--tsretries', '3', '--tsretrywait', '10',
    '--name', APP_NAME, '--url', APP_URL,
    // A retried file gets one signature, not two.
    '--replace',
    target,
  );
  if (plan.jsign.toLowerCase().endsWith('.jar')) return { file: plan.java, args: ['-jar', plan.jsign, ...args], env: childEnv };
  return { file: plan.jsign, args, env: childEnv };
}

/** osslsigncode's verification of one file: { file, args }. */
export function verifyCommand(plan, target) {
  const args = ['verify', '-in', target, '-ignore-crl'];
  if (plan.caFile) args.push('-CAfile', plan.caFile);
  if (plan.tsaCaFile) args.push('-TSA-CAfile', plan.tsaCaFile);
  return { file: plan.osslsigncode, args };
}

/** The environment a signing tool gets: what reaches the network and Java, nothing else of the build's. */
export function childEnvironment(env = process.env) {
  const out = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'JAVA_HOME', 'SystemRoot', 'USERPROFILE',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  return out;
}

/** A command line for a log: arguments that look like a secret are already env:NAME; the rest goes through redact. */
export function describeCommand({ file, args }, redact = (value) => value) {
  return redact([file, ...args].map(arg => (/[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' '));
}

// ── What gets signed ──

/** Extensions Authenticode can sign. Batch files cannot carry an Authenticode signature. */
export const SIGN_EXTENSIONS = Object.freeze(['.exe', '.dll', '.node', '.sys', '.ps1', '.psm1', '.vbs', '.msi']);
const normalPath = path => String(path).replace(/\\/g, '/');
export const isSignable = path => SIGN_EXTENSIONS.some(ext => String(path).toLowerCase().endsWith(ext));
export const isPowerShell = path => /\.ps(?:1|m1)$/i.test(path);

/** Scope is ownership, never merely an extension: pinned vendor trees are immutable. */
export function signPolicy(path) {
  const rel = normalPath(path);
  const name = rel.split('/').at(-1) || '';
  const lower = rel.toLowerCase();
  if (/(^|\/)resources\/(runtime|cloudflared|git|git-archive)(\/|$)/i.test(rel))
    return { sign: false, kind: 'payload', reason: 'immutable vendor bundle (pins and vendor signatures preserved)' };
  if (/^synabun(?:-cli|-install-window)?\.exe$/i.test(name) && !lower.includes('/resources/app/'))
    return { sign: true, kind: 'app', reason: 'SynaBun executable' };
  if (/__uninstaller\.exe$/i.test(name) || /^Uninstall SynaBun\.exe$/i.test(name))
    return { sign: true, kind: 'uninstaller', reason: 'SynaBun uninstaller' };
  if (/^SynaBun-.+-setup\.exe$/i.test(name)) return { sign: true, kind: 'installer', reason: 'SynaBun installer' };
  if (!isSignable(rel)) return { sign: false, kind: 'other', reason: 'not an Authenticode format' };
  if (/\.(dll|node|sys)$/i.test(name)) return { sign: true, kind: 'native', reason: 'distributed native code; preserve a verified vendor signature' };
  if (/(^|\/)resources\/(app|app.asar.unpacked|update-ui)\//i.test(rel) ||
      /^(install-window|synabun-(stop|verify))\.ps1$/i.test(name))
    return { sign: true, kind: isPowerShell(name) ? 'script' : 'helper', reason: 'SynaBun payload code' };
  return { sign: false, kind: 'other', reason: 'unknown executable: inventory must identify its owner' };
}

/** Sequential sweep: electron-builder does not walk DLLs in arbitrary extraResources. */
export function windowsFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...windowsFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
export function signWindowsTree(plan, root, options = {}) {
  if (!plan.enabled) return [];
  return windowsFiles(root).filter(path => signPolicy(path).sign).map(path => ({ path, ...signFile(plan, path, options) }));
}

// ── Signatures in a PE file ──

/**
 * The Authenticode part of a PE file: { pe, signed, certificateType, length } (null when it is not a PE).
 * Reads the header and the WIN_CERTIFICATE header only.
 */
export function authenticodeInfo(path) {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const head = Buffer.alloc(Math.min(4096, size));
    readSync(fd, head, 0, head.length, 0);
    if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
    const pe = head.readUInt32LE(0x3c);
    if (pe + 24 > head.length || head.readUInt32LE(pe) !== 0x00004550) return null;
    const optional = pe + 24;
    const magic = head.readUInt16LE(optional);
    const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
    if (security + 8 > head.length) return { pe: true, signed: false, certificateType: null, length: 0 };
    const offset = head.readUInt32LE(security);
    const length = head.readUInt32LE(security + 4);
    if (!offset || !length || offset + 8 > size) return { pe: true, signed: false, certificateType: null, length: 0 };
    const entry = Buffer.alloc(8);
    readSync(fd, entry, 0, 8, offset);
    // WIN_CERTIFICATE: dwLength, wRevision (0x0200), wCertificateType (0x0002 = PKCS#7 SignedData).
    const certificateType = entry.readUInt16LE(6);
    return { pe: true, signed: certificateType === 2 && entry.readUInt32LE(0) > 8, certificateType, length };
  } finally {
    closeSync(fd);
  }
}

// ── Verification ──

/**
 * A distinguished name as electron-updater reads one (builder-util-runtime's parseDn, MIT, ported as is): RFC 2253
 * text, "," ";" or "+" between attributes, quotes and backslash escapes. Returns a Map.
 */
export function parseDn(seq) {
  let quoted = false;
  let key = null;
  let token = '';
  let nextNonSpace = 0;
  seq = String(seq).trim();
  const result = new Map();
  for (let i = 0; i <= seq.length; i++) {
    if (i === seq.length) {
      if (key !== null) result.set(key, token);
      break;
    }
    const ch = seq[i];
    if (quoted) {
      if (ch === '"') { quoted = false; continue; }
    } else {
      if (ch === '"') { quoted = true; continue; }
      if (ch === '\\') {
        i++;
        const ord = parseInt(seq.slice(i, i + 2), 16);
        if (Number.isNaN(ord)) token += seq[i];
        else { i++; token += String.fromCharCode(ord); }
        continue;
      }
      if (key === null && ch === '=') { key = token; token = ''; continue; }
      if (ch === ',' || ch === ';' || ch === '+') {
        if (key !== null) result.set(key, token);
        key = null;
        token = '';
        continue;
      }
    }
    if (ch === ' ' && !quoted) {
      if (token.length === 0) continue;
      if (i > nextNonSpace) {
        let j = i;
        while (seq[j] === ' ') j++;
        nextNonSpace = j;
      }
      if (nextNonSpace >= seq.length || seq[nextNonSpace] === ',' || seq[nextNonSpace] === ';'
        || (key === null && seq[nextNonSpace] === '=') || (key !== null && seq[nextNonSpace] === '+')) {
        i = nextNonSpace - 1;
        continue;
      }
    }
    token += ch;
  }
  return result;
}

/** OpenSSL attribute names → the names Windows (Get-AuthenticodeSignature) uses in a subject. */
const WINDOWS_KEY = Object.freeze({ ST: 'S', EMAILADDRESS: 'E', SERIALNUMBER: 'SERIALNUMBER', STREET: 'STREET', GN: 'G', SN: 'SN' });

/**
 * A subject as osslsigncode prints it (RFC 2253 "CN=..,O=..,C=BR", or the old one-line "/C=BR/ST=../CN=..") as a Map
 * in Windows' attribute names.
 */
export function subjectFromOpenssl(subject) {
  const raw = String(subject || '').trim();
  let map;
  if (raw.startsWith('/')) {
    map = new Map();
    for (const part of raw.slice(1).split('/')) {
      const at = part.indexOf('=');
      if (at > 0) map.set(part.slice(0, at), part.slice(at + 1));
    }
  } else {
    map = parseDn(raw);
  }
  const out = new Map();
  for (const [key, value] of map) out.set(WINDOWS_KEY[key.toUpperCase()] || key.toUpperCase(), value);
  return out;
}

/** The subject in the form Windows prints it (most specific first), for the publisher-name setting. */
export function windowsSubjectText(map) {
  const order = ['CN', 'O', 'OU', 'L', 'S', 'C', 'E', 'SERIALNUMBER', 'STREET'];
  const keys = [...map.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys.map(key => `${key}=${/[,;+"\\]/.test(map.get(key)) ? `"${map.get(key).replace(/"/g, '\\"')}"` : map.get(key)}`).join(', ');
}

/**
 * Whether electron-updater would accept a signer subject for these publisher names (NsisUpdater → verifySignature):
 * a full DN must match on every attribute it names, a plain name must equal the CN.
 */
export function publisherMatches(publisherNames, subject) {
  const map = subject instanceof Map ? subject : subjectFromOpenssl(subject);
  for (const name of publisherNames) {
    const dn = parseDn(name);
    if (dn.size) {
      if ([...dn.keys()].every(key => dn.get(key) === map.get(key))) return { ok: true, name, cnOnly: false };
    } else if (name === map.get('CN')) {
      return { ok: true, name, cnOnly: true };
    }
  }
  return { ok: false, name: null, cnOnly: false };
}

/**
 * What osslsigncode verify printed: { succeeded, signatureOk, digestMatches, timestamped, subject, problems[] }.
 * Every check must pass in `full` mode; `integrity` accepts a certificate chain this Mac cannot trust (no CA file).
 */
export function parseVerifyOutput(output, { status = 0, mode = 'full' } = {}) {
  const out = String(output || '');
  const current = /Current message digest\s*:\s*([0-9A-Fa-f]+)/.exec(out)?.[1]?.toLowerCase() || null;
  const calculated = /Calculated message digest\s*:\s*([0-9A-Fa-f]+)/.exec(out)?.[1]?.toLowerCase() || null;
  const result = {
    succeeded: status === 0 && /^Succeeded\s*$/m.test(out),
    signatureOk: /^Signature verification: ok\s*$/m.test(out) && !/^Signature verification: failed/m.test(out),
    digestMatches: !!current && current === calculated,
    // A countersignature is there ("Countersignatures: / Timestamp time:"), and its signer verified.
    timestamped: !/Timestamp is not available/.test(out) && (/Countersignatures:\s*\n\s*Timestamp time:/.test(out) || /Timestamp Server Signature verification:/.test(out)),
    timestampVerified: /Timestamp Server Signature verification: ok/.test(out),
    subject: /Signer #0:\s*\n\s*Subject:\s*([^\n]+)/.exec(out)?.[1]?.trim() || null,
    problems: [],
  };
  if (/No signature found/i.test(out)) result.problems.push('the file has no signature');
  if (!result.digestMatches) result.problems.push(current ? 'the file\'s digest does not match its signature' : 'osslsigncode printed no message digest');
  if (!result.timestamped) result.problems.push('no RFC 3161 timestamp');
  else if (mode === 'full' && !result.timestampVerified) result.problems.push('the timestamp did not verify (set SYNABUN_WIN_SIGN_TSA_CA_FILE to the timestamp authority\'s root)');
  if (!result.subject) result.problems.push('osslsigncode printed no signer');
  if (mode === 'full') {
    if (!result.signatureOk) result.problems.push('the signature or its certificate chain did not verify (set SYNABUN_WIN_SIGN_CA_FILE to the issuing root)');
    if (!result.succeeded) result.problems.push(`osslsigncode did not succeed (exit ${status})`);
  }
  return result;
}

// ── app-update.yml ──

/** electron-updater's settings for an installed copy: the feed, its cache folder and, when signed, the publisher. */
export function appUpdateYml({ feedUrl, cacheDir = 'synabun-updater', publisherNames = [] }) {
  let out = `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: ${cacheDir}\n`;
  if (publisherNames.length) out += `publisherName:\n${publisherNames.map(name => `  - ${JSON.stringify(name)}`).join('\n')}\n`;
  return out;
}

/** The publisher names a build writes into app-update.yml: only for a Windows build that really signs. */
export function publisherNamesForBuild(plan, platform) {
  return platform === 'win32' && plan.enabled && !plan.dryRun ? plan.publisherNames : [];
}

// ── electron-builder ──

/**
 * What the `win` configuration gets for this plan: the hook as signtoolOptions.sign, one digest (electron-builder
 * calls a custom hook once per digest algorithm; the default is sha1 then sha256), and the publisher names. null when
 * nothing signs, so an unsigned build's configuration does not change at all.
 */
export function builderSigningOptions(plan, hookFile = HOOK_FILE) {
  if (!plan.enabled) return null;
  return {
    signExts: [...SIGN_EXTENSIONS],
    signtoolOptions: {
      sign: hookFile,
      signingHashAlgorithms: ['sha256'],
      publisherName: plan.publisherNames,
    },
    // electron-updater's code-signature check of the next update follows app-update.yml (written by the payload).
    verifyUpdateCodeSignature: true,
  };
}

/** One line for the build log about what this build does. */
export function planSummary(plan) {
  if (!plan.enabled) return 'Windows signing: off (no SYNABUN_WIN_SIGN_PROVIDER): the installer and SynaBun.exe stay unsigned, and Windows SmartScreen will warn';
  const who = plan.store ? `${plan.store.type}${plan.store.alias ? ` ${plan.store.alias}` : ''}` : plan.provider;
  return `Windows signing: ${plan.provider} (${who}), timestamp ${plan.timestampUrls.join(', ')}, verify ${plan.verifyMode}, publisher ${plan.publisherNames.join(' | ')}${plan.dryRun ? ' — DRY RUN: commands are printed, nothing is signed' : ''}`;
}

/** The tools on this machine: { problems[] } (jsign, Java for a jar, osslsigncode, the CA files). */
export function checkTools(plan, { exists = existsSync } = {}) {
  const problems = [];
  if (!plan.enabled) return { problems };
  if (plan.jsign && !exists(plan.jsign)) problems.push(`jsign not found at ${plan.jsign} (brew install jsign, or download jsign-<version>.jar from https://github.com/ebourg/jsign/releases)`);
  if (plan.jsign.toLowerCase().endsWith('.jar') && plan.java.includes(sep) && !exists(plan.java)) problems.push(`java not found at ${plan.java} (SYNABUN_WIN_SIGN_JAVA or JAVA_HOME)`);
  if (plan.osslsigncode && !exists(plan.osslsigncode)) problems.push(`osslsigncode not found at ${plan.osslsigncode} (brew install osslsigncode)`);
  for (const file of [plan.caFile, plan.tsaCaFile]) if (file && !exists(file)) problems.push(`CA file not found: ${file}`);
  if (plan.store?.certfile && !exists(plan.store.certfile)) problems.push(`certificate chain not found: ${plan.store.certfile}`);
  if (plan.store?.type === 'PKCS11' && plan.store.keystore && !plan.store.keystore.startsWith('--') && !exists(plan.store.keystore)) problems.push(`SunPKCS11 configuration not found: ${plan.store.keystore}`);
  const library = /library=([^\\]+)/.exec(plan.store?.keystore || '')?.[1];
  if (library && !exists(library)) problems.push(`PKCS#11 module not found: ${library}`);
  return { problems };
}

// ── Signing one file ──

const defaultRun = (file, args, { env }) => {
  const result = spawnSync(file, args, { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  return { status: result.status ?? (result.error ? -1 : 0), stdout: result.stdout || '', stderr: result.stderr || (result.error ? String(result.error.message) : '') };
};

/**
 * Verify one signed file: the PE carries a PKCS#7 signature, osslsigncode accepts it (digest, signature, chain unless
 * `integrity`, timestamp) and its signer is a publisher name electron-updater will accept. Throws with a redacted
 * message on any failure.
 */
export function verifySigned(plan, target, { run = defaultRun, env = process.env, log = () => {}, readPe = authenticodeInfo } = {}) {
  const redact = createRedactor(env);
  const pe = /\.(ps1|psm1|vbs|js|msi)$/i.test(target) ? null : readPe(target);
  if (!/\.(ps1|psm1|vbs|js|msi)$/i.test(target) && !pe?.signed) throw new Error(`${basename(target)} carries no Authenticode signature after signing`);
  const command = verifyCommand(plan, target);
  const result = run(command.file, command.args, { env: childEnvironment(env) });
  const output = `${result.stdout}\n${result.stderr}`;
  const verdict = parseVerifyOutput(output, { status: result.status, mode: plan.required ? 'full' : plan.verifyMode });
  const subject = verdict.subject ? subjectFromOpenssl(verdict.subject) : new Map();
  if (verdict.subject) {
    const match = publisherMatches(plan.publisherNames, subject);
    if (!match.ok) verdict.problems.push(`signed by "${windowsSubjectText(subject)}", which ${PUBLISHER_ENV} does not name: installed copies would refuse this update`);
    else if (match.cnOnly) log(`warning: ${PUBLISHER_ENV} "${match.name}" matches the CN only; give the full subject "${windowsSubjectText(subject)}"`);
  }
  if (verdict.problems.length) {
    throw new Error(redact(`${basename(target)}: the signature did not verify: ${verdict.problems.join('; ')}\n${output.trim().split('\n').slice(-25).join('\n')}`));
  }
  if (plan.verifyMode === 'integrity' && !plan.required) log(`warning: ${basename(target)}: certificate chain not checked (SYNABUN_WIN_SIGN_VERIFY=integrity)`);
  return { subject: windowsSubjectText(subject), timestamped: verdict.timestamped };
}

/**
 * Sign one file with the plan's provider, then verify it. In a dry run the command is printed (redacted) and nothing
 * runs. Returns { signed, kind, subject? }.
 */
export function signFile(plan, target, { run = defaultRun, env = process.env, log = () => {}, readPe = authenticodeInfo } = {}) {
  const policy = signPolicy(target);
  if (!plan.enabled) return { signed: false, kind: policy.kind, reason: 'signing off' };
  if (!policy.sign) return { signed: false, kind: policy.kind, reason: policy.reason };
  const redact = createRedactor(env);
  const command = jsignCommand(plan, target, env);
  if (plan.dryRun) {
    log(`dry run: would sign ${policy.kind} ${basename(target)}: ${describeCommand(command, redact)}`);
    log(`dry run: would verify: ${describeCommand(verifyCommand(plan, target), redact)}`);
    return { signed: false, kind: policy.kind, dryRun: true };
  }
  // asar-unpacked metadata records the script's signed size. Never change its bytes in the post-pack sweep.
  if (isPowerShell(target) && /# SIG # Begin signature block/.test(readFileSync(target, 'utf8'))) {
    const verified = verifySigned(plan, target, { run, env, log, readPe });
    return { signed: true, kind: policy.kind, reused: true, subject: verified.subject };
  }
  // Ours must use our publisher. Native dependencies already signed by a vendor stay byte-for-byte intact.
  if (['native', 'helper'].includes(policy.kind) && readPe(target)?.signed) {
    const command = verifyCommand(plan, target);
    const result = run(command.file, command.args, { env: childEnvironment(env) });
    if (result.status !== 0 || !/^Signature verification: ok\s*$/m.test(`${result.stdout}\n${result.stderr}`))
      throw new Error(redact(`${target}: existing vendor signature cannot be verified; refusing to overwrite it`));
    return { signed: true, kind: policy.kind, vendor: true };
  }
  log(`signing ${policy.kind} ${basename(target)} (${plan.provider})`);
  const result = run(command.file, command.args, { env: command.env });
  if (result.status !== 0) {
    throw new Error(redact(`${basename(target)}: jsign failed (exit ${result.status}): ${`${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-20).join('\n')}`));
  }
  const verified = verifySigned(plan, target, { run, env, log, readPe });
  log(`signed and verified ${basename(target)}: ${verified.subject}, timestamped`);
  return { signed: true, kind: policy.kind, subject: verified.subject };
}

/**
 * The release audit's check of a finished Windows build (scripts/release/lib/artifact-audit.mjs): when signing was
 * configured, the installer and our executables carry signatures and app-update.yml names the publisher.
 * `installer` / `executables` are { signed } readings of the PE headers. Pure.
 */
export function signedBuildProblems(plan, { installer = null, executables = {}, appUpdate = '' } = {}) {
  if (plan.problems?.length) return [...plan.problems];
  if (!plan.enabled || plan.dryRun) return [];
  const problems = [];
  if (!installer?.signed) problems.push('the installer is not signed, although Windows signing was configured');
  for (const [rel, info] of Object.entries(executables)) if (!info?.signed) problems.push(`${rel} is not signed, although Windows signing was configured`);
  if (!/^publisherName:\s*$/m.test(appUpdate)) problems.push('app-update.yml names no publisherName: installed copies would not check the next update\'s signature');
  return problems;
}

/** After a build: every file that had to be signed carries a signature (a hook that never ran is caught here). */
export function unsignedOf(paths, { readPe = authenticodeInfo } = {}) {
  return paths.filter(path => !readPe(path)?.signed);
}

// ── Command line: node packaging/lib/win-sign.mjs check | sign <file.exe> | verify <file.exe> ──

async function cli(argv) {
  const [command, file] = argv;
  const plan = windowsSigningPlan(process.env);
  const redact = createRedactor(process.env);
  const say = (line) => console.log(redact(line));
  say(planSummary(plan));
  const tools = checkTools(plan);
  for (const problem of [...plan.problems, ...tools.problems]) say(`  problem: ${problem}`);
  if (command === 'check' || !command) {
    if (plan.enabled) {
      say(`  would run: ${describeCommand(jsignCommand(plan, '<file.exe>', process.env), redact)}`);
      say(`  then:      ${describeCommand(verifyCommand(plan, '<file.exe>'), redact)}`);
      if (!plan.problems.length && !tools.problems.length && existsSync(plan.jsign)) {
        try {
          const java = plan.jsign.toLowerCase().endsWith('.jar');
          const version = execFileSync(java ? plan.java : plan.jsign, java ? ['-jar', plan.jsign, '--help'] : ['--help'], { encoding: 'utf8', env: childEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
          say(`  jsign answers: ${version.split('\n').find(line => /jsign/i.test(line))?.trim() || 'ok'}`);
        } catch (error) {
          say(`  problem: jsign did not run: ${String(error.message).split('\n')[0]}`);
          return 1;
        }
      }
    }
    say(`  app-update.yml would say:\n${appUpdateYml({ feedUrl: '<feed>', publisherNames: publisherNamesForBuild(plan, 'win32') }).replace(/^/gm, '    ')}`);
    return plan.problems.length || tools.problems.length ? 1 : 0;
  }
  if ((command === 'sign' || command === 'verify') && file) {
    if (!plan.enabled) { say('nothing to do: signing is off'); return 1; }
    if (plan.problems.length || tools.problems.length) return 1;
    // A copy named like the installer is signed by the same rules; any .exe is accepted here, by name, for a test.
    const log = (line) => say(`  ${line}`);
    try {
      if (command === 'verify') {
        const verified = verifySigned(plan, file, { log });
        say(`  ok: ${verified.subject}`);
      } else {
        // The same rules as a build: only a file named like one of ours is signed (copy a test .exe to SynaBun-test-setup.exe).
        const policy = signPolicy(file);
        if (!policy.sign) { say(`  not signed: ${policy.reason}; name a test copy SynaBun-test-setup.exe`); return 1; }
        const outcome = signFile(plan, file, { log });
        say(`  ${outcome.signed ? 'signed and verified' : 'dry run: nothing signed'}`);
      }
      return 0;
    } catch (error) {
      say(`  failed: ${error.message}`);
      return 1;
    }
  }
  say('usage: node packaging/lib/win-sign.mjs check | sign <SynaBun-…-setup.exe> | verify <file.exe>');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

