// Small attachments use the same base64 prompt envelope as the Antigravity panel.
// Nothing is opened by path or executed. Validation happens before history is changed.
import { sanitizeAttachmentName, normalizeAttachmentMime } from '../assistant-attachments.js';

export const MARITACA_ATTACHMENT_LIMITS = Object.freeze({ maxAttachments: 5, maxBytes: 100_000, maxPromptChars: 200_000 });
const TEXT_EXT = /(?:^|\.)(?:txt|md|mdx|js|ts|jsx|tsx|mjs|cjs|mts|cts|json|jsonl|html|css|scss|less|xml|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|env|gitignore|dockerignore|sql|graphql|proto|csv|tsv|log|diff|patch|vue|svelte|astro|rst|tex|lua|r|swift|kt|dockerfile|makefile|cmake|gradle|bat|ps1|fish)$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|heic|bmp|ico|tiff?)$/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };

export function inlineMaritacaAttachments(text, files = [], { vision = false, limits = MARITACA_ATTACHMENT_LIMITS } = {}) {
  if (!Array.isArray(files)) fail('ATTACHMENT_DATA', 'Attachments must be a list.');
  if (files.length > limits.maxAttachments) fail('ATTACHMENT_COUNT', `At most ${limits.maxAttachments} attachments per message.`);
  const blocks = [], attachments = [], images = [];
  for (const file of files) {
    const name = sanitizeAttachmentName(file?.name);
    const mimeType = normalizeAttachmentMime(file?.mimeType);
    const image = mimeType.startsWith('image/') || IMAGE_EXT.test(name);
    if (image && !vision) fail('IMAGE_UNSUPPORTED', 'This model does not read images. Attach a text or code file instead.');
    const data = file?.data;
    if (typeof data !== 'string' || data.length > Math.ceil(limits.maxBytes / 3) * 4) fail('ATTACHMENT_SIZE', `Each file must be at most ${limits.maxBytes} bytes.`);
    if (data && (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))) fail('ATTACHMENT_DATA', 'An attachment arrived damaged.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > limits.maxBytes) fail('ATTACHMENT_SIZE', `Each file must be at most ${limits.maxBytes} bytes.`);
    if (bytes.toString('base64') !== data) fail('ATTACHMENT_DATA', 'An attachment arrived damaged.');
    if (image) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) fail('ATTACHMENT_TYPE', 'This image type is not supported.');
      images.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } });
    } else {
      if (!(TEXT_EXT.test(name) || !name.includes('.') || mimeType.startsWith('text/') || /application\/(json|xml|javascript|x-yaml)/.test(mimeType))) fail('ATTACHMENT_TYPE', 'Attach a text or code file.');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('ATTACHMENT_BINARY', 'Attachments must contain UTF-8 text.'); }
      if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) fail('ATTACHMENT_BINARY', 'Binary files cannot be included as text.');
      // A fence longer than any run in the file keeps nested markdown/code literal.
      const fence = '`'.repeat([...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length + 1), 3));
      blocks.push(`File: ${name}\n${fence}\n${content}\n${fence}`);
    }
    attachments.push({ name, mimeType, size: bytes.length });
  }
  const attachmentText = blocks.join('\n\n');
  const content = [text, attachmentText].filter(Boolean).join('\n\n');
  if (!content.trim() && !images.length) fail('PROMPT_EMPTY', 'Type something or attach a file first.');
  if (content.length > limits.maxPromptChars) fail('PROMPT_TOO_LONG', `The message including files is longer than ${limits.maxPromptChars} characters.`);
  return { content, displayText: text, attachmentText, attachments, images };
}
