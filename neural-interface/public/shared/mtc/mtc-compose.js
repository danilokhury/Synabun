// Composer decisions; shared file classification/size labels and socket encoding.
import { routeAttachment, formatBytes } from '../assistant/asst-composer.js';
import { base64Of } from '../agy/agy-tabs-logic.js';
import { parseSlash } from '../agy/agy-commands.js';

export { formatBytes };
export const ATTACH_LIMITS = Object.freeze({ maxAttachments: 5, maxBytes: 100_000 });
export const COMMANDS = Object.freeze(['new', 'sessions', 'rename', 'retry', 'copy', 'model', 'plan', 'effort', 'context', 'settings', 'help']);

export function composerState(tab, { connected = true, blocked = false, supported = true } = {}) {
  const running = !!tab?.running;
  const busy = !!tab?.submitting || !!tab?.pendingAttachments;
  const hasContent = !!String(tab?.draft || '').trim() || !!tab?.attachments?.length;
  return { mode: running ? 'stop' : busy ? 'waiting' : 'send', canSend: !running && !busy && !blocked && connected && hasContent,
    canAttach: supported && !running && !busy && !blocked && connected, busy };
}

export async function attachmentProblem(file, staged = [], model = null, limits = ATTACH_LIMITS) {
  if (staged.length >= limits.maxAttachments) return { key: 'attachmentCount', params: { count: limits.maxAttachments } };
  const name = String(file?.name || '');
  const image = String(file?.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|ico|tiff?)$/i.test(name);
  if (image && model?.vision !== true) return { key: 'imageUnsupported' };
  if (file?.size > limits.maxBytes) return { key: 'attachmentSize', params: { size: formatBytes(limits.maxBytes) } };
  const route = await routeAttachment(file);
  if (route !== 'text' && !(image && model?.vision === true && route === 'image')) return { key: 'attachmentType', params: { name } };
  return null;
}

export function attachmentRequest(files = []) {
  return files.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, data: base64Of(dataUrl) }));
}

export function commandFor(text) {
  const parsed = parseSlash(text);
  return parsed && COMMANDS.includes(parsed.name) ? parsed : null;
}
export function commandHints(text) {
  const match = /^\/(\w*)$/.exec(String(text || ''));
  return match ? COMMANDS.filter((name) => name.startsWith(match[1].toLowerCase())) : [];
}
