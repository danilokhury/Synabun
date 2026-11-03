// Promote complete Markdown blocks once; only the unfinished tail is rebuilt.
// A final whole-document parse resolves cross-block constructs (link references,
// loose lists). The conservative boundary follows the Claude panel's live path.
export function findStableMarkdownBoundary(text, from = 0, minTail = 120) {
  let best = from, pos = from, prevBlank = false;
  let fenceChar = '', fenceLen = 0;
  const limit = text.length - minTail;
  while (pos < limit) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) break;
    const line = text.slice(pos, nl);
    const trimmed = line.replace(/^[ \t]+/, '');
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (!fenceChar) { fenceChar = fence[1][0]; fenceLen = fence[1].length; }
      else if (fence[1][0] === fenceChar && fence[1].length >= fenceLen && /^\s*$/.test(trimmed.slice(fence[1].length))) fenceChar = '';
    }
    const lineStart = pos;
    const blank = trimmed === '';
    pos = nl + 1;
    if (fenceChar) { prevBlank = false; continue; }
    if (prevBlank && !blank && lineStart <= limit) {
      if (!/^[ \t]/.test(line) && !/^([-*+] |\d{1,9}[.)] |>|\|)/.test(trimmed)) best = lineStart;
    }
    prevBlank = blank;
  }
  return best;
}

const prefixes = new WeakMap();

// `render` sanitizes into its destination, exactly as for a finished message.
export function renderStreamingMarkdown(body, text, render, { streaming = false } = {}) {
  if (!streaming) { prefixes.delete(body); render(body, text); return; }
  let state = prefixes.get(body);
  if (!state || text.length < state.length) {
    state = { length: 0, nodes: 0 };
    prefixes.set(body, state);
  }
  try {
    const boundary = findStableMarkdownBoundary(text, state.length);
    while (body.childNodes.length > state.nodes) body.lastChild.remove();
    const fragment = body.ownerDocument.createElement('div');
    if (boundary > state.length) {
      render(fragment, text.slice(state.length, boundary));
      body.append(...fragment.childNodes);
      state.nodes = body.childNodes.length;
      state.length = boundary;
    }
    if (text.length > state.length) {
      render(fragment, text.slice(state.length));
      body.append(...fragment.childNodes);
    }
  } catch {
    prefixes.delete(body);
    render(body, text);
  }
}
