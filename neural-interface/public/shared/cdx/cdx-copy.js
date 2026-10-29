let translate = null;
export function setCodexTranslator(fn) { translate = typeof fn === 'function' ? fn : null; }

// Detached panels/tests can render before the locale bundle is ready.
export function cxpText(key, english, params) {
  const path = `codexPanel.${key}`;
  const value = translate?.(path, params) || path;
  if (value !== path) return value;
  return english.replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? `{${name}}`);
}

export function cxpSessionLabel(label) {
  if (label === 'New session') return cxpText('newSession', 'New session');
  if (label === 'Saved session') return cxpText('savedSession', 'Saved session');
  return label;
}
