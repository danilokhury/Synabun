// Shared session-title rules used by the three sidepanels and the server.
// Generated titles are intentionally identifier-like: one PascalCase token,
// ASCII only, and short enough to stay readable in tray pills.

export const SESSION_TITLE_MAX_LENGTH = 32;
export const SESSION_TITLE_PATTERN = /^[A-Z][A-Za-z0-9]{0,31}$/;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'build', 'can', 'could', 'create',
  'do', 'for', 'from', 'help', 'how', 'i', 'in', 'is', 'it', 'make', 'me', 'my',
  'of', 'on', 'or', 'please', 'something', 'that', 'the', 'this', 'to', 'update',
  'we', 'when', 'where', 'with', 'would', 'you',
]);

function asciiWords(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function pascalPart(word) {
  const value = String(word || '').replace(/[^A-Za-z0-9]/g, '');
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function unwrapCandidate(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  value = value.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') value = parsed;
    else if (parsed && typeof parsed.title === 'string') value = parsed.title;
  } catch {}
  const firstLine = value.split(/\r?\n/).find((line) => line.trim()) || '';
  return firstLine
    .replace(/^\s*(?:title|name)\s*:\s*/i, '')
    .replace(/^[`'"\s]+|[`'".,;:!?\s]+$/g, '')
    .trim();
}

export function normalizeSessionTitle(raw, fallback = '') {
  const words = asciiWords(unwrapCandidate(raw));
  let title = words.map(pascalPart).join('');
  if (title && !/^[A-Za-z]/.test(title)) title = `Session${title}`;
  title = title.slice(0, SESSION_TITLE_MAX_LENGTH);
  if (SESSION_TITLE_PATTERN.test(title)) return title;
  if (fallback && fallback !== raw) return normalizeSessionTitle(fallback);
  return '';
}

export function fallbackSessionTitle(prompt, { paths = [], hasImages = false } = {}) {
  const promptWords = asciiWords(prompt);
  const meaningful = promptWords.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  const selected = (meaningful.length ? meaningful : promptWords).slice(0, 3);
  let title = normalizeSessionTitle(selected.join(' '));

  if (!title && Array.isArray(paths) && paths.length) {
    const lastPath = String(paths[0] || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const stem = lastPath.replace(/\.[^.]+$/, '');
    title = normalizeSessionTitle(`${stem} Review`);
  }
  if (!title && hasImages) title = 'ImageSession';
  return title || 'NewSession';
}

export function isValidSessionTitle(value) {
  return SESSION_TITLE_PATTERN.test(String(value || ''));
}

export async function requestGeneratedSessionTitle(input, options = {}) {
  const fallback = fallbackSessionTitle(input?.prompt, {
    paths: input?.paths,
    hasImages: !!input?.hasImages,
  });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { title: fallback, source: 'fallback' };

  try {
    const response = await fetchImpl('/api/sidepanel/session-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
      signal: options.signal,
    });
    if (!response?.ok) throw new Error(`Session title request failed (${response?.status || 'unknown'})`);
    const data = await response.json();
    const title = normalizeSessionTitle(data?.title);
    return title
      ? { title, source: data?.source === 'agent' ? 'agent' : 'fallback' }
      : { title: fallback, source: 'fallback' };
  } catch {
    return { title: fallback, source: 'fallback' };
  }
}
