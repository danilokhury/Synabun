// Reasoning-effort words in the user's language. DOM-free, no imports (node --test and the panels load it).
// Display only: the id a panel stores or sends is never translated, and no code reads a label back.
//
// Words: `assistant.routes.effortWord.<id>`; menu descriptions: `assistant.routes.effortDesc.<slug>`.
// A locale that only repeats the English word, a key it lacks, an unknown id (an OpenCode variant name) and
// a missing translator all keep the text the caller had.

const lower = (value) => String(value ?? '').trim().toLowerCase();

/** The English forms a standard level goes by, so a label a provider wrote itself ("Balanced") is left alone. */
export const EFFORT_ENGLISH_FORMS = Object.freeze({
  none: ['none', 'off'],
  minimal: ['minimal'],
  low: ['low', 'lo'],
  medium: ['medium', 'med'],
  high: ['high', 'hi'],
  xhigh: ['xhigh', 'x-high', 'extra high', 'extra-high', 'xhi'],
  max: ['max', 'maximum'],
  ultra: ['ultra'],
});

/** The menu descriptions the effort lists carry, by their exact English text (the key under `effortDesc`). */
export const EFFORT_DESC_SLUGS = Object.freeze({
  Minimal: 'minimal',
  Light: 'light',
  Balanced: 'balanced',
  Deep: 'deep',
  'Very deep': 'veryDeep',
  Maximum: 'maximum',
  'Maximum, with delegation': 'maximumDelegation',
  'Config default': 'configDefault',
  'Model default': 'modelDefault',
  'No thinking': 'noThinking',
});

/** The translated word for a level id, or null when there is none to show (Auto / Default `off`, unknown, English). */
export function translatedEffortWord(id, t) {
  const key = lower(id);
  // Only the standard ids have a word: an unknown id never asks the translator (it would log a missing key).
  if (!key || key === 'off' || !EFFORT_ENGLISH_FORMS[key] || typeof t !== 'function') return null;
  const path = `assistant.routes.effortWord.${key}`;
  const value = t(path);
  const english = key === 'none' ? 'off' : key;
  return typeof value === 'string' && value && value !== path && value !== english ? value : null;
}

/**
 * The word for a level whose label is a standard English one (or the id itself); any other label is the
 * provider's own and stays as it is.
 */
export function effortLabelFor(id, label, t) {
  const key = lower(id);
  const forms = EFFORT_ENGLISH_FORMS[key];
  if (!forms) return label;
  const shown = lower(label);
  if (shown && !forms.includes(shown)) return label;
  return translatedEffortWord(key, t) ?? label;
}

/** A menu description in the user's language when it is one of the standard English ones. */
export function effortDescFor(desc, t) {
  const slug = EFFORT_DESC_SLUGS[desc];
  if (!slug || typeof t !== 'function') return desc;
  const path = `assistant.routes.effortDesc.${slug}`;
  const value = t(path);
  return typeof value === 'string' && value && value !== path ? value : desc;
}

// ── Claude Code panel: the Think toggle ──

/** The toggle's English text, per level: the button's short label and its tooltip. */
export const THINK_TOGGLE_ENGLISH = Object.freeze({
  label: Object.freeze({ off: 'Think', low: 'lo', medium: 'med', high: 'hi', xhigh: 'xhi', max: 'max' }),
  title: Object.freeze({
    off: 'Thinking off',
    low: 'Thinking: low',
    medium: 'Thinking: medium',
    high: 'Thinking: high',
    xhigh: 'Thinking: extra high',
    max: 'Thinking: max',
  }),
});

/** The Think toggle's `label` or `title` for a level in the user's language (`effortUi.think.<part>.<level>`). */
export function thinkToggleText(part, level, t) {
  const english = THINK_TOGGLE_ENGLISH[part]?.[level];
  if (english === undefined) return part === 'label' ? THINK_TOGGLE_ENGLISH.label.off : '';
  if (typeof t !== 'function') return english;
  const path = `effortUi.think.${part}.${level}`;
  const value = t(path);
  return typeof value === 'string' && value && value !== path ? value : english;
}

// ── Codex panel: its own words (codexPanel.effort_<id>, so the button and the menu agree) ──

const CODEX_STANDARD_LABELS = Object.freeze({
  off: 'Default', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
});

/**
 * A Codex effort row's label through `text(key, english)` (cxpText). A label the model supplied itself, or any
 * other level id, stays as it is; the raw id counts as the standard label (Settings lists `reasoningEffort`).
 */
export function codexEffortLabel(id, label, text) {
  const standard = CODEX_STANDARD_LABELS[id];
  if (!standard || typeof text !== 'function' || (label !== standard && label !== id)) return label;
  const word = text(id === 'off' ? 'default' : `effort_${id}`, standard);
  return word === standard ? label : word;
}

/**
 * A Codex effort row's description. The Default row's text comes from the panel's own words (the protocol
 * helper only carries the English one); a description the model list supplied stays as it is.
 */
export function codexEffortDesc(id, description, text) {
  if (id === 'off') return typeof text === 'function' ? text('effortDefaultDesc', 'Use the model default') : 'Use the model default';
  return description || '';
}
