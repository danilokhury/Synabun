// R02 and the audit it asked for: paths built from a browser-supplied id or name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSessionTranscript, confineArtifact, confineSubPath, confineToRoot, staysInside, realPathOf, isInsideReal, isInside, isPlainName, isSessionId, PathConfineError } from '../lib/path-confine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const keyOf = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'synabun-confine-'));
  const projectsDir = join(root, 'claude', 'projects');
  const projectA = join(root, 'work', 'a');
  const projectB = join(root, 'work', 'b');
  for (const p of [projectA, projectB]) mkdirSync(join(projectsDir, keyOf(p)), { recursive: true });
  return { root, projectsDir, projectA, projectB, projects: [{ path: projectA }, { path: projectB }], done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a session id that is not a UUID never becomes a path', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, 'secret.jsonl'), '{"type":"user"}\n');
    const seen = [];
    const base = { projects: s.projects, projectsDir: s.projectsDir, pathToKey: keyOf, exists: (p) => { seen.push(p); return true; } };
    for (const bad of ['../../../secret', `../${ID}`, `${ID}/../../x`, `${ID}\0`, '', null, undefined, 42, `${ID}.jsonl`, 'a'.repeat(36)]) {
      assert.throws(() => findSessionTranscript({ ...base, sessionId: bad }), (e) => e instanceof PathConfineError && e.status === 400, `accepted ${String(bad)}`);
    }
    assert.deepEqual(seen, [], 'no path was probed for a refused id');
    assert.ok(isSessionId(ID));
    assert.ok(!isSessionId(`${ID} `));
  } finally { s.done(); }
});

test('the transcript is found in a registered project, the named one first', () => {
  const s = sandbox();
  try {
    const inA = join(s.projectsDir, keyOf(s.projectA), `${ID}.jsonl`);
    const inB = join(s.projectsDir, keyOf(s.projectB), `${ID}.jsonl`);
    writeFileSync(inA, '');
    writeFileSync(inB, '');
    const base = { sessionId: ID, projects: s.projects, projectsDir: s.projectsDir, pathToKey: keyOf };
    assert.equal(findSessionTranscript(base).filePath, inA);
    assert.equal(findSessionTranscript({ ...base, project: s.projectB }).filePath, inB);
    // A named project is honoured strictly (review 2, R02): one that is not
    // registered is refused, and one that does not hold the transcript is not
    // answered from another project's folder.
    assert.throws(() => findSessionTranscript({ ...base, project: join(s.root, 'elsewhere') }), (e) => e instanceof PathConfineError && e.status === 400);
    rmSync(inB);
    assert.equal(findSessionTranscript({ ...base, project: s.projectB }), null, 'project B does not hold it: project A is not searched instead');
    assert.equal(findSessionTranscript(base).filePath, inA, 'no project named: every registered project is searched');
    assert.equal(findSessionTranscript({ ...base, sessionId: '11111111-2222-3333-4444-555555555555' }), null);
    assert.equal(findSessionTranscript({ ...base, projects: [] }), null);
  } finally { s.done(); }
});

test('a transcript that resolves outside its folder is not read', () => {
  const s = sandbox();
  try {
    const outside = join(s.root, 'outside.jsonl');
    writeFileSync(outside, '{"type":"user"}\n');
    symlinkSync(outside, join(s.projectsDir, keyOf(s.projectA), `${ID}.jsonl`));
    assert.equal(findSessionTranscript({ sessionId: ID, projects: s.projects, projectsDir: s.projectsDir, pathToKey: keyOf }), null);
    // A project key that is not one folder name is skipped.
    assert.equal(findSessionTranscript({ sessionId: ID, projects: s.projects, projectsDir: s.projectsDir, pathToKey: () => '../../..' , exists: () => true, realpath: (p) => p }), null);
  } finally { s.done(); }
});

test('isInside and isPlainName', () => {
  assert.ok(isInside('/a/skills', '/a/skills/x'));
  assert.ok(isInside('/a/skills', '/a/skills/x/y.md'));
  assert.ok(!isInside('/a/skills', '/a/skills'), 'the root itself is not inside');
  assert.ok(isInside('/a/skills', '/a/skills', { allowRoot: true }));
  assert.ok(!isInside('/a/skills', '/a/skills-evil/x'), 'a sibling that shares the prefix');
  assert.ok(!isInside('/a/skills', '/a/skills/../other/x'));
  assert.ok(!isInside('', '/a'));
  for (const good of ['ads', 'my-skill', 'a.b', 'Skill_1']) assert.ok(isPlainName(good), good);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b', null, undefined, 7, 'x'.repeat(201)]) assert.ok(!isPlainName(bad), String(bad));
});

test('a Skills Studio artifact id stays inside its folders', () => {
  const roots = { skill: ['/home/u/.claude/skills', '/proj/.claude/skills'], command: ['/proj/.claude/commands'], agent: ['/home/u/.claude/agents'] };
  // `realBase` (new with review 2, V02) is the folder the artifact really lives in.
  // These folders do not exist: the filesystem stand-in resolves every path to itself.
  const fs = { realpath: (p) => p, lstat: () => { throw new Error('ENOENT'); } };
  assert.deepEqual(confineArtifact('skill:/home/u/.claude/skills/ads', roots, { fs }), { type: 'skill', dirPath: '/home/u/.claude/skills/ads', filePath: '/home/u/.claude/skills/ads/SKILL.md', realBase: '/home/u/.claude/skills/ads' });
  assert.deepEqual(confineArtifact('command:/proj/.claude/commands/sub/x.md', roots, { fs }), { type: 'command', dirPath: '/proj/.claude/commands/sub', filePath: '/proj/.claude/commands/sub/x.md', realBase: '/proj/.claude/commands' });
  const refused = [
    ['command:/etc/passwd', 403],
    ['agent:/home/u/.ssh/id_rsa.md', 403],
    ['skill:/home/u', 403],
    ['skill:/home/u/.claude/skills', 403],                 // the folder itself: deleting it would take every skill
    ['skill:/home/u/.claude/skills/../../.ssh', 403],
    ['skill:/home/u/.claude/skills-evil/x', 403],
    ['command:/home/u/.claude/agents/x.md', 403],          // right folder, wrong type
    ['agent:/home/u/.claude/agents/x.txt', 400],
    ['file:/home/u/.claude/skills/ads', 400],
    ['skill:', 400],
    ['', 400],
    ['skill:/home/u/.claude/skills/a\0b', 400],
  ];
  for (const [id, status] of refused) {
    assert.throws(() => confineArtifact(id, roots), (e) => e instanceof PathConfineError && e.status === status, `${id} should be refused with ${status}`);
  }
  assert.throws(() => confineArtifact('skill:/home/u/.claude/skills/ads', {}), PathConfineError, 'no roots, nothing allowed');
});

// ── server.js wiring (the server cannot be imported in a test: it listens) ──

test('the history route validates the id and confines the lookup', () => {
  const route = /app\.get\('\/api\/claude-code\/sessions\/:sessionId\/messages'[\s\S]*?\n\}\);/.exec(server)?.[0] || '';
  assert.ok(route, 'route found');
  assert.match(route, /findSessionTranscript\(\{/);
  assert.doesNotMatch(route, /`\$\{sessionId\}\.jsonl`/, 'the route builds no transcript path itself');
  assert.match(route, /err instanceof PathConfineError|err\?\.status/);
});

test('Skills Studio resolves artifacts through the confinement and names are one segment', () => {
  const fn = /function resolveArtifactFile\(decodedId\) \{[\s\S]*?\n\}/.exec(server)?.[0] || '';
  assert.match(fn, /return confineArtifact\(decodedId, artifactRoots\(\)\);/);
  assert.doesNotMatch(server, /startsWith\(resolve\(dir\)\)/, 'no prefix-only containment check is left');
  for (const name of ['installSkillToTarget', 'uninstallSkillFromTarget']) {
    const body = new RegExp(`function ${name}\\(target, skillName\\) \\{\\n([^\\n]*)`).exec(server)?.[1] || '';
    assert.match(body, /isPlainName\(skillName\)/, `${name} checks the name first`);
  }
  const install = server.slice(server.indexOf("app.post('/api/skills-studio/install'"), server.indexOf('// GET /api/skills-studio/export/:id'));
  assert.equal((install.match(/!isPlainName\(dirName\)/g) || []).length, 2, 'install and uninstall check dirName');
  const imp = server.slice(server.indexOf("app.post('/api/skills-studio/import'"));
  assert.match(imp.slice(0, 2500), /!isPlainName\(name\)/);
  assert.match(imp.slice(0, 3500), /isInside\(targetDir, fullPath\)/);
});

// ── Review 2, V02: a link inside an allowed folder must not lead out of it ──

function studio() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'synabun-studio-')));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const outside = join(root, 'outside');
  for (const d of [join(home, '.claude', 'skills', 'ads', 'modules'), join(home, '.claude', 'commands'), join(home, '.claude', 'agents'),
    join(proj, '.claude', 'skills', 'local'), join(proj, '.claude', 'commands'), join(proj, '.claude', 'agents'), join(outside, 'dir')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'ads', 'SKILL.md'), '# ads');
  writeFileSync(join(proj, '.claude', 'skills', 'local', 'SKILL.md'), '# local');
  writeFileSync(join(outside, 'secret.md'), 'secret');
  writeFileSync(join(outside, 'dir', 'SKILL.md'), '# elsewhere');
  const roots = {
    skill: [{ dir: join(home, '.claude', 'skills'), links: true }, { dir: join(proj, '.claude', 'skills'), anchor: proj }],
    command: [join(home, '.claude', 'commands'), { dir: join(proj, '.claude', 'commands'), anchor: proj }],
    agent: [join(home, '.claude', 'agents'), { dir: join(proj, '.claude', 'agents'), anchor: proj }],
  };
  return { root, home, proj, outside, roots, done: () => rmSync(root, { recursive: true, force: true }) };
}
const refused = (fn, status = 403) => assert.throws(fn, (e) => e instanceof PathConfineError && e.status === status);

test('V02: a command or agent file that is a link to somewhere else is refused', () => {
  const s = studio();
  try {
    const link = join(s.proj, '.claude', 'commands', 'leak.md');
    symlinkSync(join(s.outside, 'secret.md'), link);
    refused(() => confineArtifact(`command:${link}`, s.roots));
    const agentLink = join(s.home, '.claude', 'agents', 'leak.md');
    symlinkSync(join(s.outside, 'secret.md'), agentLink);
    refused(() => confineArtifact(`agent:${agentLink}`, s.roots));
    // A real file next to them still resolves, and so does one that does not exist yet.
    writeFileSync(join(s.proj, '.claude', 'commands', 'ok.md'), 'ok');
    assert.equal(confineArtifact(`command:${join(s.proj, '.claude', 'commands', 'ok.md')}`, s.roots).realBase, join(s.proj, '.claude', 'commands'));
    assert.equal(confineArtifact(`command:${join(s.proj, '.claude', 'commands', 'new.md')}`, s.roots).filePath, join(s.proj, '.claude', 'commands', 'new.md'));
  } finally { s.done(); }
});

test('V02: a project skill folder that links out of the project is refused; so is a project folder that is itself a link', () => {
  const s = studio();
  try {
    const link = join(s.proj, '.claude', 'skills', 'evil');
    symlinkSync(join(s.outside, 'dir'), link);
    refused(() => confineArtifact(`skill:${link}`, s.roots));
    // The repository ships `.claude/agents` as a link to a folder outside it.
    rmSync(join(s.proj, '.claude', 'agents'), { recursive: true });
    symlinkSync(s.outside, join(s.proj, '.claude', 'agents'));
    refused(() => confineArtifact(`agent:${join(s.proj, '.claude', 'agents', 'secret.md')}`, s.roots));
    refused(() => confineToRoot(s.roots.agent[1], join(s.proj, '.claude', 'agents', 'new.md')));
    // The real skill of the project is untouched by all this.
    const ok = confineArtifact(`skill:${join(s.proj, '.claude', 'skills', 'local')}`, s.roots);
    assert.equal(ok.realBase, join(s.proj, '.claude', 'skills', 'local'));
  } finally { s.done(); }
});

test('V02: a skill the user linked into their own skills folder still works, confined to where it really is', () => {
  const s = studio();
  try {
    const link = join(s.home, '.claude', 'skills', 'linked');
    symlinkSync(join(s.outside, 'dir'), link);
    const a = confineArtifact(`skill:${link}`, s.roots);
    assert.equal(a.dirPath, link);
    assert.equal(a.realBase, join(s.outside, 'dir'));
    assert.equal(confineSubPath(a, 'notes.md'), join(link, 'notes.md'));
    refused(() => confineSubPath(a, '../secret.md'));
    // Only a direct child of the user's folder: a link one level down is a link like any other.
    symlinkSync(s.outside, join(s.home, '.claude', 'skills', 'ads', 'deep'));
    refused(() => confineArtifact(`skill:${join(s.home, '.claude', 'skills', 'ads', 'deep', 'dir')}`, s.roots));
    // A skill whose SKILL.md is a link out is not an artifact.
    mkdirSync(join(s.home, '.claude', 'skills', 'fake'));
    symlinkSync(join(s.outside, 'secret.md'), join(s.home, '.claude', 'skills', 'fake', 'SKILL.md'));
    refused(() => confineArtifact(`skill:${join(s.home, '.claude', 'skills', 'fake')}`, s.roots));
    // The whole skills folder being a link (a dotfiles setup) keeps working.
    const s2 = studio();
    try {
      const realSkills = join(s2.root, 'dotfiles-skills');
      mkdirSync(join(realSkills, 'mine'), { recursive: true });
      writeFileSync(join(realSkills, 'mine', 'SKILL.md'), '# mine');
      rmSync(join(s2.home, '.claude', 'skills'), { recursive: true });
      symlinkSync(realSkills, join(s2.home, '.claude', 'skills'));
      const mine = confineArtifact(`skill:${join(s2.home, '.claude', 'skills', 'mine')}`, s2.roots);
      assert.equal(mine.realBase, join(realSkills, 'mine'));
      assert.equal(confineSubPath(mine, 'a/b.md'), join(s2.home, '.claude', 'skills', 'mine', 'a', 'b.md'));
    } finally { s2.done(); }
  } finally { s.done(); }
});

test('V02: sub-files are confined by real path: a linked file, a linked folder, a dangling link', () => {
  const s = studio();
  try {
    const dir = join(s.home, '.claude', 'skills', 'ads');
    const a = confineArtifact(`skill:${dir}`, s.roots);
    writeFileSync(join(dir, 'modules', 'real.md'), 'x');
    assert.equal(confineSubPath(a, 'modules/real.md'), join(dir, 'modules', 'real.md'));
    assert.equal(confineSubPath(a, 'modules/new/deep.md'), join(dir, 'modules', 'new', 'deep.md'), 'a file about to be created');
    symlinkSync(join(s.outside, 'secret.md'), join(dir, 'modules', 'leak.md'));
    refused(() => confineSubPath(a, 'modules/leak.md'));                 // read or overwrite through a file link
    symlinkSync(s.outside, join(dir, 'out'));
    refused(() => confineSubPath(a, 'out/secret.md'));                   // through a folder link
    refused(() => confineSubPath(a, 'out/brand-new.md'));                // a new file would land outside
    symlinkSync(join(s.outside, 'not-there.txt'), join(dir, 'dangling'));
    refused(() => confineSubPath(a, 'dangling'));                        // writing would create the target
    refused(() => confineSubPath(a, '../x'));
    refused(() => confineSubPath(a, ''), 400);
    refused(() => confineSubPath(a, 'a\0b'), 400);
    refused(() => confineSubPath(a, 42), 400);
    // A link that stays inside the skill is fine.
    symlinkSync(join(dir, 'modules', 'real.md'), join(dir, 'alias.md'));
    assert.equal(confineSubPath(a, 'alias.md'), join(dir, 'alias.md'));
    // staysInside is the same judgement for a path the server built (icons, tree, export).
    assert.equal(staysInside(a, join(dir, 'alias.md')), true);
    assert.equal(staysInside(a, join(dir, 'modules', 'leak.md')), false);
    assert.equal(staysInside(a, join(dir, 'dangling')), false);
    assert.equal(staysInside(a, join(dir, 'icon.png')), true, 'not there yet');
    assert.equal(staysInside({}, join(dir, 'icon.png')), false);
  } finally { s.done(); }
});

test('V02: realPathOf and isInsideReal', () => {
  const s = studio();
  try {
    const dir = join(s.home, '.claude', 'skills', 'ads');
    assert.equal(realPathOf(join(dir, 'nope', 'x.md')), join(dir, 'nope', 'x.md'));
    symlinkSync(s.outside, join(dir, 'out'));
    assert.equal(realPathOf(join(dir, 'out', 'new', 'x.md')), join(s.outside, 'new', 'x.md'));
    assert.ok(isInsideReal(dir, join(dir, 'modules')));
    assert.ok(!isInsideReal(dir, join(dir, 'out', 'secret.md')));
    assert.ok(isInside(dir, join(dir, 'out', 'secret.md')), 'the lexical check alone is fooled: that was the defect');
    assert.ok(!isInsideReal('', dir));
  } finally { s.done(); }
});

test('V02: every Skills Studio route that touches a file goes through the real-path checks', () => {
  const studioSrc = server.slice(server.indexOf('// Skills Studio API'), server.indexOf('// GET /api/health'));
  assert.ok(studioSrc.length > 5000);
  assert.doesNotMatch(studioSrc, /const fullPath = join\(dir, subPath\);/, 'sub-file paths are built by confineSubPath');
  assert.equal((studioSrc.match(/confineSubPath\(/g) || []).length, 4, 'read, save, create and delete a sub-file');
  assert.match(/function artifactRoots\(\) \{[\s\S]*?\n\}/.exec(studioSrc)?.[0] || '', /anchor: proj\.path/);
  const create = studioSrc.slice(studioSrc.indexOf("app.post('/api/skills-studio/create'"), studioSrc.indexOf("// DELETE /api/skills-studio/artifact/:id — delete an artifact"));
  // (Review 3: folders and files are made by the confined helpers of
  // lib/confined-fs.js, no longer by mkdirSync / writeFileSync on a pathname;
  // the check still comes first, and no raw call is left.)
  assert.ok(create.indexOf('confineToRoot(') > 0 && create.indexOf('confineToRoot(') < create.indexOf('writeConfinedFile('), 'create checks before it makes a folder');
  assert.doesNotMatch(create, /mkdirSync\(|writeFileSync\(/);
  const imp = studioSrc.slice(studioSrc.indexOf("app.post('/api/skills-studio/import'"));
  assert.ok(imp.indexOf('confineToRoot(') > 0 && imp.indexOf('confineToRoot(') < imp.indexOf('makeConfinedDir(') && imp.indexOf('confineToRoot(') < imp.indexOf('writeConfinedFile('), 'import checks before it writes');
  assert.doesNotMatch(imp, /mkdirSync\(|writeFileSync\(/);
  // (Review 3: the tree is the bounded walk, which leaves out what a link leads out to.)
  const tree = /function artifactFileTree\([^)]*\) \{[\s\S]*?\n\}/.exec(server)?.[0] || '';
  assert.match(tree, /listConfined\(artifact\.realBase, artifact\.realBase, /, 'the file tree skips what a link leads out to');
  for (const fn of ['resolveArtifactIcon']) {
    const body = new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(server)?.[0] || '';
    assert.match(body, /staysInside\(|isInsideReal\(/, `${fn} skips what a link leads out to`);
  }
  const exp = studioSrc.slice(studioSrc.indexOf("app.get('/api/skills-studio/export/:id'"), studioSrc.indexOf("app.post('/api/skills-studio/import'"));
  assert.match(exp, /staysInside\(/);
  const icon = studioSrc.slice(studioSrc.indexOf("app.post('/api/skills-studio/artifact/:id/icon'"), studioSrc.indexOf('// DELETE /api/skills-studio/artifact/:id/icon'));
  assert.match(icon, /staysInside\(/, 'an icon is not written through a link');
  // A refusal is the caller's error: the routes answer with its status, not 500.
  assert.ok((studioSrc.match(/skillsStudioStatus\(err\)/g) || []).length >= 12);
});

test('R02: the transcript routes pass the supplied project and refuse what is not registered', () => {
  const chain = /async function claudeTranscriptChain\([\s\S]*?\n\}/.exec(server)?.[0] || '';
  assert.match(chain, /findSessionTranscript\(\{\s*sessionId, project,/);
  const src = readFileSync(join(HERE, '..', 'lib', 'path-confine.js'), 'utf8');
  assert.match(src, /Not a registered project/);
});
