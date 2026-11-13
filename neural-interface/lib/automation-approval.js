// ── The owner's approval of what an agent changed (re-review of 2026-11-11, finding 3) ──
//
// A schedule an agent created or last changed (`taskBy: 'agent'`) and a template an agent created or changed
// (`editedBy: 'agent'`) are held to the owner's list of profiles agents may choose (lib/morelogin-agent-profiles.js
// scheduleProfileAuthority). Until 2026-11-11 an owner's save took the mark away when it carried certain fields, and the
// Schedules editor sent them by itself, so opening a marked schedule to rename it cleared the mark although the owner
// reviewed nothing. The owner's decision: no save ever clears a mark; an explicit approve action does, from the owner's
// page only, tied to the exact content the owner was shown.
//
// How:
//   • The server builds the review (what will actually run and where) from the stored records: scheduleReview /
//     templateReview. It shows the effective instructions (the template's task and context, every day theme's text,
//     the two numbers a launch reads from `overrides`) and the account (the MoreLogin profile the run uses, by name,
//     or the default browser of Settings → Browser), who chose that profile, and whether it is on the owner's list.
//   • Its digest (reviewDigest) is a SHA-256 over the stored fields a launch reads for that content, never over the
//     display text: the schedule's template, day themes, overrides, group, own profile, the marks; the template's task
//     and context; the group's profile; the default browser. Anything an agent (or anybody) changes there after the
//     review was served changes the digest, and the approve request, which carries the digest it was shown, is refused
//     (409 REVIEW_CHANGED). Nothing about the request's own words is trusted: the server recomputes.
//   • Approving a schedule clears its mark and, in the same act, the mark of its template (one flow for the owner).
//     When the profile is the schedule's own, the owner approving "runs in <profile>" is the owner choosing that
//     profile, so `moreloginEnvBy` becomes 'owner'. A group's profile chosen by an agent is the group's: approving one
//     schedule never makes it the owner's for the group's other schedules (the review says so).
//   • Any later change by an agent marks the record again (server.js markScheduleTaskAuthor / markTemplateAuthor).
//   • Restored and imported records come in marked (`unreviewedFrom`: 'restore' / 'import'), because a file is data: no
//     field in it can say "the owner approved this". markRecordsUnreviewed only adds marks, never removes one.
//
// DOM-free, no imports but node:crypto. Unit-tested in tests/automation-approval.test.mjs.

import { createHash } from 'node:crypto';

/** The version of the digest's input; bump it when the fields change, so an old review can never match. */
export const APPROVAL_DIGEST_VERSION = 'ap1';
/** The refusal codes of the approve routes. */
export const REVIEW_CHANGED = 'REVIEW_CHANGED';
export const NOTHING_TO_APPROVE = 'NOTHING_TO_APPROVE';
/** Where a mark came from when it was not an agent's own change (display only; authority reads `taskBy` / `editedBy`). */
export const UNREVIEWED_SOURCES = Object.freeze(['import', 'restore']);

const str = (value) => (value === null || value === undefined ? null : String(value));
const weekdayOrder = ['1', '2', '3', '4', '5', '6', '0'];

/** JSON with object keys sorted at every level, so equal content always hashes equally. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The day themes as a launch reads them: weekday → contextOverride text (empty entries left out). */
function themeTexts(dayThemes) {
  const out = [];
  if (!dayThemes || typeof dayThemes !== 'object') return out;
  for (const day of weekdayOrder) {
    const entry = dayThemes[day];
    if (!entry) continue;
    const text = typeof entry === 'string' ? entry : (typeof entry.contextOverride === 'string' ? entry.contextOverride : '');
    out.push({ day: Number(day), text, label: typeof entry === 'object' && typeof entry.theme === 'string' ? entry.theme : null });
  }
  return out;
}

/** The stored template fields that decide its instructions (and its mark). */
function templateCore(template) {
  if (!template) return null;
  return {
    id: str(template.id), name: str(template.name), task: str(template.task), context: str(template.context),
    usesBrowser: template.usesBrowser === undefined ? null : !!template.usesBrowser,
    editedBy: template.editedBy === 'agent' ? 'agent' : null, unreviewedFrom: str(template.unreviewedFrom),
  };
}

/** The stored schedule fields that decide what it runs and where (and its mark). */
function scheduleCore(schedule) {
  return {
    id: str(schedule.id), templateId: str(schedule.templateId), dayThemes: schedule.dayThemes ?? null,
    overrides: schedule.overrides ?? null, groupId: str(schedule.groupId),
    moreloginEnvId: str(schedule.moreloginEnvId), moreloginEnvBy: str(schedule.moreloginEnvBy),
    usesBrowser: schedule.usesBrowser === undefined ? null : !!schedule.usesBrowser,
    taskBy: schedule.taskBy === 'agent' ? 'agent' : null, unreviewedFrom: str(schedule.unreviewedFrom),
  };
}

/** The group fields a schedule's run reads for its account. */
function groupCore(group) {
  if (!group) return null;
  return {
    id: str(group.id), moreloginEnvId: str(group.moreloginEnvId), moreloginEnvBy: str(group.moreloginEnvBy),
    usesBrowser: group.usesBrowser === undefined ? null : !!group.usesBrowser,
  };
}

/** The default browser of Settings → Browser, as far as the account goes. */
function defaultCore(browserDefault) {
  const mode = ['attach', 'morelogin'].includes(browserDefault?.connectMode) ? browserDefault.connectMode : 'mirror';
  return { connectMode: mode, moreloginEnvId: mode === 'morelogin' ? str(browserDefault?.moreloginEnvId) : null };
}

/** The digest of a review's input (hex SHA-256 of the canonical JSON, prefixed by APPROVAL_DIGEST_VERSION). */
export function reviewDigest(input) {
  return `${APPROVAL_DIGEST_VERSION}:${createHash('sha256').update(canonicalJson({ v: APPROVAL_DIGEST_VERSION, ...input })).digest('hex')}`;
}

/** Whether `a` and `b` are the same digest (a string compare that takes the same time whatever matches). */
export function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length || !x.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Whether a record carries a mark the approve action is for. */
export const scheduleMarked = (schedule) => schedule?.taskBy === 'agent';
export const templateMarked = (template) => template?.editedBy === 'agent';

/**
 * The account a schedule's run uses: its own profile, else its group's, else the default browser.
 * @param {{ allowed?: (envId: string) => boolean, profileName?: (envId: string) => string|null }} o
 */
function accountOf(schedule, group, browserDefault, { allowed = () => false, profileName = () => null } = {}) {
  const holder = schedule.moreloginEnvId ? schedule : (group?.moreloginEnvId ? group : null);
  if (holder) {
    const envId = String(holder.moreloginEnvId);
    return {
      kind: 'morelogin', envId, name: holder.moreloginEnvName || profileName(envId) || null,
      source: holder === schedule ? 'schedule' : 'group', groupName: holder === schedule ? null : (group?.name || null),
      chosenBy: holder.moreloginEnvBy === 'owner' ? 'owner' : 'agent', onList: allowed(envId) === true,
    };
  }
  const def = defaultCore(browserDefault);
  return {
    kind: 'default', connectMode: def.connectMode, envId: def.moreloginEnvId,
    name: def.moreloginEnvId ? (profileName(def.moreloginEnvId) || null) : null, source: 'default', chosenBy: 'owner', onList: null,
  };
}

/**
 * Where a marked schedule stands now, for the flag in its list and editor:
 *   'no-profile'  — it runs in the default browser (the owner's choice), the mark changes nothing today;
 *   'on-list'     — it runs in a profile on the owner's list, as today, mark or not;
 *   'blocked'     — it runs in a profile off the list, and its runs are refused until the owner approves it;
 *   'clear'       — nothing is marked.
 */
export function approvalCase({ marked, account }) {
  if (!marked) return 'clear';
  if (!account || account.kind !== 'morelogin') return 'no-profile';
  return account.onList ? 'on-list' : 'blocked';
}

/**
 * The review of a schedule: what will run and where, and the digest the approve request must carry.
 * @param {{ schedule: object, template?: object|null, group?: object|null, browserDefault?: object,
 *   allowed?: (envId: string) => boolean, profileName?: (envId: string) => string|null }} o
 */
export function scheduleReview({ schedule, template = null, group = null, browserDefault = {}, allowed, profileName } = {}) {
  if (!schedule) return null;
  const account = accountOf(schedule, group, browserDefault, { allowed, profileName });
  const marks = {
    schedule: scheduleMarked(schedule), template: templateMarked(template),
    scheduleFrom: scheduleMarked(schedule) ? (UNREVIEWED_SOURCES.includes(schedule.unreviewedFrom) ? schedule.unreviewedFrom : 'agent') : null,
    templateFrom: templateMarked(template) ? (UNREVIEWED_SOURCES.includes(template.unreviewedFrom) ? template.unreviewedFrom : 'agent') : null,
  };
  const overrides = schedule.overrides && typeof schedule.overrides === 'object' ? schedule.overrides : {};
  const digest = reviewDigest({
    kind: 'schedule', schedule: scheduleCore(schedule), template: templateCore(template), group: groupCore(group),
    browserDefault: account.kind === 'default' ? defaultCore(browserDefault) : null,
  });
  // After approval: the schedule's own profile becomes the owner's choice; a group's stays whoever chose it.
  const ownerAfter = account.kind !== 'morelogin' || account.source === 'schedule' || account.chosenBy === 'owner';
  return {
    kind: 'schedule', id: str(schedule.id), name: str(schedule.name), digest,
    marks, needsApproval: marks.schedule || marks.template,
    case: approvalCase({ marked: marks.schedule || marks.template, account }),
    instructions: {
      templateId: str(schedule.templateId), templateName: template ? str(template.name) : null, templateMissing: !template,
      task: template ? str(template.task) : null, context: template ? str(template.context) : null,
      dayThemes: themeTexts(schedule.dayThemes),
      iterations: overrides.iterations ?? null, maxMinutes: overrides.maxMinutes ?? null,
    },
    account,
    afterApproval: account.kind !== 'morelogin' ? 'default' : (ownerAfter ? 'owner' : 'list'),
  };
}

/**
 * The review of a template: its instructions, and which schedules run it (with their accounts, for display).
 * @param {{ template: object, schedules?: object[], groups?: object[], browserDefault?: object, allowed?, profileName? }} o
 */
export function templateReview({ template, schedules = [], groups = [], browserDefault = {}, allowed, profileName } = {}) {
  if (!template) return null;
  const marked = templateMarked(template);
  const usedBy = schedules.filter((s) => s && s.templateId === template.id).map((s) => {
    const group = s.groupId ? groups.find((g) => g.id === s.groupId) || null : null;
    return { id: str(s.id), name: str(s.name), marked: scheduleMarked(s), account: accountOf(s, group, browserDefault, { allowed, profileName }) };
  });
  return {
    kind: 'template', id: str(template.id), name: str(template.name),
    digest: reviewDigest({ kind: 'template', template: templateCore(template) }),
    marks: { template: marked, templateFrom: marked ? (UNREVIEWED_SOURCES.includes(template.unreviewedFrom) ? template.unreviewedFrom : 'agent') : null },
    needsApproval: marked,
    instructions: { task: str(template.task), context: str(template.context) },
    usedBy,
  };
}

/** Takes the marks away (the approve action's write). Returns the record. */
export function clearScheduleMark(schedule, { ownProfileToOwner = false } = {}) {
  delete schedule.taskBy;
  delete schedule.unreviewedFrom;
  if (ownProfileToOwner && schedule.moreloginEnvId) schedule.moreloginEnvBy = 'owner';
  return schedule;
}
export function clearTemplateMark(template) {
  delete template.editedBy;
  delete template.unreviewedFrom;
  return template;
}

/**
 * Marks every record of a restored or imported file unreviewed (finding 2: an archive is data, nothing in it may say
 * "the owner approved this"). Only adds marks: a record already marked keeps its mark. A schedule's own profile is
 * kept, but who chose it is not believed: `moreloginEnvBy: 'owner'` from a file becomes 'agent' until approved.
 * @param {unknown} data the parsed file: an array of records, or { templates } / { schedules, groups }
 * @param {'templates'|'schedules'} kind
 * @param {'import'|'restore'} source
 * @returns {{ data: unknown, marked: number }}
 */
export function markRecordsUnreviewed(data, kind, source = 'restore') {
  let marked = 0;
  const field = kind === 'templates' ? 'editedBy' : 'taskBy';
  const mark = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    if (record[field] !== 'agent') { record[field] = 'agent'; record.unreviewedFrom = source; marked++; }
    if (kind === 'schedules' && record.moreloginEnvId && record.moreloginEnvBy === 'owner') record.moreloginEnvBy = 'agent';
  };
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? data[kind] : null);
  if (Array.isArray(rows)) rows.forEach(mark);
  if (kind === 'schedules' && data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.groups)) {
    // A group's profile in a file was not chosen in front of this server either.
    for (const group of data.groups) if (group && typeof group === 'object' && group.moreloginEnvId && group.moreloginEnvBy === 'owner') group.moreloginEnvBy = 'agent';
  }
  return { data, marked };
}
