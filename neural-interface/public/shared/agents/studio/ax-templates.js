// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: starting points for a new agent
// ═══════════════════════════════════════════
//
// The creator offers a few sensible roles to start from. A template is only a filled form: what it sets is what
// the editor then shows, the owner changes anything, and the result is a draft like any other (nothing is approved
// by choosing one). The words (name, description, instructions) are the page's strings
// (`agentsStudio.templates.<id>.*`), so a template reads in the page's language. Every template asks for the least
// it needs: review and research read only, the rest stay in the workspace; none is `full`.
// No DOM and no imports.

import { blankForm, slugOf } from './ax-form.js';

export const TEMPLATES = Object.freeze([
  { id: 'reviewer', icon: 'eye', color: 'status.warning', capability: 'read-only', permissionPolicy: 'auto', usesBrowser: false, taskClasses: ['review'] },
  { id: 'implementer', icon: 'code', color: 'primary.500', capability: 'workspace', permissionPolicy: 'auto', usesBrowser: false, taskClasses: ['code', 'complex'] },
  { id: 'researcher', icon: 'search', color: 'status.running', capability: 'read-only', permissionPolicy: 'auto', usesBrowser: true, taskClasses: ['research'] },
  { id: 'writer', icon: 'pen', color: 'secondary.500', capability: 'workspace', permissionPolicy: 'auto', usesBrowser: false, taskClasses: ['quick'] },
  { id: 'tester', icon: 'globe', color: 'status.success', capability: 'workspace', permissionPolicy: 'auto', usesBrowser: true, taskClasses: ['browser'] },
]);

export const templateById = (id) => TEMPLATES.find((template) => template.id === id) || null;

/**
 * The form a template starts the editor with. `t` gives the template's words; `known.taskClasses` (the server's
 * list) drops a class the server does not name, `provider` is the one a new agent starts on.
 */
export function templateForm(template, t, { provider = '', scope = null, taskClasses = null, idLimit = 64 } = {}) {
  const form = blankForm({ provider, scope });
  if (!template) return form;
  const name = t(`agentsStudio.templates.${template.id}.name`);
  const known = Array.isArray(taskClasses) ? new Set(taskClasses) : null;
  return {
    ...form,
    name, id: slugOf(name, idLimit),
    description: t(`agentsStudio.templates.${template.id}.description`),
    instructions: t(`agentsStudio.templates.${template.id}.instructions`),
    icon: template.icon, color: template.color,
    capability: template.capability, permissionPolicy: template.permissionPolicy,
    usesBrowser: template.usesBrowser === true,
    taskClasses: template.taskClasses.filter((cls) => !known || known.has(cls)),
  };
}

/** The text handed to the Assistant when the owner describes an agent instead of filling the form. */
export function describeRequest(description, t, { scope = null } = {}) {
  const what = String(description || '').trim();
  const where = scope?.kind === 'project' ? t('agentsStudio.create.describe.requestProject', { path: scope.path }) : t('agentsStudio.create.describe.requestGlobal');
  return `${t('agentsStudio.create.describe.request')}\n\n${what}\n\n${where}`;
}
