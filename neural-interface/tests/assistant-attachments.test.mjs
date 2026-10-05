import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { createAssistantApi } from '../lib/assistant-api.js';
import {
  ATTACHMENT_MAX_BYTES, attachmentSessionFolder, createAttachmentStore, normalizeAttachmentMime, sanitizeAttachmentName, tooLargeMessage,
} from '../lib/assistant-attachments.js';
import { attachmentPromptLine, buildPromptText, formatBytes, routeAttachment } from '../public/shared/assistant/asst-composer.js';

const MB = 1024 * 1024;
const root = join(import.meta.dirname, '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** Every file under `dir`, relative, sorted. */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(dir.length + 1))
    .sort();
}

function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-attachments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'attachments');
}

/** A File-shaped stand-in for sizes too big to allocate (routing reads size, type and name only). */
const sized = (name, type, size) => ({ name, type, size, slice: () => { throw new Error('must not be read'); } });

// ── Composer routing (addFile → routeAttachment) ─────────────────────────────

test('images the models take go inline; oversized and other image types upload', async () => {
  assert.equal(await routeAttachment(new File([new Uint8Array(1024)], 'shot.png', { type: 'image/png' })), 'image');
  assert.equal(await routeAttachment(new File([new Uint8Array(10)], 'photo.jpg', { type: 'image/jpeg' })), 'image');
  assert.equal(await routeAttachment(sized('huge.png', 'image/png', 9 * MB)), 'upload', 'over the 8 MB image cap uploads instead of being refused');
  assert.equal(await routeAttachment(sized('phone.heic', 'image/heic', 2 * MB)), 'upload', 'image types no brain takes as image data upload');
  // SVG is XML: inlined as text instead of image data the APIs refuse.
  assert.equal(await routeAttachment(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' })), 'text');
});

test('small text files go inline; oversized text uploads', async () => {
  assert.equal(await routeAttachment(new File(['# notes\n'], 'notes.md', { type: 'text/markdown' })), 'text');
  assert.equal(await routeAttachment(new File(['all: build\n'], 'Makefile', { type: '' })), 'text', 'extension-less text stays inline');
  assert.equal(await routeAttachment(new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' })), 'text');
  assert.equal(await routeAttachment(new File(['x'.repeat(400 * 1024 + 1)], 'big.log', { type: 'text/plain' })), 'upload', 'over 400 KB uploads instead of being refused');
});

test('every other file uploads — PDF, Office, archives, audio, video', async () => {
  for (const [name, type] of [
    ['report.pdf', 'application/pdf'],
    ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['bundle.zip', 'application/zip'],
    ['voice.m4a', 'audio/mp4'],
    ['clip.mov', 'video/quicktime'],
    ['mystery.bin', ''],
  ]) {
    assert.equal(await routeAttachment(new File([new Uint8Array([37, 80, 68, 70, 0, 1])], name, { type })), 'upload', name);
  }
});

test('binary content never goes inline, even under a text-looking name', async () => {
  // Extension-less names count as text; a NUL byte in the first 8 KB says otherwise.
  assert.equal(await routeAttachment(new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1])], 'elf_binary', { type: '' })), 'upload');
  assert.equal(await routeAttachment(new File([new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0])], 'mytool', { type: '' })), 'upload');
  assert.equal(await routeAttachment(new File(['ok\u0000'], 'dump.txt', { type: 'text/plain' })), 'upload');
  // An unreadable file is treated as binary.
  assert.equal(await routeAttachment(new File(['x'], 'notes.txt', { type: 'text/plain' }), { sniff: async () => true }), 'upload');
});

test('files over the 100 MB upload cap are refused before any upload', async () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 100 * MB, 'the composer and the server share one cap');
  assert.equal(await routeAttachment(sized('movie.mp4', 'video/mp4', 100 * MB)), 'upload');
  assert.equal(await routeAttachment(sized('movie.mp4', 'video/mp4', 100 * MB + 1)), 'tooLarge');
  assert.equal(await routeAttachment(sized('server.log', 'text/plain', 150 * MB)), 'tooLarge', 'oversized text is never read');
  assert.equal(await routeAttachment(sized('huge.png', 'image/png', 120 * MB)), 'tooLarge');
});

// ── Prompt framing ──────────────────────────────────────────────────────────

const PDF = { name: 'report.pdf', mime: 'application/pdf', size: 1258291, path: '/home/u/.synabun/data/attachments/assistant-1/20260928-101500-ab12cd34/report.pdf' };

test('an uploaded file becomes one provider-neutral line after the user\'s words', () => {
  const line = 'The user attached a file: report.pdf (application/pdf, 1.2 MB), saved at `/home/u/.synabun/data/attachments/assistant-1/20260928-101500-ab12cd34/report.pdf`. Read it from that path with your file tools; include the path when a worker needs the file.';
  assert.equal(attachmentPromptLine(PDF), line);
  assert.equal(buildPromptText({ text: 'Summarize this', uploads: [PDF] }), `Summarize this\n\n${line}`);
  // No text: the attachment alone is a prompt, so the send goes through.
  assert.equal(buildPromptText({ text: '', uploads: [PDF] }), line);
  assert.equal(attachmentPromptLine({ name: 'blob', size: 12, path: '/x/blob' }).includes('(application/octet-stream, 12 B)'), true);
});

test('several uploads get a line each; inline files, memories and the order stay as they were', () => {
  const zip = { name: 'site.zip', mime: 'application/zip', size: 40 * MB, path: '/a/site.zip' };
  const prompt = buildPromptText({
    text: 'Compare them',
    files: [{ name: 'notes.md', content: '# hi' }],
    memories: [{ id: 'm1', payload: { category: 'dev', content: 'fact' } }],
    uploads: [PDF, zip, { name: 'pending.mov', size: 5 }],
  });
  assert.equal(prompt, [
    '<file path="notes.md">\n# hi\n</file>',
    '<memory id="m1" category="dev">\nfact\n</memory>',
    'Compare them',
    `${attachmentPromptLine(PDF)}\n${attachmentPromptLine(zip)}`,
  ].join('\n\n'));
  assert.match(prompt, /\(application\/zip, 40 MB\)/);
  assert.doesNotMatch(prompt, /pending\.mov/, 'an upload without a saved path is never framed');
  assert.equal(buildPromptText({ text: 'hi' }), 'hi', 'no uploads, no change');
});

test('sizes read like a file manager', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(340 * 1024), '340 KB');
  assert.equal(formatBytes(1.5 * MB), '1.5 MB');
  assert.equal(formatBytes(64 * MB), '64 MB');
});

// ── The attachments store ───────────────────────────────────────────────────

test('names are sanitized: last segment only, no traversal, no reserved or control characters', () => {
  assert.equal(sanitizeAttachmentName('report.pdf'), 'report.pdf');
  assert.equal(sanitizeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeAttachmentName('..\\..\\Windows\\win.ini'), 'win.ini');
  assert.equal(sanitizeAttachmentName('..'), 'attachment');
  assert.equal(sanitizeAttachmentName('/'), 'attachment');
  assert.equal(sanitizeAttachmentName(''), 'attachment');
  assert.equal(sanitizeAttachmentName('.env.local'), 'env.local', 'no hidden files');
  assert.equal(sanitizeAttachmentName('a<b>c:d"e|f?g*h`i.txt'), 'abcdefghi.txt');
  assert.equal(sanitizeAttachmentName('line\nbreak\u0000.txt'), 'linebreak.txt');
  assert.equal(sanitizeAttachmentName('invoice\u202efdp.exe'), 'invoicefdp.exe', 'direction marks cannot disguise an extension');
  assert.equal(sanitizeAttachmentName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeAttachmentName('Quarterly  report (final).pdf '), 'Quarterly report (final).pdf');
  const long = sanitizeAttachmentName(`${'é'.repeat(300)}.xlsx`);
  assert.ok(Buffer.byteLength(long) <= 180, 'fits every file system');
  assert.ok(long.endsWith('.xlsx'), 'keeps the extension');
});

test('session folders and MIME types only take plain values', () => {
  assert.equal(attachmentSessionFolder('assistant-0f8e-11aa'), 'assistant-0f8e-11aa');
  assert.equal(attachmentSessionFolder('../../x'), 'unsorted');
  assert.equal(attachmentSessionFolder('a/b'), 'unsorted');
  assert.equal(attachmentSessionFolder(null), 'unsorted');
  assert.equal(normalizeAttachmentMime('Application/PDF'), 'application/pdf');
  assert.equal(normalizeAttachmentMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(normalizeAttachmentMime('text/html\r\nX-Evil: 1'), 'application/octet-stream');
  assert.equal(normalizeAttachmentMime(''), 'application/octet-stream');
});

test('the store streams to <session>/<upload>/<name>, private, and never overwrites', async (t) => {
  const dir = tmpRoot(t);
  const store = createAttachmentStore({ root: dir, now: () => Date.UTC(2026, 8, 28, 10, 15, 0) });
  const a = await store.save(Readable.from([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2])]), { name: 'report.pdf', sessionId: 'assistant-1', mime: 'application/pdf' });
  const b = await store.save(Readable.from([Buffer.from('second')]), { name: 'report.pdf', sessionId: 'assistant-1' });
  assert.ok(isAbsolute(a.path));
  assert.ok(a.path.startsWith(`${dir}${sep}assistant-1${sep}20260928-101500-`));
  assert.equal(a.name, 'report.pdf');
  assert.equal(a.size, 12);
  assert.equal(a.mime, 'application/pdf');
  assert.equal(b.mime, 'application/octet-stream');
  assert.notEqual(a.path, b.path, 'same name, own folder');
  assert.deepEqual(readFileSync(a.path), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2])]));
  assert.equal(readFileSync(b.path, 'utf8'), 'second');
  if (process.platform !== 'win32') {
    const { statSync } = await import('node:fs');
    assert.equal(statSync(a.path).mode & 0o777, 0o600, 'readable by the owner only, never executable');
  }
});

test('the store stops past its cap and on an aborted upload, leaving nothing behind', async (t) => {
  const dir = tmpRoot(t);
  const store = createAttachmentStore({ root: dir, maxBytes: 1024 });
  await assert.rejects(
    store.save(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { name: 'big.bin', sessionId: 's1' }),
    (err) => err.code === 'ATTACHMENT_TOO_LARGE' && err.status === 413,
  );
  const broken = new Readable({ read() {} });
  const saving = store.save(broken, { name: 'half.bin', sessionId: 's1' });
  broken.push(Buffer.alloc(100));
  setImmediate(() => broken.destroy(new Error('aborted')));
  await assert.rejects(saving, /aborted/);
  assert.deepEqual(listFiles(dir), []);
});

// ── POST /api/assistant/attachments ─────────────────────────────────────────

async function startApp(t, { attachments, isGuestRequest = () => false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher: { get: () => null }, attachments, isGuestRequest }));
  const server = await new Promise((resolveListen) => { const s = app.listen(0, '127.0.0.1', () => resolveListen(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant/attachments`;
  return async (body, { name = 'report.pdf', type = 'application/octet-stream', mime = null, session = 'assistant-abc', headers = {} } = {}) => {
    const response = await fetch(`${base}${session ? `?assistantSessionId=${encodeURIComponent(session)}` : ''}`, {
      method: 'POST',
      headers: { ...(type ? { 'Content-Type': type } : {}), ...(name != null ? { 'X-Synabun-Filename': encodeURIComponent(name) } : {}), ...(mime ? { 'X-Synabun-Mime': mime } : {}), ...headers },
      body,
    });
    return { status: response.status, json: await response.json() };
  };
}

test('upload saves the bytes and returns the absolute path, name, size and type', async (t) => {
  const dir = tmpRoot(t);
  const post = await startApp(t, { attachments: createAttachmentStore({ root: dir }) });
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
  const { status, json } = await post(bytes, { name: 'Q3 report.pdf', mime: 'application/pdf' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.attachment.name, 'Q3 report.pdf');
  assert.equal(json.attachment.size, bytes.length);
  assert.equal(json.attachment.mime, 'application/pdf');
  assert.ok(isAbsolute(json.attachment.path));
  assert.ok(json.attachment.path.startsWith(`${dir}${sep}assistant-abc${sep}`));
  assert.deepEqual(readFileSync(json.attachment.path), bytes);
});

test('upload sanitizes the name and cannot escape the attachments folder', async (t) => {
  const dir = tmpRoot(t);
  const post = await startApp(t, { attachments: createAttachmentStore({ root: dir }) });
  const escaped = await post(Buffer.from('x'), { name: '../../../../tmp/evil.sh', session: '../../../tmp' });
  assert.equal(escaped.status, 200);
  assert.equal(escaped.json.attachment.name, 'evil.sh');
  assert.ok(escaped.json.attachment.path.startsWith(`${dir}${sep}unsorted${sep}`), escaped.json.attachment.path);
  const dots = await post(Buffer.from('y'), { name: '..' });
  assert.equal(dots.json.attachment.name, 'attachment');
  assert.deepEqual(listFiles(dir).map((f) => f.split(sep).at(-1)).sort(), ['attachment', 'evil.sh']);
});

test('upload enforces the size cap', async (t) => {
  const dir = tmpRoot(t);
  const post = await startApp(t, { attachments: createAttachmentStore({ root: dir, maxBytes: 1024 }) });
  const big = await post(Buffer.alloc(2048));
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'ATTACHMENT_TOO_LARGE');
  assert.equal(big.json.error, 'The file is larger than 1024 bytes');
  assert.equal(tooLargeMessage(ATTACHMENT_MAX_BYTES), 'The file is larger than 100 MB');
  const fits = await post(Buffer.alloc(1024));
  assert.equal(fits.status, 200);
  assert.equal(listFiles(dir).length, 1, 'only the file that fits is on disk');
});

test('upload requires the owner, the octet-stream type and the filename header', async (t) => {
  const dir = tmpRoot(t);
  const post = await startApp(t, { attachments: createAttachmentStore({ root: dir }), isGuestRequest: (req) => req.headers['x-guest'] === '1' });
  const guest = await post(Buffer.from('x'), { headers: { 'X-Guest': '1' } });
  assert.equal(guest.status, 403);
  assert.equal(guest.json.code, 'GUEST_FORBIDDEN');
  // What a cross-site form can send without a preflight: a form type and no custom header.
  const form = await post('a=1', { type: 'application/x-www-form-urlencoded', name: null });
  assert.equal(form.status, 400);
  const text = await post('hello', { type: 'text/plain' });
  assert.equal(text.status, 400);
  assert.equal(text.json.code, 'ATTACHMENT_BAD_REQUEST');
  const noName = await post(Buffer.from('x'), { name: null });
  assert.equal(noName.status, 400);
  assert.deepEqual(listFiles(dir), []);
});

test('upload answers 503 when the server has no attachments store', async (t) => {
  const post = await startApp(t, { attachments: null });
  const { status, json } = await post(Buffer.from('x'));
  assert.equal(status, 503);
  assert.equal(json.code, 'ATTACHMENTS_UNAVAILABLE');
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('the paperclip takes any file and the panel uploads with the session id', () => {
  const composer = read('public/shared/assistant/asst-composer.js');
  const panel = read('public/shared/assistant/asst-panel.js');
  const server = read('server.js');
  assert.match(composer, /<input type="file" class="asst-file-input" multiple hidden tabindex="-1">/, 'no accept filter');
  assert.match(composer, /const route = await routeAttachment\(file\);/, 'addFile routes every picked and dropped file');
  assert.match(composer, /if \(uploading\(\)\) \{ hooks\.onToast/, 'send waits for uploads');
  assert.match(panel, /uploadFile: \(file, opts\) => uploadAssistantAttachment\(file, \{ \.\.\.opts, sessionId \}\)/);
  assert.match(panel, /files: \[\.\.\.\(payload\.files \|\| \[\]\), \.\.\.\(payload\.uploads \|\| \[\]\)\]/, 'sent uploads show as file chips');
  assert.match(server, /attachments: createAttachmentStore\(\{ root: resolve\(DATA_HOME, 'data', 'attachments'\) \}\)/);
});
