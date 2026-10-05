// SynaBun WhatsApp connector entry. installer.js copies this file into
// DATA_HOME/runtime/whatsapp next to the node_modules it installs from the
// pinned package-lock.json, so these imports resolve from the runtime's own
// dependencies — never from SynaBun's. Only lib/whatsapp/baileys-adapter.js
// imports it, and only inside the WhatsApp host process.

import { createRequire } from 'node:module';

export {
  makeWASocket,
  DisconnectReason,
  Browsers,
  BufferJSON,
  initAuthCreds,
  proto,
  jidNormalizedUser,
  jidDecode,
  downloadMediaMessage,
  normalizeMessageContent,
  getContentType,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';

export const BAILEYS_VERSION = createRequire(import.meta.url)('baileys/package.json').version;
