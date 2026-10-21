// ─────────────────────────────────────────────────────────────────────────────
// OpenCode 2 → the OpenCode 1 shapes the rest of SynaBun reads.
//
// SynaBun was written against OpenCode 1's API (sessions with `{ info, parts }`
// messages, `message.updated` / `message.part.updated` / `message.part.delta`
// events, `permission.asked` / `question.asked`, tools called `bash` and
// `task`). OpenCode 2 is a different API: everything under /api/*, sessions
// whose assistant messages carry a `content` list, a stream of step / text /
// reasoning / tool events, permissions with `action` / `resources`, questions as
// forms, the shell tool called `shell` and the sub-agent tool `subagent`.
//
// lib/opencode2-client.js speaks OpenCode 2 and hands everything it gets back
// through this module, so the OpenCode panel, the Assistant's OpenCode brain,
// workers, loops, the usage meter and the worker activity relay keep reading
// one set of shapes. Pure functions plus one stateful event translator (a
// stream's parts are assembled from its deltas); no I/O.
// ─────────────────────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ── Names ───────────────────────────────────────────────────────────────────

// OpenCode 2 renamed two tools (and their permission actions); every other
// tool and action keeps its OpenCode 1 name.
const TOOL_TO_V1 = Object.freeze({ shell: 'bash', subagent: 'task' });
const TOOL_TO_V2 = Object.freeze({ bash: 'shell', task: 'subagent' });

/** A tool or permission name of OpenCode 2 as OpenCode 1 called it. */
export function v1ToolName(name) {
  const value = str(name);
  return TOOL_TO_V1[value] || value;
}

/** A tool or permission name of OpenCode 1 as OpenCode 2 calls it. */
export function v2ToolName(name) {
  const value = str(name);
  return TOOL_TO_V2[value] || value;
}

// A part id the panel can use anywhere (an attribute, a map key): the message
// id, the kind of part and its key. The same part gets the same id from the
// live stream and from a transcript read later, so a reload never doubles it.
const idSafe = (v) => str(v).replace(/[^A-Za-z0-9_-]/g, '-');
export function partId(messageID, kind, key = 0) {
  return `prt_${idSafe(str(messageID).replace(/^msg_/, ''))}_${kind}_${idSafe(key)}`;
}

// ── Models, rules, errors ───────────────────────────────────────────────────

/** `{ providerID, modelID }` (or "provider/model") + a variant → OpenCode 2's `{ id, providerID, variant? }`. */
export function modelRefToV2(model, variant = null) {
  let providerID = '';
  let modelID = '';
  if (typeof model === 'string') {
    const text = model.trim();
    const slash = text.indexOf('/');
    if (slash > 0 && slash < text.length - 1) { providerID = text.slice(0, slash); modelID = text.slice(slash + 1); }
  } else if (model && typeof model === 'object') {
    providerID = str(model.providerID).trim();
    modelID = str(model.modelID || model.id).trim();
  }
  if (!providerID || !modelID) return null;
  const ref = { id: modelID, providerID };
  const v = str(variant || (model && typeof model === 'object' ? model.variant : '')).trim();
  if (v) ref.variant = v;
  return ref;
}

/** OpenCode 2's `{ id, providerID, variant? }` → OpenCode 1's `{ providerID, modelID, variant? }`. */
export function modelRefToV1(ref) {
  if (!ref || typeof ref !== 'object' || !ref.id || !ref.providerID) return null;
  const out = { providerID: str(ref.providerID), modelID: str(ref.id) };
  if (ref.variant) out.variant = str(ref.variant);
  return out;
}

/** OpenCode 2 rules `{ action, resource, effect }` → OpenCode 1 `{ permission, pattern, action }`. */
export function rulesToV1(rules) {
  if (!Array.isArray(rules)) return undefined;
  return rules
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({ permission: v1ToolName(rule.action), pattern: str(rule.resource || '*'), action: str(rule.effect) }));
}

/**
 * OpenCode 1 rules (`[{ permission, pattern, action }]`, or the config's
 * `{ bash: 'ask', edit: { '*.md': 'allow' } }` map) → OpenCode 2 rules.
 */
export function rulesToV2(rules) {
  if (rules == null) return undefined;
  const out = [];
  const push = (permission, pattern, action) => {
    const effect = str(action);
    if (!['allow', 'deny', 'ask'].includes(effect)) return;
    out.push({ action: v2ToolName(permission || '*'), resource: str(pattern || '*'), effect });
  };
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      if ('effect' in rule) push(rule.action, rule.resource, rule.effect);
      else push(rule.permission, rule.pattern, rule.action);
    }
  } else if (typeof rules === 'object') {
    for (const [permission, value] of Object.entries(rules)) {
      if (typeof value === 'string') push(permission, '*', value);
      else if (value && typeof value === 'object') for (const [pattern, action] of Object.entries(value)) push(permission, pattern, action);
    }
  }
  return out;
}

/**
 * An OpenCode 2 error (`{ type, message, status?, response? }`, or a tagged
 * `{ _tag, message }`) as OpenCode 1's named error `{ name, data }`, which the
 * panel, the brain and the loops describe (ocp-v2-events.js describeError).
 */
export function errorToV1(error) {
  if (!error) return { name: 'UnknownError', data: { message: 'OpenCode failed' } };
  if (typeof error === 'string') return { name: 'UnknownError', data: { message: error } };
  const type = str(error.type || error._tag || error.name).toLowerCase();
  const message = str(error.message || error.data?.message) || 'OpenCode failed';
  const status = Number(error.status);
  if (/abort|interrupt/.test(type)) return { name: 'MessageAbortedError', data: { message } };
  if (/auth|credential|unauthori[sz]ed|api.?key/.test(type) || status === 401) {
    return { name: 'ProviderAuthError', data: { providerID: str(error.providerID), message } };
  }
  if (/context|overflow/.test(type)) return { name: 'ContextOverflowError', data: { message, ...(error.response?.body ? { responseBody: str(error.response.body) } : {}) } };
  if (/length|max.?tokens/.test(type)) return { name: 'MessageOutputLengthError', data: { message } };
  if (/content.?filter/.test(type)) return { name: 'ContentFilterError', data: { message } };
  if (/busy/.test(type)) return { name: 'SessionBusyError', data: { message } };
  if (Number.isFinite(status) && status > 0) {
    return {
      name: 'APIError',
      data: {
        message,
        statusCode: status,
        isRetryable: status === 429 || status >= 500,
        ...(error.response?.body ? { responseBody: str(error.response.body) } : {}),
      },
    };
  }
  return { name: 'UnknownError', data: { message, ...(type ? { type } : {}) } };
}

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: Object.freeze({ read: 0, write: 0 }) });

/** OpenCode 2 token usage → OpenCode 1's (the same fields; a missing one is 0). */
export function tokensToV1(tokens) {
  const t = obj(tokens);
  const cache = obj(t.cache);
  return { input: num(t.input), output: num(t.output), reasoning: num(t.reasoning), cache: { read: num(cache.read), write: num(cache.write) } };
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** OpenCode 2 Session.Info → OpenCode 1 Session. `extra` fills what OpenCode 2 does not keep (slug, version). */
export function sessionToV1(info, extra = {}) {
  const s = obj(info);
  const time = obj(s.time);
  const out = {
    id: str(s.id),
    slug: str(s.slug || extra.slug),
    projectID: str(s.projectID),
    directory: str(s.location?.directory || s.directory || extra.directory),
    title: str(s.title || extra.title),
    version: str(extra.version || s.version),
    cost: num(s.cost),
    tokens: tokensToV1(s.tokens),
    time: { created: num(time.created), updated: num(time.updated || time.created) },
  };
  if (s.parentID) out.parentID = str(s.parentID);
  if (s.agent) out.agent = str(s.agent);
  if (s.model?.id && s.model?.providerID) out.model = { id: str(s.model.id), providerID: str(s.model.providerID), ...(s.model.variant ? { variant: str(s.model.variant) } : {}) };
  if (s.metadata && typeof s.metadata === 'object') out.metadata = s.metadata;
  if (time.archived) out.time.archived = num(time.archived);
  if (extra.compacting) out.time.compacting = num(extra.compacting);
  const permission = rulesToV1(s.permissions);
  if (permission) out.permission = permission;
  if (s.revert?.messageID) {
    out.revert = { messageID: str(s.revert.messageID) };
    if (s.revert.partID) out.revert.partID = str(s.revert.partID);
    if (s.revert.snapshot) out.revert.snapshot = str(s.revert.snapshot);
  }
  return out;
}

// ── Parts ───────────────────────────────────────────────────────────────────

/** A tool's text content as OpenCode 1's `output` string. */
export function toolContentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

/** A tool's file content as OpenCode 1 file parts (a tool's attachments). */
function toolAttachments(content, base) {
  const files = (Array.isArray(content) ? content : []).filter((item) => item?.type === 'file' && item.uri);
  return files.map((item, index) => ({
    id: partId(base.messageID, 'att', `${base.callID}-${index}`),
    sessionID: base.sessionID,
    messageID: base.messageID,
    type: 'file',
    mime: str(item.mime) || 'application/octet-stream',
    ...(item.name ? { filename: str(item.name) } : {}),
    url: str(item.uri),
  }));
}

/** The line a tool card shows: the call's own description, else what it acts on. */
function toolTitle(name, input) {
  const i = obj(input);
  for (const key of ['description', 'command', 'filePath', 'path', 'pattern', 'query', 'url']) {
    if (typeof i[key] === 'string' && i[key].trim()) return i[key].trim().slice(0, 200);
  }
  return v1ToolName(name);
}

/**
 * An OpenCode 2 tool state → OpenCode 1's (`pending` / `running` / `completed`
 * / `error`). `times` are the call's own times (created, ran, completed).
 */
export function toolStateToV1(state, { name = '', times = {}, base = null } = {}) {
  const s = obj(state);
  const start = num(times.ran || times.created);
  const end = num(times.completed || times.ran || times.created);
  const input = obj(s.input);
  switch (s.status) {
    case 'streaming':
      return { status: 'pending', input: {}, raw: typeof s.input === 'string' ? s.input : '' };
    case 'running':
      return { status: 'running', input, ...(s.metadata ? { metadata: obj(s.metadata) } : {}), time: { start } };
    case 'completed': {
      const out = {
        status: 'completed',
        input,
        output: toolContentText(s.content),
        title: toolTitle(name, input),
        metadata: obj(s.metadata),
        time: { start, end },
      };
      const attachments = base ? toolAttachments(s.content, base) : [];
      if (attachments.length) out.attachments = attachments;
      return out;
    }
    case 'error':
      return {
        status: 'error',
        input,
        error: str(s.error?.message || s.error) || 'Tool failed',
        ...(s.metadata ? { metadata: obj(s.metadata) } : {}),
        time: { start, end },
      };
    default:
      return { status: 'pending', input, raw: '' };
  }
}

function toolPart(item, base) {
  const callID = str(item.id);
  const b = { ...base, callID };
  return {
    id: partId(base.messageID, 'tool', callID),
    sessionID: base.sessionID,
    messageID: base.messageID,
    type: 'tool',
    callID,
    tool: v1ToolName(item.name),
    state: toolStateToV1(item.state, { name: item.name, times: obj(item.time), base: b }),
  };
}

/** A user's prompt attachments (stored as base64 data) → OpenCode 1 file parts. */
function userFileParts(files, base) {
  return (Array.isArray(files) ? files : []).map((file, index) => {
    const mime = str(file?.mime) || 'application/octet-stream';
    const url = file?.source?.type === 'uri' && file.source.uri
      ? str(file.source.uri)
      : (typeof file?.data === 'string' ? `data:${mime};base64,${file.data}` : '');
    return {
      id: partId(base.messageID, 'file', index),
      sessionID: base.sessionID,
      messageID: base.messageID,
      type: 'file',
      mime,
      ...(file?.name ? { filename: str(file.name) } : {}),
      url,
    };
  }).filter((part) => part.url);
}

// ── Messages ────────────────────────────────────────────────────────────────

function assistantInfo(item, { sessionID, directory, parentID }) {
  const time = obj(item.time);
  const model = obj(item.model);
  const info = {
    id: str(item.id),
    sessionID,
    role: 'assistant',
    time: { created: num(time.created) },
    parentID: str(parentID),
    modelID: str(model.id),
    providerID: str(model.providerID),
    mode: str(item.agent),
    agent: str(item.agent),
    path: { cwd: str(directory), root: str(directory) },
    cost: num(item.cost),
    tokens: tokensToV1(item.tokens),
  };
  if (model.variant) info.variant = str(model.variant);
  if (time.completed) info.time.completed = num(time.completed);
  if (item.finish) info.finish = str(item.finish);
  if (item.error) info.error = errorToV1(item.error);
  return info;
}

/** The parts of an OpenCode 2 assistant message, in their order, with OpenCode 1 ids. */
function assistantParts(item, base) {
  const parts = [];
  const time = obj(item.time);
  parts.push({ id: partId(base.messageID, 'step', 'start'), sessionID: base.sessionID, messageID: base.messageID, type: 'step-start' });
  const ordinals = { text: 0, reasoning: 0 };
  for (const content of Array.isArray(item.content) ? item.content : []) {
    if (!content || typeof content !== 'object') continue;
    if (content.type === 'text' || content.type === 'reasoning') {
      const ordinal = ordinals[content.type]++;
      const ctime = obj(content.time);
      const part = {
        id: partId(base.messageID, content.type, ordinal),
        sessionID: base.sessionID,
        messageID: base.messageID,
        type: content.type,
        text: str(content.text),
      };
      const start = num(ctime.created || time.created);
      const end = num(ctime.completed || time.completed);
      part.time = end ? { start, end } : { start };
      parts.push(part);
    } else if (content.type === 'tool') {
      parts.push(toolPart(content, base));
    }
  }
  if (time.completed) {
    parts.push({
      id: partId(base.messageID, 'step', 'finish'),
      sessionID: base.sessionID,
      messageID: base.messageID,
      type: 'step-finish',
      reason: str(item.finish || 'stop'),
      cost: num(item.cost),
      tokens: tokensToV1(item.tokens),
    });
  }
  return parts;
}

/**
 * An OpenCode 2 transcript (any order; `session.message.list`) → OpenCode 1's
 * `[{ info, parts }]`, oldest first. A user message has no model or agent of its
 * own in OpenCode 2: it takes what the session last switched to, else the model
 * of the reply that follows it. Rows SynaBun has no use for (idle markers,
 * switches, system notes) are left out.
 */
export function messagesToV1(items, { sessionID, directory = '' } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && typeof item === 'object' && item.id);
  list.sort((a, b) => num(a.time?.created) - num(b.time?.created) || str(a.id).localeCompare(str(b.id)));
  const rows = [];
  let agent = '';
  let model = null;
  let lastUser = '';
  const pendingUsers = [];
  for (const item of list) {
    const base = { sessionID: str(sessionID), messageID: str(item.id) };
    switch (item.type) {
      case 'agent-switched':
        agent = str(item.agent);
        break;
      case 'model-switched':
        model = modelRefToV1(item.model);
        break;
      // A synthetic message is context OpenCode 2 (its plan-mode reminders) or
      // SynaBun (the greeting's note) added for the model; OpenCode 1 kept such
      // text as a synthetic part the transcript never draws: it is left out.
      case 'user': {
        const info = {
          id: base.messageID,
          sessionID: base.sessionID,
          role: 'user',
          time: { created: num(item.time?.created) },
          agent: agent || 'build',
          model: model ? { ...model } : { providerID: '', modelID: '' },
        };
        const parts = [{
          id: partId(base.messageID, 'text', 0),
          sessionID: base.sessionID,
          messageID: base.messageID,
          type: 'text',
          text: str(item.text),
        }];
        parts.push(...userFileParts(item.files, base));
        for (const [index, attached] of (Array.isArray(item.agents) ? item.agents : []).entries()) {
          if (attached?.name) parts.push({ id: partId(base.messageID, 'agent', index), sessionID: base.sessionID, messageID: base.messageID, type: 'agent', name: str(attached.name) });
        }
        const row = { info, parts };
        rows.push(row);
        if (!model) pendingUsers.push(row);
        lastUser = base.messageID;
        break;
      }
      case 'assistant': {
        const info = assistantInfo(item, { sessionID: base.sessionID, directory, parentID: lastUser });
        const ref = modelRefToV1(item.model);
        if (ref) {
          for (const row of pendingUsers.splice(0)) row.info.model = { ...ref };
          if (!agent && item.agent) agent = str(item.agent);
        }
        rows.push({ info, parts: assistantParts(item, base) });
        break;
      }
      case 'compaction': {
        if (item.status !== 'completed' || !item.summary) break;
        const time = num(item.time?.created);
        const ref = modelRefToV1(item.model) || model || { providerID: '', modelID: '' };
        const info = {
          id: base.messageID,
          sessionID: base.sessionID,
          role: 'assistant',
          time: { created: time, completed: time },
          parentID: lastUser,
          modelID: ref.modelID,
          providerID: ref.providerID,
          mode: 'compaction',
          agent: 'compaction',
          path: { cwd: str(directory), root: str(directory) },
          summary: true,
          cost: num(item.cost),
          tokens: tokensToV1(item.tokens),
          finish: 'stop',
        };
        rows.push({ info, parts: [{ id: partId(base.messageID, 'text', 0), sessionID: base.sessionID, messageID: base.messageID, type: 'text', text: str(item.summary), time: { start: time, end: time } }] });
        break;
      }
      case 'shell': {
        // `!command` from the panel: OpenCode 1 showed it as a bash call.
        const time = obj(item.time);
        const info = {
          id: base.messageID,
          sessionID: base.sessionID,
          role: 'assistant',
          time: { created: num(time.created), ...(time.completed ? { completed: num(time.completed) } : {}) },
          parentID: lastUser,
          modelID: model?.modelID || '',
          providerID: model?.providerID || '',
          mode: agent || 'build',
          agent: agent || 'build',
          path: { cwd: str(directory), root: str(directory) },
          cost: 0,
          tokens: tokensToV1(null),
        };
        const done = item.status !== 'running';
        const state = done
          ? { status: 'completed', input: { command: str(item.command) }, output: str(item.output?.output), title: str(item.command), metadata: { exit: item.exit ?? null, status: item.status }, time: { start: num(time.created), end: num(time.completed || time.created) } }
          : { status: 'running', input: { command: str(item.command) }, time: { start: num(time.created) } };
        rows.push({ info, parts: [{ id: partId(base.messageID, 'tool', item.shellID || 'shell'), sessionID: base.sessionID, messageID: base.messageID, type: 'tool', callID: str(item.shellID || item.id), tool: 'bash', state }] });
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

// ── Permissions and questions ───────────────────────────────────────────────

/** OpenCode 2 Permission.Request → OpenCode 1's permission request (the `permission.asked` payload). */
export function permissionToV1(request) {
  const r = obj(request);
  const out = {
    id: str(r.id),
    sessionID: str(r.sessionID),
    permission: v1ToolName(r.action),
    patterns: Array.isArray(r.resources) ? r.resources.map(str) : [],
    metadata: { ...obj(r.metadata), ...(r.message ? { message: str(r.message) } : {}) },
    always: Array.isArray(r.save) ? r.save.map(str) : [],
  };
  if (r.source?.type === 'tool' && r.source.id) out.tool = { messageID: str(r.source.messageID), callID: str(r.source.id) };
  return out;
}

const QUESTION_FIELD_TYPES = new Set(['string', 'multiselect', 'boolean']);

/**
 * An OpenCode 2 form → OpenCode 1's question request, or null for a form that
 * is not a question (an integration's sign-in form has its own flow). The
 * question tool makes one field per question (`q0`, `q1`…): its title is the
 * header, its description the question.
 */
export function formToQuestionV1(form) {
  const f = obj(form);
  const meta = obj(f.metadata);
  const fields = (Array.isArray(f.fields) ? f.fields : []).filter((field) => field && QUESTION_FIELD_TYPES.has(field.type) && !field.hidden);
  if (!f.id || !fields.length) return null;
  if (meta.kind && meta.kind !== 'question') return null;
  const questions = fields.map((field) => {
    const options = field.type === 'boolean'
      ? [{ label: 'Yes', description: '' }, { label: 'No', description: '' }]
      : (Array.isArray(field.options) ? field.options : []).map((option) => ({ label: str(option?.label || option?.value), description: str(option?.description) }));
    const question = {
      question: str(field.description || field.title || f.title),
      header: str(field.title || f.title).slice(0, 30),
      options,
    };
    if (field.type === 'multiselect') question.multiple = true;
    if (field.custom === true || (field.type === 'string' && !options.length)) question.custom = true;
    return question;
  });
  const out = { id: str(f.id), sessionID: str(f.sessionID), questions };
  if (meta.tool?.id) out.tool = { messageID: str(meta.tool.messageID), callID: str(meta.tool.id) };
  return out;
}

/** The keys of a form's question fields, in order (what formToQuestionV1 made questions of). */
export function questionKeys(form) {
  return (Array.isArray(form?.fields) ? form.fields : [])
    .filter((field) => field && QUESTION_FIELD_TYPES.has(field.type) && !field.hidden)
    .map((field) => ({ key: str(field.key), type: field.type, options: Array.isArray(field.options) ? field.options : [] }));
}

/**
 * OpenCode 1 answers (`[[label, …], …]`, one list per question) → an OpenCode
 * 2 form answer `{ key: value }`: a label is sent as its option's value, a
 * multiselect as a list, a yes / no question as a boolean.
 */
export function answersToForm(form, answers) {
  const keys = questionKeys(form);
  const list = Array.isArray(answers) ? answers : [];
  const answer = {};
  keys.forEach((field, index) => {
    const given = (Array.isArray(list[index]) ? list[index] : (list[index] == null ? [] : [list[index]])).map(str).filter((v) => v !== '');
    const valueOf = (label) => {
      const option = field.options.find((o) => str(o?.label) === label || str(o?.value) === label);
      return option ? str(option.value ?? option.label) : label;
    };
    if (field.type === 'multiselect') answer[field.key] = given.map(valueOf);
    else if (field.type === 'boolean') { if (given.length) answer[field.key] = /^(yes|true|y|1)$/i.test(given[0]); }
    else if (given.length) answer[field.key] = valueOf(given[0]);
  });
  return answer;
}

/** A form answer → OpenCode 1 answers (one list per question), for `question.replied`. */
export function formAnswerToV1(form, answer) {
  const a = obj(answer);
  return questionKeys(form).map((field) => {
    const value = a[field.key];
    if (Array.isArray(value)) return value.map(str);
    if (value == null) return [];
    if (typeof value === 'boolean') return [value ? 'Yes' : 'No'];
    return [str(value)];
  });
}

// ── The event translator ────────────────────────────────────────────────────

/**
 * Translates one OpenCode 2 event stream into OpenCode 1 events. Stateful: it
 * keeps each assistant message and its parts (text and reasoning grow from
 * deltas, a tool call from its input to its result), the user prompts waiting
 * in a session's inbox, the sessions it has seen and which session a pending
 * permission or form belongs to (lib/opencode2-client.js answers them by id).
 *
 * `translate(event)` → `[{ directory, payload: { id, type, properties } }]`,
 * the shape OpenCode 1's `/global/event` streamed. `version` is the serve's
 * (OpenCode 1 sessions carry the version that made them).
 */
export function createEventTranslator({ version = '', directory: defaultDirectory = '' } = {}) {
  const sessions = new Map();     // sessionID → { info (v1), directory, lastUser, compacting }
  const messages = new Map();     // assistant messageID → { info, parts: Map(kind:key → part), sessionID }
  const inbox = new Map();        // inboxID → { sessionID, item }
  const permissions = new Map();  // requestID → sessionID
  const forms = new Map();        // formID → form
  const MAX_MESSAGES = 400;
  const MAX_INBOX = 200;

  const sessionState = (sessionID) => {
    let state = sessions.get(sessionID);
    if (!state) {
      state = { info: null, directory: '', lastUser: '', compacting: 0 };
      sessions.set(sessionID, state);
    }
    return state;
  };
  const directoryOf = (event, sessionID) => str(event?.location?.directory)
    || (sessionID ? sessions.get(sessionID)?.directory : '')
    || defaultDirectory;

  const trim = (map, max) => {
    while (map.size > max) map.delete(map.keys().next().value);
  };

  /** Remember a session as OpenCode 2 answered it (list / get / create), so its events carry the whole Session. */
  function noteSession(info, extra = {}) {
    if (!info?.id) return null;
    const state = sessionState(str(info.id));
    const prior = state.info || {};
    const v1 = sessionToV1(info, { version, slug: prior.slug, ...extra });
    if (!v1.title && prior.title) v1.title = prior.title;
    if (!v1.slug && prior.slug) v1.slug = prior.slug;
    state.info = v1;
    state.directory = v1.directory || state.directory;
    return v1;
  }

  const sessionInfo = (sessionID, patch = null) => {
    const state = sessionState(sessionID);
    const base = state.info || { id: sessionID, slug: '', projectID: '', directory: state.directory, title: '', version, time: { created: 0, updated: 0 } };
    const next = patch ? { ...base, ...patch, time: { ...base.time, ...(patch.time || {}) } } : { ...base };
    if (state.compacting) next.time = { ...next.time, compacting: state.compacting };
    else if (next.time?.compacting) { next.time = { ...next.time }; delete next.time.compacting; }
    state.info = next;
    return next;
  };

  const messageState = (sessionID, messageID) => {
    let state = messages.get(messageID);
    if (!state) {
      state = { sessionID, info: null, parts: new Map() };
      messages.set(messageID, state);
      trim(messages, MAX_MESSAGES);
    }
    return state;
  };

  function translate(event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return [];
    const data = obj(event.data);
    const sessionID = str(data.sessionID);
    const at = num(event.created, Date.now());
    const out = [];
    const emit = (type, properties) => {
      out.push({
        directory: directoryOf(event, sessionID || properties?.sessionID),
        payload: { id: `${str(event.id) || 'evt'}${out.length ? `-${out.length}` : ''}`, type, properties },
      });
    };
    const assistant = (messageID) => {
      const state = messageState(sessionID, messageID);
      if (!state.info) {
        const session = sessionState(sessionID);
        state.info = assistantInfo({ id: messageID, time: { created: at } }, { sessionID, directory: directoryOf(event, sessionID), parentID: session.lastUser });
      }
      return state;
    };
    const updateMessage = (state) => emit('message.updated', { sessionID, info: { ...state.info, time: { ...state.info.time }, tokens: tokensToV1(state.info.tokens) } });
    const updatePart = (part) => emit('message.part.updated', { sessionID, part: { ...part, ...(part.state ? { state: { ...part.state } } : {}) }, time: at });
    const streamPart = (kind, d, patch) => {
      const messageID = str(d.assistantMessageID);
      const state = assistant(messageID);
      const key = `${kind}:${num(d.ordinal)}`;
      let part = state.parts.get(key);
      if (!part) {
        part = { id: partId(messageID, kind, num(d.ordinal)), sessionID, messageID, type: kind, text: '', time: { start: at } };
        state.parts.set(key, part);
      }
      Object.assign(part, patch);
      return part;
    };
    const toolOf = (d) => {
      const messageID = str(d.assistantMessageID);
      const state = assistant(messageID);
      const callID = str(d.id);
      const key = `tool:${callID}`;
      let part = state.parts.get(key);
      if (!part) {
        part = { id: partId(messageID, 'tool', callID), sessionID, messageID, type: 'tool', callID, tool: '', state: { status: 'pending', input: {}, raw: '' }, created: at };
        state.parts.set(key, part);
      }
      return part;
    };
    const publicTool = (part) => {
      const { created, ...rest } = part;
      return rest;
    };
    const turnEnd = (error = null) => {
      if (error) emit('session.error', { sessionID, error });
      emit('session.status', { sessionID, status: { type: 'idle' } });
      emit('session.idle', { sessionID });
    };

    switch (event.type) {
      case 'server.connected':
        emit('server.connected', {});
        break;

      // ── Sessions ──
      case 'session.created': {
        const state = sessionState(sessionID);
        state.directory = str(data.location?.directory) || state.directory;
        const info = noteSession({
          id: sessionID,
          projectID: data.projectID,
          parentID: data.parentID,
          title: data.title,
          agent: data.agent,
          model: data.model,
          metadata: data.metadata,
          permissions: data.permissions,
          location: data.location,
          time: { created: at, updated: at },
        }, { slug: str(data.slug), version: str(data.version) || version });
        emit('session.created', { sessionID, info });
        break;
      }
      case 'session.renamed':
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { title: str(data.title), time: { updated: at } }) });
        break;
      case 'session.metadata.updated':
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { metadata: obj(data.metadata), time: { updated: at } }) });
        break;
      case 'session.permissions':
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { permission: rulesToV1(data.permissions) || [], time: { updated: at } }) });
        break;
      case 'session.agent.selected':
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { agent: str(data.agent), time: { updated: at } }) });
        break;
      case 'session.model.selected':
        if (data.model?.id) emit('session.updated', { sessionID, info: sessionInfo(sessionID, { model: { id: str(data.model.id), providerID: str(data.model.providerID), ...(data.model.variant ? { variant: str(data.model.variant) } : {}) }, time: { updated: at } }) });
        break;
      case 'session.moved': {
        const state = sessionState(sessionID);
        state.directory = str(data.location?.directory) || state.directory;
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { directory: state.directory, time: { updated: at } }) });
        break;
      }
      case 'session.usage.updated':
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { cost: num(data.cost), tokens: tokensToV1(data.tokens) }) });
        break;
      case 'session.revert.staged':
        emit('session.updated', { sessionID, info: sessionInfo(sessionID, { revert: data.revert?.messageID ? { messageID: str(data.revert.messageID), ...(data.revert.partID ? { partID: str(data.revert.partID) } : {}), ...(data.revert.snapshot ? { snapshot: str(data.revert.snapshot) } : {}) } : undefined, time: { updated: at } }) });
        break;
      case 'session.revert.cleared':
      case 'session.revert.committed': {
        const info = sessionInfo(sessionID, { time: { updated: at } });
        delete info.revert;
        emit('session.updated', { sessionID, info });
        break;
      }
      case 'session.deleted': {
        const info = sessionInfo(sessionID);
        sessions.delete(sessionID);
        emit('session.deleted', { sessionID, info });
        break;
      }
      case 'session.forked':
        break;

      // ── Prompts ──
      case 'session.inbox.enqueued':
        if (data.inboxID && data.item) {
          inbox.set(str(data.inboxID), { sessionID, item: data.item });
          trim(inbox, MAX_INBOX);
        }
        break;
      case 'session.inbox.cancelled':
        inbox.delete(str(data.inboxID));
        break;
      case 'session.inbox.delivered': {
        const entry = inbox.get(str(data.inboxID));
        inbox.delete(str(data.inboxID));
        const item = entry?.item;
        // Only a person's prompt is a user message; a synthetic item is context
        // for the model (see messagesToV1), a compaction or a move is not a message.
        if (!item || item.type !== 'user') break;
        const messageID = str(data.inboxID);
        const session = sessionState(sessionID);
        session.lastUser = messageID;
        const info = session.info || {};
        const model = info.model ? { providerID: str(info.model.providerID), modelID: str(info.model.id), ...(info.model.variant ? { variant: str(info.model.variant) } : {}) } : { providerID: '', modelID: '' };
        emit('message.updated', { sessionID, info: { id: messageID, sessionID, role: 'user', time: { created: at }, agent: str(info.agent) || 'build', model } });
        const payload = obj(item.payload);
        updatePart({ id: partId(messageID, 'text', 0), sessionID, messageID, type: 'text', text: str(payload.text) });
        (Array.isArray(payload.files) ? payload.files : []).forEach((file, index) => {
          // A prompt's attachment arrives as the uri it was sent with.
          if (file?.uri) updatePart({ id: partId(messageID, 'file', index), sessionID, messageID, type: 'file', mime: str(file.mime) || 'application/octet-stream', ...(file.name ? { filename: str(file.name) } : {}), url: str(file.uri) });
        });
        break;
      }

      // ── A turn ──
      case 'session.execution.started':
        emit('session.status', { sessionID, status: { type: 'busy' } });
        break;
      case 'session.retry.scheduled':
        emit('session.status', { sessionID, status: { type: 'retry', attempt: num(data.attempt), message: str(data.error?.message) || 'Retrying', next: num(data.at) } });
        break;
      case 'session.execution.succeeded':
        turnEnd(null);
        break;
      case 'session.execution.failed':
        turnEnd(errorToV1(data.error));
        break;
      case 'session.execution.interrupted':
        // OpenCode 1 ended a stopped turn with MessageAbortedError: the panel
        // shows "Stopped", the loops and the brain read it as an abort.
        turnEnd({ name: 'MessageAbortedError', data: { message: `The turn was stopped (${str(data.reason) || 'user'}).` } });
        break;

      case 'session.step.started': {
        const messageID = str(data.assistantMessageID);
        const state = assistant(messageID);
        const model = obj(data.model);
        state.info = {
          ...state.info,
          time: { created: num(data.started, at) },
          modelID: str(model.id),
          providerID: str(model.providerID),
          mode: str(data.agent),
          agent: str(data.agent),
          ...(model.variant ? { variant: str(model.variant) } : {}),
        };
        updateMessage(state);
        updatePart({ id: partId(messageID, 'step', 'start'), sessionID, messageID, type: 'step-start', ...(data.snapshot ? { snapshot: str(data.snapshot) } : {}) });
        break;
      }
      case 'session.step.ended': {
        const messageID = str(data.assistantMessageID);
        const state = assistant(messageID);
        state.info = { ...state.info, time: { ...state.info.time, completed: at }, finish: str(data.finish), cost: num(data.cost), tokens: tokensToV1(data.tokens) };
        updatePart({ id: partId(messageID, 'step', 'finish'), sessionID, messageID, type: 'step-finish', reason: str(data.finish || 'stop'), cost: num(data.cost), tokens: tokensToV1(data.tokens), ...(data.snapshot ? { snapshot: str(data.snapshot) } : {}) });
        updateMessage(state);
        break;
      }
      case 'session.step.failed': {
        const messageID = str(data.assistantMessageID);
        const state = assistant(messageID);
        state.info = {
          ...state.info,
          time: { ...state.info.time, completed: at },
          finish: 'error',
          error: errorToV1(data.error),
          ...(data.cost != null ? { cost: num(data.cost) } : {}),
          ...(data.tokens ? { tokens: tokensToV1(data.tokens) } : {}),
        };
        updateMessage(state);
        break;
      }

      case 'session.text.started':
      case 'session.reasoning.started': {
        const kind = event.type === 'session.text.started' ? 'text' : 'reasoning';
        updatePart(streamPart(kind, data, {}));
        break;
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const kind = event.type === 'session.text.delta' ? 'text' : 'reasoning';
        const part = streamPart(kind, data, {});
        const delta = str(data.delta);
        if (!delta) break;
        part.text += delta;
        emit('message.part.delta', { sessionID, messageID: part.messageID, partID: part.id, field: 'text', delta });
        break;
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const kind = event.type === 'session.text.ended' ? 'text' : 'reasoning';
        const part = streamPart(kind, data, {});
        part.text = str(data.text);
        part.time = { start: num(part.time?.start, at), end: at };
        updatePart(part);
        break;
      }

      case 'session.tool.input.started': {
        const part = toolOf(data);
        part.tool = v1ToolName(data.name);
        part.state = { status: 'pending', input: {}, raw: '' };
        updatePart(publicTool(part));
        break;
      }
      case 'session.tool.input.delta': {
        const part = toolOf(data);
        if (part.state.status === 'pending') part.state = { ...part.state, raw: str(part.state.raw) + str(data.delta) };
        break;
      }
      case 'session.tool.input.ended': {
        const part = toolOf(data);
        let input = {};
        try { input = obj(JSON.parse(str(data.text))); } catch { /* the call's own event carries the parsed input */ }
        if (part.state.status === 'pending') part.state = { status: 'pending', input, raw: str(data.text) };
        updatePart(publicTool(part));
        break;
      }
      case 'session.tool.called': {
        const part = toolOf(data);
        part.state = { status: 'running', input: obj(data.input), time: { start: at } };
        updatePart(publicTool(part));
        break;
      }
      case 'session.tool.progress': {
        const part = toolOf(data);
        const start = num(part.state.time?.start, at);
        part.state = { ...part.state, status: 'running', metadata: { ...obj(part.state.metadata), ...obj(data.metadata) }, time: { start } };
        updatePart(publicTool(part));
        break;
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const part = toolOf(data);
        const start = num(part.state.time?.start, part.created || at);
        const state = event.type === 'session.tool.success'
          ? { status: 'completed', input: obj(part.state.input), content: data.content, metadata: data.metadata }
          : { status: 'error', input: obj(part.state.input), error: data.error, metadata: data.metadata };
        part.state = toolStateToV1(state, { name: part.tool, times: { ran: start, completed: at }, base: { sessionID, messageID: part.messageID, callID: part.callID } });
        updatePart(publicTool(part));
        break;
      }

      // ── Compaction ──
      case 'session.compaction.started':
        sessionState(sessionID).compacting = at;
        emit('session.updated', { sessionID, info: sessionInfo(sessionID) });
        break;
      case 'session.compaction.ended':
      case 'session.compaction.failed': {
        sessionState(sessionID).compacting = 0;
        if (event.type === 'session.compaction.failed') emit('session.error', { sessionID, error: errorToV1(data.error) });
        emit('session.updated', { sessionID, info: sessionInfo(sessionID) });
        emit('session.compacted', { sessionID });
        break;
      }

      // ── Asks ──
      case 'permission.asked': {
        const request = permissionToV1(data);
        if (!request.id) break;
        permissions.set(request.id, request.sessionID);
        trim(permissions, MAX_INBOX);
        emit('permission.asked', request);
        break;
      }
      case 'permission.replied':
        permissions.delete(str(data.requestID));
        emit('permission.replied', { sessionID, requestID: str(data.requestID), reply: str(data.reply) });
        break;
      case 'form.created': {
        const form = data.form;
        const question = formToQuestionV1(form);
        if (!question) break;
        forms.set(question.id, form);
        trim(forms, MAX_INBOX);
        emit('question.asked', question);
        break;
      }
      case 'form.replied': {
        const form = forms.get(str(data.id));
        forms.delete(str(data.id));
        if (!form) break;
        emit('question.replied', { sessionID: str(data.sessionID), requestID: str(data.id), answers: formAnswerToV1(form, data.answer) });
        break;
      }
      case 'form.cancelled': {
        const known = forms.has(str(data.id));
        forms.delete(str(data.id));
        if (known) emit('question.rejected', { sessionID: str(data.sessionID), requestID: str(data.id) });
        break;
      }

      // ── The rest of the workspace ──
      case 'vcs.branch.updated':
        emit('vcs.branch.updated', { branch: str(data.branch) });
        break;
      case 'mcp.status.changed':
      case 'mcp.resources.changed':
        emit('mcp.tools.changed', { server: str(data.server) });
        break;
      case 'installation.update-available':
      case 'installation.updated':
        emit(event.type, { version: str(data.version) });
        break;
      case 'filesystem.changed':
        emit('file.watcher.updated', { file: str(data.file), event: str(data.event) });
        break;
      default:
        break;
    }
    return out;
  }

  return {
    translate,
    noteSession,
    /** The session a pending permission request belongs to (OpenCode 2 answers it under the session). */
    permissionSession: (requestID) => permissions.get(str(requestID)) || null,
    /** A pending question's form (its field keys turn OpenCode 1 answers into a form answer). */
    form: (formID) => forms.get(str(formID)) || null,
    noteForm: (form) => { if (form?.id) { forms.set(str(form.id), form); trim(forms, MAX_INBOX); } },
    notePermission: (requestID, sessionID) => { if (requestID && sessionID) { permissions.set(str(requestID), str(sessionID)); trim(permissions, MAX_INBOX); } },
    sessionDirectory: (sessionID) => sessions.get(str(sessionID))?.directory || '',
  };
}

export const OPENCODE2_TRANSLATE_INTERNALS = Object.freeze({ ZERO_TOKENS });
