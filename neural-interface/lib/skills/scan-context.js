import { readHeadOf } from './export.js';
import { bundleNameProblem } from './bundle.js';
class NameError extends Error { constructor(status, message, code) { super(message); Object.assign(this, { status, code }); } }

/**
 * The name a revision is installed under (its folder's name): its SKILL.md name when that can be a folder name,
 * else the library's. The plan, the review's evidence and an approval all use this one name.
 */
export function effectiveInstallName(skill, files) {
  const { parsed } = readHeadOf(files);
  const fmName = typeof parsed.data?.name === 'string' ? parsed.data.name.trim() : '';
  const candidate = fmName && !bundleNameProblem(fmName) ? fmName : skill?.name;
  if (!candidate || bundleNameProblem(candidate)) throw new NameError(422, 'This skill has no name that can be a folder\'s name: give its SKILL.md a "name".', 'invalid_name');
  return candidate;
}

/**
 * The names a scan checks a skill's install name against: every name SynaBun ships (look-alikes), and those it
 * must not take (all of them but the skill's own when it is that shipped skill, in the library as bundled).
 */
export function nameChecks(skill, name, shipped = []) {
  const all = [...new Set((shipped || []).filter((n) => typeof n === 'string' && n))];
  const own = skill?.origin?.kind === 'bundled' ? String(skill.origin.name || skill.name || '').toLowerCase() : '';
  const notOwn = all.filter((n) => n.toLowerCase() !== own || own !== String(name || '').toLowerCase());
  return { knownNames: notOwn, reservedNames: notOwn };
}
