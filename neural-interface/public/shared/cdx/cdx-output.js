import { OUTPUT_LIMITS, boundedText, cleanTerminal, jsonAnswer, looksLikeStreamingJson, isPreformattedText, structuredValueModel, readableStructuredValue, parseUnifiedDiff, hasOverlongRun, outputOverflows, displayDiffPath } from './cdx-output-model.js';

const sources = new WeakMap();
const bound = new WeakSet();
const diffStates = new WeakMap();
const pending = new WeakMap();
const cleaned = new WeakMap();
const watched = new WeakSet();
const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { pending.get(entry.target)?.(); observer.unobserve(entry.target); pending.delete(entry.target); }
}, { rootMargin: '200px' }) : null;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Layout work is coalesced once per frame, and only changed blocks are measured.
const measurements = new WeakMap();
const measurementQueue = new Set();
let measurementFrame = false, capId = 0;
function queueMeasurement(el) {
  measurementQueue.add(el);
  if (measurementFrame) return;
  measurementFrame = true;
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : queueMicrotask;
  schedule(() => {
    measurementFrame = false;
    const batch = [...measurementQueue]; measurementQueue.clear();
    for (const target of batch) measurements.get(target)?.();
  });
}
const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  for (const entry of entries) queueMeasurement(entry.target);
}) : null;
const contentObservers = new WeakMap();
function measureChanges(el, update) {
  if (!measurements.has(el)) {
    sizeObserver?.observe(el);
    if (typeof MutationObserver === 'function' && !el.classList.contains('cxp-diff-path')) {
      const watcher = new MutationObserver(() => queueMeasurement(el));
      watcher.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
      contentObservers.set(el, watcher);
    }
  }
  measurements.set(el, update); queueMeasurement(el);
}
function releaseMeasurements(root) {
  for (const el of [root, ...(root.querySelectorAll?.('*') || [])]) {
    sizeObserver?.unobserve(el); contentObservers.get(el)?.disconnect();
    contentObservers.delete(el); measurements.delete(el); measurementQueue.delete(el);
  }
}

export function updateOverflowNote(block, note) {
  const clipped = outputOverflows(block.scrollHeight, block.clientHeight) && block.checkVisibility?.() !== false;
  if (note.hidden !== !clipped) note.hidden = !clipped;
  const ids = (block.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== note.id);
  if (clipped) ids.push(note.id);
  const description = ids.join(' ');
  if (description !== (block.getAttribute('aria-describedby') || '')) {
    if (description) block.setAttribute('aria-describedby', description);
    else block.removeAttribute('aria-describedby');
  }
  return clipped;
}
function watchCap(block) {
  if (!block.parentElement || block.classList.contains('cxp-pre-structured')) return;
  if (block.getAttribute('aria-label') === 'Output; height capped at 320 pixels, scroll to read') block.removeAttribute('aria-label');
  let note = block.nextElementSibling;
  if (!note?.dataset.outputCap) {
    note = node('div', 'cxp-output-note'); note.dataset.outputCap = '1'; note.hidden = true;
    block.after(note);
  }
  if (!measurements.has(block)) {
    const previousId = note.id;
    note.id = `cxp-output-cap-${++capId}`;
    if (previousId) {
      const ids = (block.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== previousId);
      if (ids.length) block.setAttribute('aria-describedby', ids.join(' '));
      else block.removeAttribute('aria-describedby');
    }
  }
  const kind = block.classList.contains('cxp-diff-lines') ? 'Diff' : block.classList.contains('cxp-structured-tree') ? 'Structured view' : 'Block';
  const cap = kind === 'Diff' ? 480 : kind === 'Structured view' ? 640 : 320;
  const message = `${kind} height capped at ${cap} px · scroll to read`;
  if (note.textContent !== message) note.textContent = message;
  // Assistant markdown is first serialized from a detached template. Hydration
  // binds its live clone; never retain the discarded template in ResizeObserver.
  if (block.isConnected || typeof ResizeObserver !== 'function') measureChanges(block, () => updateOverflowNote(block, note));
}
function watchCaps(container) {
  for (const block of container?.querySelectorAll('pre, .cxp-card-pre, .cxp-structured-tree, .cxp-diff-lines') || []) {
    if (block.hidden || block.classList.contains('cxp-diff-source') || block.tagName === 'CODE') continue;
    watchCap(block);
  }
}

function textWithLinks(el, text) {
  const source = cleanTerminal(text);
  let last = 0;
  for (const match of source.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    el.append(document.createTextNode(source.slice(last, match.index)));
    const a = node('a', '', match[0]); a.href = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; el.append(a);
    last = match.index + match[0].length;
  }
  el.append(document.createTextNode(source.slice(last)));
}

function modelView(model) {
  if (model.kind === 'raw') return node('pre', 'cxp-card-pre cxp-output-raw', model.text);
  if (model.kind === 'scalar') {
    const el = node('span', `cxp-structured-value cxp-value-${model.type}`);
    textWithLinks(el, model.text); return el;
  }
  if (!model.total) return node('span', 'cxp-structured-value', model.kind === 'array' ? '[]' : '{}');
  const list = node(model.kind === 'array' ? 'ul' : 'div', `cxp-structured-${model.kind}`);
  const add = (entry, target) => {
    const row = node(model.kind === 'array' ? 'li' : 'div', 'cxp-structured-entry');
    if (model.kind === 'object') row.append(node('div', 'cxp-structured-key', entry.key));
    row.append(modelView(entry.value)); target.append(row);
  };
  const preview = model.kind === 'array' ? OUTPUT_LIMITS.array : model.entries.length;
  model.entries.slice(0, preview).forEach(entry => add(entry, list));
  if (model.entries.length > preview) {
    const details = node('details', 'cxp-output-more');
    details.append(node('summary', 'cxp-output-control', `Show all (${model.total})`));
    // The model is bounded; build the remainder only on the user's first expansion.
    const rest = node('ul', 'cxp-structured-array');
    const fill = () => { if (details.open && !rest.children.length) model.entries.slice(preview).forEach(entry => add(entry, rest)); };
    details.addEventListener('toggle', fill);
    // Preserve this content in saved HTML too, without eagerly making thousands of nodes.
    const data = node('span', 'cxp-output-model'); data.hidden = true; data.textContent = JSON.stringify(model.entries.slice(preview));
    details.append(rest, data); list.append(details);
  }
  if (model.truncated) list.append(node('div', 'cxp-output-note', `Structure truncated at ${OUTPUT_LIMITS.nodes.toLocaleString()} values; see Raw.`));
  return list;
}

export function renderReadableOutput(container, text, { streaming = false, force = false } = {}) {
  const original = String(text ?? '');
  const old = sources.get(container);
  if (old?.text === original && old.streaming === streaming) return true;
  const parsed = streaming ? null : jsonAnswer(original);
  const preformatted = streaming && looksLikeStreamingJson(original) || isPreformattedText(original) || /[\x1b\x9b\x9d]/.test(original) || hasOverlongRun(original) && !/^\s*(?:```|~~~)/m.test(original);
  if (!parsed && !preformatted && !force) { sources.delete(container); return false; }
  sources.set(container, { text: original, streaming });
  const rawMode = container.querySelector('.cxp-readable')?.dataset.rawMode === '1';
  releaseMeasurements(container);
  container.replaceChildren();
  if (parsed?.kind === 'json') {
    const root = node('div', 'cxp-readable');
    root.dataset.original = original; root.dataset.rawMode = rawMode ? '1' : '0';
    const controls = node('div', 'cxp-output-controls');
    const raw = node('button', 'cxp-output-control', rawMode ? 'Structured' : 'Raw'); raw.type = 'button'; raw.dataset.outputAction = 'raw'; raw.setAttribute('aria-pressed', String(rawMode));
    const copy = node('button', 'cxp-output-control', 'Copy'); copy.type = 'button'; copy.dataset.outputAction = 'copy';
    controls.append(raw, copy);
    const tree = node('div', 'cxp-structured-tree'); tree.hidden = rawMode; tree.append(modelView(structuredValueModel(parsed.value)));
    const pre = node('pre', 'cxp-card-pre cxp-output-raw'); pre.hidden = !rawMode; pre.append(node('code', '', readableStructuredValue(parsed.value)));
    root.append(controls, tree, pre); container.append(root);
  } else {
    const root = node('div', 'cxp-output-source');
    root.dataset.original = boundedText(original, OUTPUT_LIMITS.input);
    sources.set(root, { text: original, streaming });
    const controls = node('div', 'cxp-output-controls');
    const copy = node('button', 'cxp-output-control', 'Copy'); copy.type = 'button'; copy.dataset.outputAction = 'copy'; controls.append(copy);
    const pre = node('pre', 'cxp-card-pre cxp-output-raw'); pre.append(node('code', '', parsed?.raw || boundedText(cleanTerminal(original))));
    root.append(controls, pre); container.append(root);
    if (original.length > OUTPUT_LIMITS.input) root.append(node('div', 'cxp-output-note', 'Large output: showing a truncated raw block.'));
  }
  hydrateOutputControls(container);
  watchCaps(container);
  return true;
}

export function hydrateOutputControls(container) {
  if (!container) return;
  watchCaps(container);
  if (bound.has(container)) return;
  bound.add(container);
  container.addEventListener('click', event => {
    const button = event.target.closest('[data-output-action]');
    if (!button || !container.contains(button)) return;
    const root = button.closest('.cxp-readable, .cxp-output-source, .cxp-diff-view');
    if (!root) return;
    if (button.dataset.outputAction === 'raw') {
      const raw = root.dataset.rawMode !== '1'; root.dataset.rawMode = raw ? '1' : '0';
      root.querySelector('.cxp-structured-tree').hidden = raw;
      root.querySelector('.cxp-output-raw').hidden = !raw;
      button.textContent = raw ? 'Structured' : 'Raw'; button.setAttribute('aria-pressed', String(raw));
      watchCaps(root);
    } else if (button.dataset.outputAction === 'copy') {
      const text = sources.get(root)?.text ?? root.dataset.original ?? diffStates.get(root)?.raw ?? root.querySelector('.cxp-diff-source')?.textContent ?? '';
      navigator.clipboard.writeText(text).then(() => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = root.classList.contains('cxp-diff-view') ? 'Copy patch' : 'Copy'; }, 1500); }).catch(() => {});
    }
    event.stopPropagation();
  });
  container.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.matches?.('.cxp-output-more') || !details.open) return;
    const data = details.querySelector('.cxp-output-model');
    const rest = details.querySelector('ul');
    if (!data || !rest || rest.children.length) return;
    try { JSON.parse(data.textContent).forEach(entry => { const li = node('li', 'cxp-structured-entry'); li.append(modelView(entry.value)); rest.append(li); }); } catch {}
  }, true);
}

export function renderReadableBlock(el, text) {
  if (!el) return;
  const original = String(text ?? '');
  const parsed = jsonAnswer(original);
  if (parsed?.kind === 'json' && el.tagName !== 'CODE') {
    el.classList.add('cxp-pre-structured'); renderReadableOutput(el, original);
  } else {
    sources.delete(el);
    el.classList.remove('cxp-pre-structured');
    const clean = parsed?.kind === 'json' ? readableStructuredValue(parsed.value) : boundedText(cleanTerminal(original));
    if (el.textContent !== clean) el.textContent = clean;
  }
  el.dataset.outputClean = '1';
  cleaned.set(el, el.textContent);
  watchCap(el.tagName === 'CODE' ? el.parentElement : el);
}

export function cleanOutputBlocks(container) {
  // Earlier snapshots wrapped fence contents in a structured view. Rehydrate
  // those as standard code while retaining JSON tool cards outside code fences.
  for (const code of container?.querySelectorAll('pre code') || []) {
    const saved = code.querySelector('.cxp-readable');
    if (saved && jsonAnswer(saved.dataset.original)?.kind === 'json') {
      const original = saved.dataset.original; releaseMeasurements(code);
      code.textContent = original; renderReadableBlock(code, original);
    }
  }
  for (const pre of container?.querySelectorAll('.cxp-card-pre, pre code') || []) {
    if (pre.closest('.cxp-readable, .cxp-output-source, .cxp-diff-view') || pre.querySelector('.cxp-readable') || cleaned.get(pre) === pre.textContent) continue;
    const code = pre.querySelector('code');
    // Never feed a Copy button's label back into the code. That would grow
    // the output on every observer tick after postProcessRenderedHtml().
    renderReadableBlock(code || pre, (code || pre).textContent);
  }
  hydrateOutputControls(container);
  watchCaps(container);
}

// Covers generic/legacy cards and request builders which assign pre.textContent
// directly. Observe each transcript once; our own writes settle after one pass.
export function observeOutputBlocks(container) {
  if (!container || watched.has(container) || typeof MutationObserver !== 'function') return;
  watched.add(container);
  let queued = false;
  const dirty = new Set();
  const watcher = new MutationObserver(records => {
    for (const record of records) {
      for (const removed of record.removedNodes || []) if (removed.nodeType === 1 && !removed.isConnected) releaseMeasurements(removed);
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const pre = target?.closest?.('pre, .cxp-card-pre');
      if (pre) dirty.add(pre);
      else for (const added of record.addedNodes || []) if (added.nodeType === 1) dirty.add(added);
    }
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const root of dirty) {
        if (root.matches?.('pre, .cxp-card-pre') && !root.closest('.cxp-readable, .cxp-output-source, .cxp-diff-view') && !root.querySelector('.cxp-readable')) {
          const code = root.querySelector('code');
          if (cleaned.get(code || root) !== (code || root).textContent) renderReadableBlock(code || root, (code || root).textContent);
        }
        cleanOutputBlocks(root);
      }
      dirty.clear();
    });
  });
  watcher.observe(container, { childList: true, characterData: true, subtree: true });
}

function diffRows(file, target, count) {
  const lines = file.lines.slice(0, count);
  // Reuse each row during deltas. Text only: no markdown/linkification/highlighting.
  while (target.children.length > lines.length) target.lastElementChild.remove();
  lines.forEach((line, i) => {
    let row = target.children[i];
    if (!row) { row = node('div', 'cxp-diff-line'); row.append(node('span', 'cxp-diff-old'), node('span', 'cxp-diff-new'), node('span', 'cxp-diff-sign'), node('span', 'cxp-diff-text')); target.append(row); }
    row.dataset.kind = line.kind;
    [line.oldLine ?? '', line.newLine ?? '', line.sign === '-' ? '−' : line.sign, boundedText(line.text, OUTPUT_LIMITS.value)].forEach((text, index) => { const cell = row.children[index]; if (cell.textContent !== String(text)) cell.textContent = text; if (index < 2) cell.title = String(text); });
  });
}

function fitDiffPath(el, file, cwd) {
  const renamed = file.status === 'renamed';
  const label = limit => renamed ? `${displayDiffPath(file.oldPath, cwd, limit)} → ${displayDiffPath(file.path, cwd, limit)}` : displayDiffPath(file.path, cwd, limit);
  let limit = OUTPUT_LIMITS.pathChars;
  let text = label(limit);
  if (el.textContent !== text) el.textContent = text;
  // Use the actual available width, preserving both filenames even on renames.
  while (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && limit > 1) {
    limit = Math.max(1, limit - 4);
    const next = label(limit);
    if (next !== text) { text = next; el.textContent = text; }
  }
}

export function renderDiffView(container, files, { lazy = false, cwd = container.dataset.cwd || '', summaryEl = null } = {}) {
  container.dataset.cwd = cwd;
  container.classList.add('cxp-diff-view');
  let state = diffStates.get(container);
  if (!state) {
    state = { entries: new Map(), raw: '' }; diffStates.set(container, state);
    const controls = node('div', 'cxp-output-controls');
    const copy = node('button', 'cxp-output-control', 'Copy patch'); copy.type = 'button'; copy.dataset.outputAction = 'copy'; controls.append(copy);
    const source = node('pre', 'cxp-diff-source'); source.hidden = true;
    if (summaryEl) controls.insertBefore(summaryEl, copy);
    else controls.insertBefore(node('div', 'cxp-card-meta'), copy);
    container.replaceChildren(controls, source); hydrateOutputControls(container);
  }
  const summary = container.querySelector('.cxp-output-controls .cxp-card-meta');
  if (summary && !summaryEl) summary.textContent = `${files.length} file change${files.length === 1 ? '' : 's'}`;
  state.raw = files.map(file => file.raw || '').join('\n');
  let filesNote = container.querySelector('.cxp-diff-files-note');
  if (!filesNote) { filesNote = node('div', 'cxp-output-note cxp-diff-files-note'); container.append(filesNote); }
  filesNote.hidden = !files.some(file => file.filesTruncated);
  filesNote.textContent = 'Remaining files omitted: preview limited to 100 files.';
  const serialized = files.map(file => file.raw?.startsWith('diff --git ') ? file.raw : `diff --git a/${file.oldPath || file.path} b/${file.path}\n${file.status === 'renamed' ? `rename from ${file.oldPath}\nrename to ${file.path}\n` : ''}--- ${file.status === 'added' ? '/dev/null' : `a/${file.oldPath || file.path}`}\n+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.path}`}\n${file.raw || ''}`).join('\n');
  container.querySelector('.cxp-diff-source').textContent = boundedText(serialized, OUTPUT_LIMITS.input);
  const retained = new Set();
  files.forEach((file, index) => {
    const key = `${file.oldPath || ''}\n${file.path}\n${index}`; retained.add(key);
    let entry = state.entries.get(key);
    if (!entry) {
      const details = node('details', 'cxp-diff-file'); details.open = index < 5;
      const summary = node('summary', 'cxp-diff-header');
      const path = node('span', 'cxp-diff-path'); const status = node('span', 'cxp-diff-status'); const stats = node('span', 'cxp-diff-stats'); summary.append(path, status, stats);
      const body = node('div', 'cxp-diff-body'); const rows = node('div', 'cxp-diff-lines'); const note = node('div', 'cxp-output-note');
      const more = node('button', 'cxp-output-control'); more.type = 'button';
      body.append(note, rows, more); details.append(summary, body); container.append(details);
      entry = { details, path, status, stats, rows, note, more, full: false, built: false }; state.entries.set(key, entry);
      const build = () => {
        const f = entry.file;
        if (!f) return;
        entry.built = true;
        const message = f.binary ? 'Binary file; text diff unavailable.' : f.oversized ? 'Oversized patch; rendering omitted (200,000 characters / 2,000 lines per file limit). Raw patch is copyable.' : f.unavailable || !f.lines.length && !f.hunks.length && f.status !== 'renamed' ? 'Patch not supplied or not a unified diff.' : '';
        entry.note.textContent = message; entry.note.hidden = !message;
        diffRows(f, entry.rows, message ? 0 : entry.full ? OUTPUT_LIMITS.diffLines : OUTPUT_LIMITS.diffPreview);
        entry.more.hidden = !!message || f.lines.length <= OUTPUT_LIMITS.diffPreview;
        entry.more.textContent = entry.full ? 'Show fewer lines' : `Show full diff (${f.lines.length} lines)`;
        watchCap(entry.rows);
      };
      entry.build = build;
      entry.skipInitialToggle = lazy && details.open;
      details.addEventListener('toggle', () => {
        queueMeasurement(entry.rows);
        if (entry.skipInitialToggle) { entry.skipInitialToggle = false; return; }
        if (details.open) build();
      });
      more.addEventListener('click', () => { entry.full = !entry.full; build(); });
    }
    entry.file = file;
    entry.path.title = file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path;
    measureChanges(entry.path, () => fitDiffPath(entry.path, entry.file, container.dataset.cwd));
    fitDiffPath(entry.path, file, cwd);
    entry.status.textContent = file.status;
    entry.stats.textContent = `+${file.added} −${file.removed}`;
    if (entry.built || !lazy || !observer) { if (entry.details.open || entry.built) entry.build(); }
    else { pending.set(entry.details, entry.build); observer.observe(entry.details); }
  });
  for (const [key, entry] of state.entries) if (!retained.has(key)) { observer?.unobserve(entry.details); pending.delete(entry.details); releaseMeasurements(entry.details); entry.details.remove(); state.entries.delete(key); }
}

export function restoreDiffViews(container, { cwd } = {}) {
  for (const view of container?.querySelectorAll('.cxp-diff-view') || []) {
    const raw = view.querySelector('.cxp-diff-source')?.textContent;
    if (!raw) continue;
    const open = [...view.querySelectorAll('.cxp-diff-file')].map(file => file.open);
    const summaryEl = view.querySelector('.cxp-card-meta');
    releaseMeasurements(view); view.replaceChildren(); diffStates.delete(view);
    renderDiffView(view, parseUnifiedDiff(raw), { lazy: true, summaryEl, cwd: cwd ?? view.dataset.cwd ?? '' });
    [...view.querySelectorAll('.cxp-diff-file')].forEach((file, i) => { file.open = open[i] ?? i < 5; });
  }
}
