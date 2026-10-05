// Pure, bounded presentation logic shared by assistant answers and tool cards.
export const OUTPUT_LIMITS = Object.freeze({ input: 200000, raw: 24000, unbrokenRun: 512, pathChars: 60, value: 8000, nodes: 2000, depth: 4, array: 12, diffPreview: 60, diffLines: 2000, files: 100 });

export function boundedText(value, limit = OUTPUT_LIMITS.raw) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n… Truncated (${text.length.toLocaleString()} characters; showing ${limit.toLocaleString()}).` : text;
}

export function jsonAnswer(text) {
  const original = String(text ?? '');
  if (original.length > OUTPUT_LIMITS.input) return { kind: 'oversized', raw: boundedText(original) };
  let source = original.trim();
  if (!/^[{[]/.test(source)) return null;
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object') return null;
    return { kind: 'json', value, raw: source };
  } catch { return null; }
}

export function looksLikeStreamingJson(text) {
  const source = String(text ?? '').trimStart();
  return /^\{/.test(source) || /^\[\s*(?:[\[{"\d-]|true\b|false\b|null\b|$)/.test(source);
}

export function prettyJsonFences(text) {
  const source = String(text ?? '');
  if (source.length > OUTPUT_LIMITS.input) return boundedText(source);
  return source.replace(/^(`{3,}|~{3,})(json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gim, (whole, fence, tag, body) => {
    const parsed = jsonAnswer(body);
    return parsed?.kind === 'json' ? `${fence}${tag || ''}\n${readableStructuredValue(parsed.value)}\n${fence}` : whole;
  });
}

// Bound tokens, hashes and other whitespace-free runs without changing wordy prose.
export function hasOverlongRun(text) {
  return new RegExp(`\\S{${OUTPUT_LIMITS.unbrokenRun + 1},}`).test(String(text ?? '').slice(0, OUTPUT_LIMITS.input));
}

export function outputOverflows(scrollHeight, clientHeight) {
  return clientHeight > 0 && scrollHeight > clientHeight + 1;
}

export function displayDiffPath(path, cwd = '', maxChars = OUTPUT_LIMITS.pathChars) {
  const full = String(path ?? '');
  const directory = String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '');
  const normalized = full.replace(/\\/g, '/');
  const sameRoot = /^[A-Z]:/i.test(directory) ? normalized.toLowerCase().startsWith(directory.toLowerCase() + '/') : normalized.startsWith(directory + '/');
  const relative = directory && sameRoot ? normalized.slice(directory.length + 1) : full;
  if (relative.length <= maxChars) return relative;
  const slash = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\'));
  const filename = relative.slice(slash + 1);
  if (slash < 0) return relative; // Never cut a filename, even in a very narrow panel.
  const tail = '/' + filename;
  const room = Math.max(0, maxChars - tail.length - 1);
  const prefix = Math.ceil(room / 2), suffix = Math.floor(room / 2);
  return relative.slice(0, prefix) + '…' + (suffix ? relative.slice(slash - suffix, slash) : '') + tail;
}

// Several consecutive matching lines; never match ordinary lists/headings/fences.
export function isPreformattedText(text) {
  const source = String(text ?? '').slice(0, OUTPUT_LIMITS.input);
  if (/^\s*(?:```|~~~)/m.test(source)) return false;
  const lines = source.split(/\r?\n/);
  const patterns = [
    line => /^\s*[│├└]─?|^\s*[│ ]*[├└]──/.test(line),
    line => /^\s+(?:at\s+\S|File "|\S+Error:)|^\s*\S+\.(?:js|py|ts):\d+/.test(line),
    line => /^(?:\[?\d{2}:\d{2}:\d{2}|\d{4}-\d\d-\d\d[T ]|\[(?:INFO|WARN|ERROR|DEBUG)\]|(?:INFO|WARN|ERROR|DEBUG)\b)/.test(line),
    line => /^[\w./-]+:[ \t]*(?:\S.*)?$/.test(line),
    line => /^(?: {4,}|\t)\S/.test(line) && !/^\s*(?:[-*+] |\d+[.)] )/.test(line),
    line => /\S[ \t]{2,}\S.*\S[ \t]{2,}\S/.test(line) && !/^\s*(?:[-*+>#]|\d+[.)] )/.test(line),
  ];
  if (patterns.some(matches => {
    let consecutive = 0;
    return lines.some(line => { consecutive = matches(line) ? consecutive + 1 : 0; return consecutive >= 3; });
  })) return true;
  let offset = -1, consecutive = 0;
  return lines.some(line => {
    const columns = line.match(/^(\S+)[ \t]{2,}([\w./:+-]+(?:[ \t][\w./:+-]+)*)$/);
    const next = columns ? columns[1].length : -1;
    consecutive = next >= 0 ? next === offset ? consecutive + 1 : 1 : 0;
    offset = next;
    return consecutive >= 3;
  });
}

export function cleanTerminal(value) {
  let text = String(value ?? '');
  const oversized = text.length > OUTPUT_LIMITS.input;
  text = text.slice(0, OUTPUT_LIMITS.input)
    // OSC (including links), DCS/PM/APC, CSI, and single-character escapes.
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b(?:[()][0-2A-Z]|[ -/]*[@-~])/g, '')
    .replace(/\r\n/g, '\n');
  const result = [];
  let line = [];
  let carriage = false;
  for (const char of text) {
    if (char === '\r') carriage = true;
    else if (char === '\b') line.pop();
    else if (char === '\n') { result.push(line.join('')); line = []; carriage = false; }
    else if (char === '\t' || char >= ' ' && !/[\x7f-\x9f]/.test(char)) { if (carriage) { line = []; carriage = false; } line.push(char); }
  }
  result.push(line.join(''));
  return result.join('\n') + (oversized ? '\n… Terminal input truncated at 200,000 characters.' : '');
}

// Build a model before making DOM nodes. A global budget handles wide/deep payloads.
export function structuredValueModel(input) {
  let value = input;
  const parsed = typeof input === 'string' ? jsonAnswer(input) : null;
  if (parsed?.kind === 'oversized') return { kind: 'raw', text: parsed.raw };
  if (parsed?.kind === 'json') value = parsed.value;
  let budget = OUTPUT_LIMITS.nodes;
  const seen = new Set();
  const build = (entry, depth) => {
    if (--budget < 0) return { kind: 'raw', text: '… Structure truncated at 2,000 values.' };
    if (entry === null || typeof entry !== 'object') return { kind: 'scalar', type: entry === null ? 'null' : typeof entry, text: boundedText(entry === null ? 'null' : entry === '' ? '""' : entry, OUTPUT_LIMITS.value) };
    if (seen.has(entry)) return { kind: 'raw', text: '[Circular reference]' };
    seen.add(entry);
    if (depth >= OUTPUT_LIMITS.depth) {
      // Bounded iterative copy avoids JSON.stringify on an arbitrarily deep object.
      return { kind: 'raw', text: readableStructuredValue(entry, OUTPUT_LIMITS.raw) };
    }
    const array = Array.isArray(entry);
    const keys = array ? null : Object.keys(entry);
    const total = array ? entry.length : keys.length;
    const entries = [];
    for (let i = 0; i < total && budget > 0; i++) {
      const key = array ? i : keys[i];
      entries.push({ key: boundedText(String(key), 1000), value: build(entry[key], depth + 1) });
    }
    seen.delete(entry);
    return { kind: array ? 'array' : 'object', entries, total, truncated: entries.length < total };
  };
  return build(value, 0);
}

export function readableStructuredValue(value, limit = OUTPUT_LIMITS.raw) {
  if (typeof value === 'string') {
    const parsed = jsonAnswer(value);
    if (parsed?.kind === 'json') value = parsed.value;
    else return boundedText(cleanTerminal(value), limit);
  }
  // Iterative traversal bounds depth, size, cycles and even huge individual strings.
  let count = 0;
  let characters = OUTPUT_LIMITS.raw * 2;
  const seen = new Set();
  const clone = entry => {
    if (++count > OUTPUT_LIMITS.nodes) return '… Structure truncated';
    if (typeof entry === 'string') {
      if (characters <= 0) return '… Output truncated';
      const cap = Math.min(OUTPUT_LIMITS.value, characters);
      const text = cleanTerminal(boundedText(entry, cap));
      characters -= Math.min(entry.length, cap);
      return text;
    }
    if (!entry || typeof entry !== 'object') return entry ?? null;
    if (seen.has(entry)) return '[Circular reference]';
    seen.add(entry);
    return Array.isArray(entry) ? [] : {};
  };
  const root = clone(value);
  const work = value && typeof value === 'object' ? [{ src: value, dst: root, depth: 0 }] : [];
  while (work.length && count <= OUTPUT_LIMITS.nodes) {
    const { src, dst, depth } = work.pop();
    for (const key of Object.keys(src)) {
      if (count > OUTPUT_LIMITS.nodes) break;
      const entry = src[key];
      const child = depth >= 12 && entry && typeof entry === 'object' ? '[Depth limit]' : clone(entry);
      // DefineProperty treats __proto__ as data.
      Object.defineProperty(dst, key, { value: child, enumerable: true, configurable: true, writable: true });
      if (entry && typeof entry === 'object' && child && typeof child === 'object') work.push({ src: entry, dst: child, depth: depth + 1 });
    }
  }
  try { return boundedText(JSON.stringify(root, null, 2), limit); }
  catch { return '[Unrenderable value]'; }
}

function patchPath(text, stripPrefix = true) {
  let path = String(text || '').split('\t')[0].trim();
  if (path.startsWith('"')) { try { path = JSON.parse(path); } catch {} }
  return stripPrefix ? path.replace(/^[ab]\//, '') : path;
}

export function parseUnifiedDiff(input, fallback = {}) {
  const raw = String(input ?? '');
  if (raw.length > OUTPUT_LIMITS.input) return [{ ...fallback, path: fallback.path || 'Oversized patch', status: fallback.status || 'modified', lines: [], hunks: [], added: 0, removed: 0, oversized: true, raw }];
  const files = [];
  let file = null, oldLine = null, newLine = null, inHunk = false, oldRemaining = 0, newRemaining = 0;
  const begin = (path = fallback.path || 'Changes') => {
    file = { path, oldPath: fallback.oldPath || path, status: fallback.status || 'modified', lines: [], hunks: [], added: 0, removed: 0, raw: '' };
    files.push(file); oldLine = newLine = null; inHunk = false;
  };
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (files.length >= OUTPUT_LIMITS.files) { files[files.length - 1].filesTruncated = true; break; }
      const paths = line.slice(11).match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
      begin(patchPath(paths[1] || paths[0])); file.oldPath = patchPath(paths[0]);
    } else if (!file) begin();
    else if (line.startsWith('--- ') && !inHunk && file.hunks.length) begin();
    file.raw += `${line}\n`;
    if (/^(?:Binary files |GIT binary patch)/.test(line)) { file.binary = true; inHunk = false; }
    else if (line.startsWith('new file mode ')) file.status = 'added';
    else if (line.startsWith('deleted file mode ')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) { file.oldPath = patchPath(line.slice(12), false); file.status = 'renamed'; }
    else if (line.startsWith('rename to ')) { file.path = patchPath(line.slice(10), false); file.status = 'renamed'; }
    else if (!inHunk && line.startsWith('--- ')) { file.oldPath = patchPath(line.slice(4)); if (file.oldPath === '/dev/null') file.status = 'added'; }
    else if (!inHunk && line.startsWith('+++ ')) { file.path = patchPath(line.slice(4)); if (file.path === '/dev/null') { file.path = file.oldPath; file.status = 'deleted'; } }
    else {
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) { oldLine = +hunk[1]; newLine = +hunk[3]; oldRemaining = +(hunk[2] ?? 1); newRemaining = +(hunk[4] ?? 1); inHunk = true; file.hunks.push({oldStart: oldLine, newStart: newLine}); }
      let row;
      if (hunk) row = { kind: 'hunk', sign: ' ', text: line };
      else if (line === '\\ No newline at end of file') row = { kind: 'note', sign: ' ', text: line };
      else if (inHunk && /^[ +\-]/.test(line)) {
        const sign = line[0];
        row = { kind: sign === '+' ? 'add' : sign === '-' ? 'delete' : 'context', sign, text: line.slice(1), oldLine: sign === '+' ? null : oldLine++, newLine: sign === '-' ? null : newLine++ };
        if (sign === '+') file.added++;
        if (sign === '-') file.removed++;
        if (sign !== '+') oldRemaining--;
        if (sign !== '-') newRemaining--;
        if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
      }
      if (row) { if (file.lines.length < OUTPUT_LIMITS.diffLines) file.lines.push(row); else file.oversized = true; }
    }
  }
  return files.filter(entry => entry.raw.trim());
}

export function fileChangeDiffs(item = {}) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const raw = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
  if (raw && (/^(?:diff --git |--- )/m.test(raw) || changes.length <= 1 && /^@@ /m.test(raw))) return parseUnifiedDiff(raw, changes.length === 1 ? changeInfo(changes[0]) : {});
  const files = changes.slice(0, OUTPUT_LIMITS.files).flatMap(change => {
    const info = changeInfo(change);
    const patch = change.diff || change.patch || change.content || change.output || '';
    if (!patch) return [{ ...info, lines: [], hunks: [], added: 0, removed: 0, raw: '', unavailable: true }];
    return parseUnifiedDiff(typeof patch === 'string' ? patch : readableStructuredValue(patch), info);
  });
  if (changes.length > OUTPUT_LIMITS.files && files.length) files[files.length - 1].filesTruncated = true;
  return files;
}

function changeInfo(change) {
  const kind = typeof change.kind === 'object' ? change.kind : { type: change.kind || change.type };
  const moved = kind.move_path || kind.movePath || change.newPath;
  const path = change.path || change.filePath || 'Changes';
  return { path: moved || path, oldPath: path, status: moved ? 'renamed' : /^(add|added)$/.test(kind.type) ? 'added' : /^(delete|deleted)$/.test(kind.type) ? 'deleted' : 'modified' };
}

export function diffFingerprint(file) {
  return JSON.stringify([file.path, file.oldPath, file.status, !!file.binary, file.lines.filter(line => line.kind !== 'hunk').map(line => [line.sign, line.text])]);
}

export function deduplicateTurnDiff(files, shown) {
  const fingerprints = new Set(shown.filter(file => !file.oversized && !file.unavailable).map(diffFingerprint));
  return files.filter(file => file.oversized || !fingerprints.has(diffFingerprint(file)));
}
