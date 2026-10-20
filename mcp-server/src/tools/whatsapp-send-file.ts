import { z } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ni from '../services/neural-interface.js';
import { callerBrainCredential, callerRole } from '../services/identity.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// whatsapp_send_file — a local file to the owner, in the WhatsApp conversation
// ═══════════════════════════════════════════
//
// In the role-gated `agents` group (profiles.ts ROLE_GATED_GROUPS): advertised
// to assistant brains only, and the handler refuses any other caller. One
// POST to /api/assistant/whatsapp/send-file (neural-interface/lib/assistant-api.js)
// carrying the brain's own credential (identity.ts callerBrainCredential), which
// the server resolves to the WhatsApp conversation; the WhatsApp host checks and
// reads the file (neural-interface/lib/whatsapp/local-file.js). Never retried:
// a timeout may come after WhatsApp took the file. No recipient, no session id.

export const WHATSAPP_SEND_FILE_DENIED = 'whatsapp_send_file is only available to the SynaBun assistant runtime.';

export const WHATSAPP_SEND_AS = ['auto', 'document', 'image', 'video', 'audio'] as const;

export const whatsappSendFileSchema = {
  path: z.string().min(1).max(2048).describe('Absolute path of an existing regular file on this computer. No URL or network share.'),
  caption: z.string().max(1024).optional().describe('Text shown under the file (at most 1024 characters). Audio has none: leave it out, or choose as "document".'),
  as: z.enum(WHATSAPP_SEND_AS).optional().describe(
    'Default "auto": JPEG/PNG/WebP as a photo, MP4 as a video, OGG/Opus/MP3/M4A as audio, everything else as a document. "document" sends the original file as it is. Photos, videos and audio over 16 MiB go as documents; nothing over 100 MiB is sent. A native form that does not match the extension is refused.'
  ),
};

export const whatsappSendFileDescription = 'Send a file already on this computer as a real WhatsApp attachment to the owner, in THIS WhatsApp conversation. Use it only when the user asked you to send a file (a generated image or video they asked for included: take its local path from the worker result\'s media). Only the active WhatsApp conversation\'s own Assistant can use it: never workers, desktop chats or other contacts; there is no recipient or session parameter. Sensitive places (keys, credentials, browser and app data, SynaBun\'s own data) are refused, and links are resolved and checked too. Returns the delivery id, type, mimetype, size, file name and canonical path, or a clear error code. An answer with uncertain: true (a timeout, a lost answer), or a call of yours that times out, means delivery is uncertain: never retry it on your own.';

export type WhatsAppSendFileArgs = z.infer<z.ZodObject<typeof whatsappSendFileSchema>>;

/** Role guard, one request, never throws: every failure reaches the brain as data. */
export async function handleWhatsAppSendFile(args: WhatsAppSendFileArgs): Promise<ReturnType<typeof text>> {
  if (callerRole() !== 'assistant') return text(WHATSAPP_SEND_FILE_DENIED);
  try {
    const body: { path: string; caption?: string; as?: string } = { path: args.path };
    if (typeof args.caption === 'string') body.caption = args.caption;
    if (typeof args.as === 'string') body.as = args.as;
    return text(JSON.stringify(await ni.whatsappSendFile(body, callerBrainCredential()), null, 2));
  } catch (err) {
    return text(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), code: 'WHATSAPP_SEND_FILE_ERROR' }));
  }
}

/** Registered into the `agents` group (index.ts): the returned handle is gated on the caller role. */
export function registerWhatsAppSendFileTool(server: McpServer) {
  return server.tool('whatsapp_send_file', whatsappSendFileDescription, whatsappSendFileSchema, (args) => handleWhatsAppSendFile(args));
}
