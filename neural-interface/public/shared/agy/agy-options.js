// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: pickers and permission cards (no DOM)
// ═══════════════════════════════════════════
//
// Antigravity describes its own choices: a session's `configOptions` (ACP
// Session Config Options) carry the model, the thinking level and anything
// else it lets a client set, each with its current value and every value it
// accepts, and `modes` the agent modes (Agent, Accept edits, Plan, Auto).
// Nothing here keeps a list of its own: the pickers show what the session
// says, in its words, and write back the value it gave.

/** The first select option of a category ('model', 'thought_level', 'mode'), or null. */
export function optionByCategory(configOptions, category) {
  return (Array.isArray(configOptions) ? configOptions : []).find((option) => option && option.category === category && (option.type === 'select' || option.type === undefined)) || null;
}

/** The options a header shows: model and thinking first, then the rest the agent offers (select or boolean). */
export function orderedOptions(configOptions) {
  const list = (Array.isArray(configOptions) ? configOptions : []).filter((option) => option && typeof option.id === 'string' && (option.type === 'select' || option.type === 'boolean'));
  const rank = (option) => ({ model: 0, thought_level: 1, model_config: 2, mode: 3 }[option.category] ?? 4);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** cc-dropdown entries for a select option: flat options, or `{ group, options }` headings. */
export function dropdownEntries(option) {
  if (!option || !Array.isArray(option.options)) return [];
  const current = option.currentValue;
  const one = (value) => ({ value: String(value.value), label: String(value.name || value.value), selected: value.value === current, title: value.description || '' });
  return option.options.map((entry) => {
    if (entry && Array.isArray(entry.options)) return { group: String(entry.name || entry.group || ''), options: entry.options.filter((v) => v && v.value !== undefined).map(one) };
    return entry && entry.value !== undefined ? one(entry) : null;
  }).filter(Boolean);
}

/** The label of an option's current value ('Gemini 3.8 Flash'), or the raw value. */
export function currentLabel(option) {
  if (!option) return '';
  for (const entry of option.options || []) {
    const values = Array.isArray(entry?.options) ? entry.options : [entry];
    for (const value of values) if (value && value.value === option.currentValue) return String(value.name || value.value);
  }
  return option.currentValue === undefined || option.currentValue === null ? '' : String(option.currentValue);
}

/** Every value an option accepts (flattened), for validating what a page sends back. */
export function acceptedValues(option) {
  const out = [];
  for (const entry of option?.options || []) {
    const values = Array.isArray(entry?.options) ? entry.options : [entry];
    for (const value of values) if (value && value.value !== undefined) out.push(value.value);
  }
  return out;
}

/** Applies a value locally (optimistic), before the agent's answer replaces the whole list. */
export function withValue(configOptions, configId, value) {
  return (Array.isArray(configOptions) ? configOptions : []).map((option) => (option?.id === configId ? { ...option, currentValue: value } : option));
}

/** Mode picker entries from the session's modes ({ currentModeId, availableModes }). */
export function modeEntries(modes) {
  const list = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  return list.filter((mode) => mode && typeof mode.id === 'string').map((mode) => ({
    value: mode.id, label: String(mode.name || mode.id), selected: mode.id === modes.currentModeId, title: mode.description || '',
  }));
}

/** The name of the current mode. */
export function currentModeLabel(modes) {
  const found = (modes?.availableModes || []).find((mode) => mode?.id === modes?.currentModeId);
  return found ? String(found.name || found.id) : String(modes?.currentModeId || '');
}

const KIND_VERBS = Object.freeze({
  read: 'read', edit: 'edit', delete: 'delete', move: 'move', search: 'search',
  execute: 'run', think: 'think', fetch: 'fetch', switch_mode: 'switch mode', other: 'use a tool',
});

/**
 * What a permission card says and offers, from session/request_permission:
 * { title, kind, verb, detail (command, paths or input), options [{ optionId, label, kind, tone }] }.
 * Allow choices come first, then the denials; `tone` is 'allow' | 'deny'.
 */
export function permissionCard(request) {
  const toolCall = request?.toolCall && typeof request.toolCall === 'object' ? request.toolCall : {};
  const input = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  const kind = typeof toolCall.kind === 'string' && KIND_VERBS[toolCall.kind] ? toolCall.kind : 'other';
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : '';
  const paths = (Array.isArray(toolCall.locations) ? toolCall.locations : []).map((l) => l?.path).filter((p) => typeof p === 'string' && p);
  let detail = command || paths.join('\n');
  if (!detail && input && Object.keys(input).length) {
    try { detail = JSON.stringify(input, null, 2).slice(0, 2000); } catch { detail = ''; }
  }
  const options = (Array.isArray(request?.options) ? request.options : [])
    .filter((option) => option && typeof option.optionId === 'string')
    .map((option) => ({ optionId: option.optionId, label: String(option.name || option.optionId), kind: option.kind || '', tone: String(option.kind || '').startsWith('reject') ? 'deny' : 'allow' }))
    .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'allow' ? -1 : 1));
  return { title: String(toolCall.title || ''), kind, verb: KIND_VERBS[kind], detail, command, paths, options, diffs: permissionDiffs(request) };
}

/** The option an "Allow once" / "Deny" keyboard shortcut picks: the first of that tone and duration. */
export function quickOption(card, tone) {
  const want = tone === 'deny' ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always'];
  for (const kind of want) {
    const found = card.options.find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  return card.options.find((option) => option.tone === tone)?.optionId || null;
}

/** The changes a permission request carries (`toolCall.content` diffs): shown above its buttons. */
export function permissionDiffs(request) {
  const content = Array.isArray(request?.toolCall?.content) ? request.toolCall.content : [];
  return content.filter((item) => item && item.type === 'diff' && typeof item.path === 'string')
    .map((item) => ({ type: 'diff', path: item.path, oldText: item.oldText ?? null, newText: String(item.newText ?? '') }));
}

// ── The options the toolbar does not show ──

/** Toolbar pickers: the model, the thinking level and the mode (by category). Everything else goes in Session settings. */
export const TOOLBAR_CATEGORIES = Object.freeze(['model', 'thought_level', 'mode']);

/** The session's other options (select or boolean), in the agent's order: Session settings lists these. */
export function secondaryOptions(configOptions) {
  const shown = new Set();
  for (const category of TOOLBAR_CATEGORIES) {
    const option = optionByCategory(configOptions, category);
    if (option) shown.add(option.id);
  }
  return (Array.isArray(configOptions) ? configOptions : [])
    .filter((option) => option && typeof option.id === 'string' && !shown.has(option.id) && (option.type === 'select' || option.type === 'boolean'));
}

/** The value a boolean option takes when its switch is flipped. */
export function toggledValue(option) {
  return !(option?.currentValue === true);
}

// ── Elicitation: the agent asks for structured input (ACP elicitation/create) ──

const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array']);

/**
 * The fields of a form-mode elicitation, from its `requestedSchema` (a flat object schema of string / number /
 * integer / boolean / multi-select properties): [{ name, type, title, description, required, choices, multiple,
 * min, max, minLength, maxLength, format, defaultValue }]. A property of a type the panel cannot ask for is kept as
 * `{ type: 'unsupported' }`, so the card can say why it cannot be answered.
 */
export function elicitationFields(schema) {
  const properties = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((name) => typeof name === 'string') : []);
  return Object.entries(properties).slice(0, 50).map(([name, prop]) => {
    const type = FIELD_TYPES.has(prop?.type) ? prop.type : 'unsupported';
    const field = {
      name,
      type,
      title: typeof prop?.title === 'string' && prop.title ? prop.title : name,
      description: typeof prop?.description === 'string' ? prop.description : '',
      required: required.has(name),
      choices: [],
      multiple: type === 'array',
      min: Number.isFinite(prop?.minimum) ? prop.minimum : null,
      max: Number.isFinite(prop?.maximum) ? prop.maximum : null,
      minLength: Number.isInteger(prop?.minLength) ? prop.minLength : null,
      maxLength: Number.isInteger(prop?.maxLength) ? prop.maxLength : null,
      format: typeof prop?.format === 'string' ? prop.format : '',
      defaultValue: prop?.default ?? null,
    };
    if (type === 'string') {
      if (Array.isArray(prop?.oneOf)) field.choices = prop.oneOf.filter((o) => o && typeof o.const === 'string').map((o) => ({ value: o.const, label: String(o.title || o.const) }));
      else if (Array.isArray(prop?.enum)) field.choices = prop.enum.filter((v) => typeof v === 'string').map((v) => ({ value: v, label: v }));
    }
    if (type === 'array') {
      const items = prop?.items || {};
      const list = Array.isArray(items.anyOf) ? items.anyOf : Array.isArray(items.oneOf) ? items.oneOf : null;
      if (list) field.choices = list.filter((o) => o && typeof o.const === 'string').map((o) => ({ value: o.const, label: String(o.title || o.const) }));
      else if (Array.isArray(items.enum)) field.choices = items.enum.filter((v) => typeof v === 'string').map((v) => ({ value: v, label: v }));
      if (!field.choices.length) field.type = 'unsupported';
      field.min = Number.isInteger(prop?.minItems) ? prop.minItems : null;
      field.max = Number.isInteger(prop?.maxItems) ? prop.maxItems : null;
    }
    return field;
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What the form says, as the answer's `content`, from the raw values the inputs hold ({ name: string | boolean |
 * string[] }). Returns { content, errors: { name: key } } — `errors` empty when it may be sent. Keys are copy keys of
 * agy-copy.js (elicitRequired, elicitNumber, elicitRange, elicitLength, elicitEmail, elicitUrl, elicitChoices).
 */
export function elicitationContent(fields, values = {}) {
  const content = {};
  const errors = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.type === 'unsupported') { if (field.required) errors[field.name] = 'elicitUnsupported'; continue; }
    if (field.type === 'boolean') { content[field.name] = raw === true || raw === 'true'; continue; }
    if (field.type === 'array') {
      const picked = (Array.isArray(raw) ? raw : []).filter((value) => field.choices.some((choice) => choice.value === value));
      if (field.required && !picked.length) { errors[field.name] = 'elicitRequired'; continue; }
      if ((field.min !== null && picked.length < field.min) || (field.max !== null && picked.length > field.max)) { errors[field.name] = 'elicitChoices'; continue; }
      if (picked.length || field.required) content[field.name] = picked;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
    if (!text) { if (field.required) errors[field.name] = 'elicitRequired'; continue; }
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(text);
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) { errors[field.name] = 'elicitNumber'; continue; }
      if ((field.min !== null && number < field.min) || (field.max !== null && number > field.max)) { errors[field.name] = 'elicitRange'; continue; }
      content[field.name] = number;
      continue;
    }
    if (field.choices.length && !field.choices.some((choice) => choice.value === text)) { errors[field.name] = 'elicitRequired'; continue; }
    if ((field.minLength !== null && text.length < field.minLength) || (field.maxLength !== null && text.length > field.maxLength)) { errors[field.name] = 'elicitLength'; continue; }
    if (field.format === 'email' && !EMAIL.test(text)) { errors[field.name] = 'elicitEmail'; continue; }
    if (field.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(text)) { errors[field.name] = 'elicitUrl'; continue; }
    content[field.name] = text.slice(0, 10_000);
  }
  return { content, errors };
}

/** A URL-mode elicitation's address, when it is one the panel may open (https, or http on this computer). */
export function elicitationUrl(request) {
  let url;
  try { url = new URL(String(request?.url || '')); } catch { return null; }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  return null;
}
