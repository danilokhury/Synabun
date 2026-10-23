// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: the metadata form
// ═══════════════════════════════════════════
//
// The form beside the editor is a view of the document's frontmatter, never a second copy of it: what each
// field shows is read from the text (ss-frontmatter.js parse), and a change in a field becomes a change of that
// one key in the text (patch). A key the form has no field for, a comment, the order and the quoting are
// never touched, and a field whose value is not of the kind the field writes (a description that is a list, an
// aliased value) is shown and left alone: "edit it in the text". No DOM and no imports.

const NAME = { key: 'name', control: 'text', label: 'Name' };
const DESCRIPTION = { key: 'description', control: 'textarea', label: 'Description' };

export const FORM_FIELDS = Object.freeze({
  skill: [
    NAME, DESCRIPTION,
    { key: 'argument-hint', control: 'text', label: 'Argument Hint' },
    { key: 'allowed-tools', control: 'tools', label: 'Allowed Tools' },
    { key: 'user-invocable', control: 'checkbox', label: 'User-invocable', default: true },
    { key: 'disable-model-invocation', control: 'checkbox', label: 'Disable model invocation', default: false },
  ],
  agent: [
    NAME, DESCRIPTION,
    { key: 'model', control: 'model', label: 'Model' },
    { key: 'tools', control: 'list-text', label: 'Tools', hint: '(comma-separated)' },
    { key: 'maxTurns', control: 'number', label: 'Max Turns' },
    { key: 'color', control: 'text', label: 'Color' },
  ],
  command: [DESCRIPTION],
});

/** The tools the tools picker offers (a value outside it is kept as it is). */
export const KNOWN_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit']);
/** The models the agent model picker offers; '' is "inherit". A value outside it is offered too, as it is. */
export const KNOWN_MODELS = Object.freeze(['sonnet', 'haiku', 'opus']);

const own = (data, key) => !!data && Object.prototype.hasOwnProperty.call(data, key);

/**
 * A value of any kind as text, for a field that only shows it. Never throws: a mapping read from YAML has no
 * prototype (`String()` of it throws), and an alias can make a value hold itself (JSON cannot write that).
 */
export function shownText(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') return String(raw);
  try { return JSON.stringify(raw) ?? ''; } catch { return Array.isArray(raw) ? '(a list)' : '(a mapping)'; }
}

/**
 * What the form shows for a document.
 * @param {'skill'|'command'|'agent'} type
 * @param {object} parsed ss-frontmatter.js parse()
 * @returns {{ editable: boolean, reason: string|null, fields: { key, control, label, hint?, value, present, writable, note }[] }}
 */
export function formView(type, parsed) {
  const defs = FORM_FIELDS[type] || [];
  const data = parsed?.data || null;
  const hasErrors = (parsed?.diagnostics || []).some((d) => d.severity === 'error');
  const editable = !!parsed?.editable && !!data && !hasErrors;
  const reason = editable ? null
    : hasErrors ? 'The frontmatter has errors: fix them in the text. The fields are read-only until then.'
    : 'This frontmatter is written in a way the form does not change: edit it in the text.';
  const aliased = new Set((parsed?.keys || []).filter((k) => k.alias).map((k) => k.key));
  const fields = defs.map((def) => {
    const present = own(data, def.key);
    const raw = present ? data[def.key] : undefined;
    let value; let writable = editable && !aliased.has(def.key); let note = null;
    switch (def.control) {
      case 'text':
      case 'textarea':
      case 'model':
        if (raw === undefined || raw === null) value = '';
        else if (typeof raw === 'string') value = def.control === 'textarea' ? raw.replace(/\n+$/, '') : raw;
        else { value = shownText(raw); writable = false; note = 'Not text: edit it in the text.'; }
        break;
      case 'tools':
        if (raw === undefined || raw === null) value = [];
        else if (Array.isArray(raw) && raw.every((t) => typeof t === 'string')) value = raw.slice();
        else if (typeof raw === 'string') value = raw;   // "Read Grep" stays one text value
        else { value = []; writable = false; note = 'Not a list of tool names: edit it in the text.'; }
        break;
      case 'list-text':
        if (raw === undefined || raw === null) value = '';
        else if (typeof raw === 'string') value = raw;
        else if (Array.isArray(raw) && raw.every((t) => typeof t === 'string')) value = raw.join(', ');
        else { value = ''; writable = false; note = 'Not a list of tool names: edit it in the text.'; }
        break;
      case 'checkbox':
        if (raw === undefined) value = !!def.default;
        else if (typeof raw === 'boolean') value = raw;
        else { value = !!def.default; writable = false; note = 'Not true or false: edit it in the text.'; }
        break;
      case 'number':
        if (raw === undefined || raw === null) value = '';
        else if (Number.isInteger(raw) && raw >= 0) value = String(raw);
        else { value = shownText(raw); writable = false; note = 'Not a whole number: edit it in the text.'; }
        break;
      default:
        value = shownText(raw); writable = false;
    }
    if (aliased.has(def.key)) note = 'An alias: edit it in the text.';
    return { ...def, value, present, writable, note };
  });
  return { editable, reason, fields };
}

/**
 * What to patch a key with, for what the person put in its field. `undefined` removes the key.
 * @param {object} o
 * @param {object} o.field a field of formView()
 * @param {any} o.input what the control holds now (text, a boolean, a list of tools)
 * @param {any} o.current the key's value in the document now (undefined: not there)
 * @param {boolean} o.savedHasKey the key is in the file as it was last saved (a checkbox put back to its default
 *   then writes the default, instead of leaving out a key the file had)
 * @returns {{ value: any } | { invalid: string }}
 */
export function fieldPatchValue({ field, input, current, savedHasKey = false }) {
  switch (field.control) {
    case 'text':
    case 'model': {
      const text = String(input ?? '');
      return { value: text.trim() === '' ? undefined : text.trim() };
    }
    case 'textarea': {
      const text = String(input ?? '').replace(/\r\n?/g, '\n');
      if (text.trim() === '') return { value: undefined };
      // A block value keeps the line endings it closed with (a folded `>` description reads "…\n").
      const tail = typeof current === 'string' ? (/\n+$/.exec(current)?.[0] || '') : '';
      return { value: text.replace(/\n+$/, '') + tail };
    }
    case 'tools': {
      if (typeof input === 'string') return { value: input.trim() === '' ? undefined : input.trim() };
      const list = (Array.isArray(input) ? input : []).map((t) => String(t).trim()).filter(Boolean);
      return { value: list.length ? [...new Set(list)] : undefined };
    }
    case 'list-text': {
      const text = String(input ?? '').trim();
      if (!text) return { value: undefined };
      // Written the way the file had it: a list stays a list, text stays text.
      if (Array.isArray(current)) return { value: text.split(',').map((t) => t.trim()).filter(Boolean) };
      return { value: text };
    }
    case 'checkbox': {
      const on = !!input;
      // Back to the default on a file that never named the key: the key goes again, the file is as it was.
      if (on === !!field.default && !savedHasKey) return { value: undefined };
      return { value: on };
    }
    case 'number': {
      const text = String(input ?? '').trim();
      if (!text) return { value: undefined };
      if (!/^\d+$/.test(text)) return { invalid: 'A whole number, 0 or more.' };
      return { value: Number.parseInt(text, 10) };
    }
    default:
      return { invalid: 'This field is not written by the form.' };
  }
}
