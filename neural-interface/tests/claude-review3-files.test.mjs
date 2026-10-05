// Review 3 of the Claude panel parity build, files on disk.
// T05: removing a permission rule never writes through a link (a predictable
//      temporary name could be pre-created as one).
// T08: Skills Studio decides whether an artifact may be opened before it reads
//      anything of it, reads only regular files, and bounds what it reads.
// T04: walking a skill's folder follows links inside it without walking a
//      cycle, and is bounded.
// T02: a read or a write happens on the canonical path that was checked, does
//      not follow a link at the last step, and re-checks what it opened.
// T06: the transcript route says "not found" as such.
// Symlinks, FIFOs: POSIX only (skipped on Windows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, existsSync, readdirSync, rmSync, realpathSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { removePermissionRule, PermissionRuleError } from '../lib/claude-permission-rules.js';
import { confineArtifact, confineSubPath, findSessionTranscript, PathConfineError } from '../lib/path-confine.js';
import {
  readConfinedFile, writeConfinedFile, makeConfinedDir, removeConfinedEntry, replaceFileAtomic, listConfined, openConfinedStream, canonicalInside,
} from '../lib/confined-fs.js';
import { transcriptNotFound } from '../lib/claude-history.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
const posix = process.platform !== 'win32';
const sandbox = (name) => realpathSync(mkdtempSync(join(tmpdir(), `synabun-${name}-`)));
const status = (fn) => { try { fn(); return 0; } catch (err) { return err?.status || -1; } };
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// ── T05 ──

function projectWithRule() {
  const root = sandbox('t05');
  const project = join(root, 'repo');
  mkdirSync(join(project, '.claude'), { recursive: true });
  const file = join(project, '.claude', 'settings.local.json');
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(rm:*)'] }, keep: true }, null, 2));
  const victim = join(root, 'victim.txt');
  writeFileSync(victim, 'do not overwrite');
  return { root, project, file, victim };
}

test('T05: a temporary-file name pre-created as a link is never written through', { skip: !posix }, () => {
  const { root, project, file, victim } = projectWithRule();
  try {
    // What the previous build wrote to: a name a repository can ship as a link.
    symlinkSync(victim, `${file}.synabun-tmp`);
    const out = removePermissionRule({ home: join(root, 'home'), project, scope: 'local', list: 'allow', rule: 'Bash(rm:*)' });
    assert.equal(out.removed, true);
    assert.equal(readFileSync(victim, 'utf8'), 'do not overwrite', 'the file the link points to is untouched');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved.permissions.allow, ['Bash(ls:*)']);
    assert.equal(saved.keep, true);
    assert.equal(lstatSync(file).isSymbolicLink(), false);
    // Nothing temporary is left, and the planted link was not consumed.
    assert.deepEqual(readdirSync(join(project, '.claude')).sort(), ['settings.local.json', 'settings.local.json.synabun-tmp']);
    assert.equal(lstatSync(`${file}.synabun-tmp`).isSymbolicLink(), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T05: the temporary file has a name nobody can predict, in the same folder, and keeps the file\'s mode', { skip: !posix }, () => {
  const { root, project, file } = projectWithRule();
  try {
    chmodSync(file, 0o600);
    removePermissionRule({ home: join(root, 'home'), project, scope: 'local', list: 'allow', rule: 'Bash(rm:*)' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const src = readFileSync(join(HERE, '..', 'lib', 'claude-permission-rules.js'), 'utf8');
    assert.doesNotMatch(src, /synabun-tmp/);
    assert.doesNotMatch(src, /writeFileSync|renameSync/);
    assert.match(src, /replaceFileAtomic\(target, /);
    const helper = readFileSync(join(HERE, '..', 'lib', 'confined-fs.js'), 'utf8');
    const body = helper.slice(helper.indexOf('export function replaceFileAtomic'), helper.indexOf('export function listConfined'));
    assert.match(body, /randomBytes\(12\)/);
    assert.match(body, /O_CREAT \| constants\.O_EXCL \| O_NOFOLLOW/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T05: a project settings file, or a .claude folder, that is a link is refused and nothing is written', { skip: !posix }, () => {
  const a = projectWithRule();
  try {
    // The settings file itself is a link to a file elsewhere that holds the rule.
    const elsewhere = join(a.root, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] } }));
    rmSync(a.file);
    symlinkSync(elsewhere, a.file);
    assert.throws(() => removePermissionRule({ home: join(a.root, 'home'), project: a.project, scope: 'local', list: 'allow', rule: 'Bash(rm:*)' }),
      (err) => err instanceof PermissionRuleError && err.status === 409);
    assert.deepEqual(JSON.parse(readFileSync(elsewhere, 'utf8')).permissions.allow, ['Bash(rm:*)']);
    assert.equal(lstatSync(a.file).isSymbolicLink(), true);
  } finally { rmSync(a.root, { recursive: true, force: true }); }

  const b = sandbox('t05b');
  try {
    // `.claude` leads out of the project.
    const project = join(b, 'repo');
    const outside = join(b, 'outside');
    mkdirSync(project); mkdirSync(outside);
    writeFileSync(join(outside, 'settings.json'), JSON.stringify({ permissions: { deny: ['WebFetch'] } }));
    symlinkSync(outside, join(project, '.claude'));
    assert.throws(() => removePermissionRule({ home: join(b, 'home'), project, scope: 'project', list: 'deny', rule: 'WebFetch' }),
      (err) => err instanceof PermissionRuleError && err.status === 409);
    assert.deepEqual(JSON.parse(readFileSync(join(outside, 'settings.json'), 'utf8')).permissions.deny, ['WebFetch']);
    assert.deepEqual(readdirSync(outside), ['settings.json']);
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('T05: the user\'s own settings file may be a link: the file behind it is edited and the link stays', { skip: !posix }, () => {
  const root = sandbox('t05c');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(root, 'dotfiles'));
    const actual = join(root, 'dotfiles', 'claude-settings.json');
    writeFileSync(actual, JSON.stringify({ permissions: { allow: ['Read', 'Bash(rm:*)'] } }));
    symlinkSync(actual, join(home, '.claude', 'settings.json'));
    const out = removePermissionRule({ home, scope: 'user', list: 'allow', rule: 'Bash(rm:*)' });
    assert.equal(out.removed, true);
    assert.equal(lstatSync(join(home, '.claude', 'settings.json')).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(actual, 'utf8')).permissions.allow, ['Read']);
    assert.deepEqual(readdirSync(join(root, 'dotfiles')), ['claude-settings.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T05: replaceFileAtomic leaves no temporary file behind when it refuses, and refuses a file that changed', { skip: !posix }, () => {
  const root = sandbox('t05d');
  try {
    const file = join(root, 'a.json');
    writeFileSync(file, 'one');
    const before = lstatSync(file);
    writeFileSync(file, 'two, longer');
    assert.equal(status(() => replaceFileAtomic(file, 'mine', { expect: before })), 409);
    assert.equal(readFileSync(file, 'utf8'), 'two, longer');
    assert.deepEqual(readdirSync(root), ['a.json']);
    replaceFileAtomic(file, 'mine', { expect: lstatSync(file) });
    assert.equal(readFileSync(file, 'utf8'), 'mine');
    assert.deepEqual(readdirSync(root), ['a.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── T02: the helpers ──

test('T02: a read is of a regular file inside the folder, bounded, on the canonical path', { skip: !posix }, () => {
  const root = sandbox('t02');
  try {
    const base = join(root, 'skill');
    mkdirSync(join(base, 'docs'), { recursive: true });
    writeFileSync(join(base, 'docs', 'a.md'), 'hello');
    writeFileSync(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(base, 'docs', 'a.md'), join(base, 'inside-link.md'));
    symlinkSync(join(root, 'secret.txt'), join(base, 'outside-link.md'));
    symlinkSync(join(root, 'nowhere'), join(base, 'dangling.md'));
    symlinkSync('/dev/zero', join(base, 'zero.md'));
    execFileSync('mkfifo', [join(base, 'pipe.md')]);

    assert.equal(readConfinedFile(base, join(base, 'docs', 'a.md'), { encoding: 'utf-8' }), 'hello');
    assert.equal(readConfinedFile(base, join(base, 'inside-link.md'), { encoding: 'utf-8' }), 'hello', 'a link that stays inside is read as the file it is');
    assert.equal(status(() => readConfinedFile(base, join(base, 'outside-link.md'))), 403);
    assert.equal(status(() => readConfinedFile(base, join(base, 'dangling.md'))), 403);
    assert.equal(status(() => readConfinedFile(base, join(base, 'zero.md'))), 403, 'a device outside the folder is never opened');
    // A FIFO inside the folder: refused at once (a plain read would wait for a writer forever).
    const started = Date.now();
    assert.equal(status(() => readConfinedFile(base, join(base, 'pipe.md'))), 400);
    assert.ok(Date.now() - started < 1000);
    assert.equal(status(() => readConfinedFile(base, join(base, 'docs'))), 400, 'a folder is not a file');
    assert.equal(status(() => readConfinedFile(base, join(base, 'missing.md'))), 404);
    assert.equal(status(() => readConfinedFile(base, join(base, 'docs', 'a.md'), { maxBytes: 3 })), 413);
    assert.equal(status(() => readConfinedFile(base, base)), 403, 'the folder itself is not inside itself');
    assert.equal(canonicalInside(base, join(base, 'inside-link.md')), join(base, 'docs', 'a.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T02: a write lands on the canonical path, never through a link at the last step, and creates exclusively', { skip: !posix }, () => {
  const root = sandbox('t02w');
  try {
    const base = join(root, 'skill');
    mkdirSync(base);
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'do not overwrite');
    symlinkSync(victim, join(base, 'out.md'));
    symlinkSync(join(root, 'not-there-yet'), join(base, 'dangling.md'));
    symlinkSync(root, join(base, 'up'));

    assert.equal(status(() => writeConfinedFile(base, join(base, 'out.md'), 'x')), 403);
    assert.equal(status(() => writeConfinedFile(base, join(base, 'dangling.md'), 'x')), 403, 'a dangling link would create its target');
    assert.equal(status(() => writeConfinedFile(base, join(base, 'up', 'new.md'), 'x')), 403, 'a folder that is a link out');
    assert.equal(readFileSync(victim, 'utf8'), 'do not overwrite');
    assert.equal(existsSync(join(root, 'not-there-yet')), false);
    assert.equal(existsSync(join(root, 'new.md')), false);

    // New file, with the folders on the way.
    writeConfinedFile(base, join(base, 'a', 'b', 'c.md'), 'one');
    assert.equal(readFileSync(join(base, 'a', 'b', 'c.md'), 'utf8'), 'one');
    // Existing file: replaced in place (same inode), shorter content does not leave a tail.
    const ino = statSync(join(base, 'a', 'b', 'c.md')).ino;
    writeConfinedFile(base, join(base, 'a', 'b', 'c.md'), '2');
    assert.equal(readFileSync(join(base, 'a', 'b', 'c.md'), 'utf8'), '2');
    assert.equal(statSync(join(base, 'a', 'b', 'c.md')).ino, ino);
    assert.equal(status(() => writeConfinedFile(base, join(base, 'a', 'b', 'c.md'), '3', { exclusive: true })), 409);
    // A link inside the folder to a file inside it: the file is written, the link stays.
    symlinkSync(join(base, 'a', 'b', 'c.md'), join(base, 'alias.md'));
    writeConfinedFile(base, join(base, 'alias.md'), 'via alias');
    assert.equal(readFileSync(join(base, 'a', 'b', 'c.md'), 'utf8'), 'via alias');
    assert.equal(lstatSync(join(base, 'alias.md')).isSymbolicLink(), true);
    // Binary data.
    writeConfinedFile(base, join(base, 'icon.png'), Buffer.from([0, 255, 1, 2]));
    assert.deepEqual([...readFileSync(join(base, 'icon.png'))], [0, 255, 1, 2]);
    // A folder.
    assert.equal(makeConfinedDir(base, join(base, 'x', 'y')), join(base, 'x', 'y'));
    assert.equal(status(() => makeConfinedDir(base, join(base, 'up', 'made'))), 403);
    assert.equal(existsSync(join(root, 'made')), false);
    // A folder is not a file.
    assert.equal(status(() => writeConfinedFile(base, join(base, 'x'), 'x')), -1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T02: removing an entry removes what is named: a link is unlinked, never followed', { skip: !posix }, () => {
  const root = sandbox('t02r');
  try {
    const base = join(root, 'skill');
    mkdirSync(join(base, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(base, 'sub', 'deep', 'f.md'), 'f');
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'keep.txt'), 'keep');
    symlinkSync(join(root, 'outside'), join(base, 'out-link'));
    symlinkSync(join(root, 'outside'), join(base, 'sub', 'inner-out'));

    assert.equal(removeConfinedEntry(base, join(base, 'out-link')), true);
    assert.equal(existsSync(join(root, 'outside', 'keep.txt')), true, 'the link went, not the folder it pointed to');
    assert.equal(removeConfinedEntry(base, join(base, 'sub')), true);
    assert.equal(existsSync(join(base, 'sub')), false);
    assert.equal(existsSync(join(root, 'outside', 'keep.txt')), true, 'a link inside a removed folder is not followed');
    assert.equal(removeConfinedEntry(base, join(base, 'nothing')), false);
    // The folder holding the entry must be the base or inside it.
    symlinkSync(join(root, 'outside'), join(base, 'via'));
    assert.equal(status(() => removeConfinedEntry(base, join(base, 'via', 'keep.txt'))), 403);
    assert.equal(existsSync(join(root, 'outside', 'keep.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T02: a stream is opened on a verified regular file', { skip: !posix }, async () => {
  const root = sandbox('t02s');
  try {
    const folder = join(root, 'transcripts');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.jsonl'), '{"a":1}\n');
    writeFileSync(join(root, 'other.jsonl'), '{"secret":1}\n');
    symlinkSync(join(root, 'other.jsonl'), join(folder, 'link.jsonl'));
    execFileSync('mkfifo', [join(folder, 'pipe.jsonl')]);
    let text = '';
    for await (const chunk of openConfinedStream(folder, join(folder, 'a.jsonl'), { encoding: 'utf-8' })) text += chunk;
    assert.equal(text, '{"a":1}\n');
    assert.equal(status(() => openConfinedStream(folder, join(folder, 'link.jsonl'))), 403);
    assert.equal(status(() => openConfinedStream(folder, join(folder, 'pipe.jsonl'))), 400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T02: a transcript is named by the canonical path that was checked', { skip: !posix }, () => {
  const root = sandbox('t02t');
  try {
    const projectsDir = join(root, 'projects');
    mkdirSync(join(projectsDir, '-work-app'), { recursive: true });
    writeFileSync(join(projectsDir, '-work-app', `${SID}.jsonl`), '{}\n');
    const found = findSessionTranscript({ sessionId: SID, project: '/work/app', projects: [{ path: '/work/app' }], projectsDir, pathToKey: () => '-work-app' });
    assert.equal(found.realPath, join(projectsDir, '-work-app', `${SID}.jsonl`));
    assert.equal(found.realFolder, join(projectsDir, '-work-app'));
    // The routes read through the verified opener, from those two values.
    assert.equal((server.match(/openConfinedStream\(found\.realFolder, found\.realPath, \{ encoding: 'utf-8' \}\)/g) || []).length, 2, 'the history route and the chain lookup');
    assert.doesNotMatch(server, /createReadStream\(found\.filePath/);
    assert.doesNotMatch(server, /createReadStream\(filePath, \{ encoding: 'utf-8' \}\)\);\n    \/\/ Rows per transcript line/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── T04 ──

test('T04: a link cycle inside a skill is walked once, and legitimate links inside it are still listed', { skip: !posix }, () => {
  const root = sandbox('t04');
  try {
    const base = join(root, 'skill');
    mkdirSync(join(base, 'a', 'b'), { recursive: true });
    mkdirSync(join(base, 'shared'));
    writeFileSync(join(base, 'SKILL.md'), '# s');
    writeFileSync(join(base, 'a', 'b', 'f.md'), 'f');
    writeFileSync(join(base, 'shared', 's.md'), 's');
    // Two links back to an ancestor: the branching cycle the review described.
    symlinkSync(join(base, 'a'), join(base, 'a', 'b', 'back1'));
    symlinkSync(join(base, 'a'), join(base, 'a', 'b', 'back2'));
    symlinkSync(base, join(base, 'a', 'top'));
    // A legitimate link to a folder that is not on the way down, and one to a file.
    symlinkSync(join(base, 'shared'), join(base, 'a', 'shared-link'));
    symlinkSync(join(base, 'shared', 's.md'), join(base, 'alias.md'));
    // A link out.
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'o.md'), 'o');
    symlinkSync(join(root, 'outside'), join(base, 'out'));

    const started = Date.now();
    const { entries, truncated, count } = listConfined(base, base);
    assert.ok(Date.now() - started < 1000);
    assert.equal(truncated, false);
    const flat = [];
    (function walk(nodes) { for (const n of nodes) { flat.push(n.path); if (n.children) walk(n.children); } })(entries);
    assert.deepEqual(flat.sort(), ['SKILL.md', 'a', 'a/b', 'a/b/f.md', 'a/shared-link', 'a/shared-link/s.md', 'alias.md', 'shared', 'shared/s.md']);
    assert.equal(count, flat.length);
    assert.equal(flat.some(p => p.includes('back') || p.includes('top') || p.startsWith('out')), false);
    // Folders first, then names, as the file tree always was.
    assert.deepEqual(entries.map(e => e.name), ['a', 'shared', 'alias.md', 'SKILL.md']);
    const alias = entries.find(e => e.name === 'alias.md');
    assert.equal(alias.real, join(base, 'shared', 's.md'));
    assert.equal(alias.size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T04: the walk is bounded in depth and in entries, and says when it stopped', { skip: !posix }, () => {
  const root = sandbox('t04b');
  try {
    const base = join(root, 'skill');
    // Diamonds: every level reaches the next through two links. No cycle, 2^n ways down.
    for (let i = 0; i < 14; i++) {
      mkdirSync(join(base, `d${i}`), { recursive: true });
      writeFileSync(join(base, `d${i}`, 'f.md'), 'f');
      if (i > 0) {
        symlinkSync(join(base, `d${i}`), join(base, `d${i - 1}`, 'x'));
        symlinkSync(join(base, `d${i}`), join(base, `d${i - 1}`, 'y'));
      }
    }
    const started = Date.now();
    const capped = listConfined(base, base, { maxEntries: 200 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(capped.truncated, true);
    assert.ok(capped.count <= 200);
    const shallow = listConfined(base, base, { maxDepth: 2, maxEntries: 100000 });
    assert.equal(shallow.truncated, true);
    const depthOf = (nodes, d = 1) => Math.max(d, ...nodes.filter(n => n.children?.length).map(n => depthOf(n.children, d + 1)));
    assert.ok(depthOf(shallow.entries) <= 2);
    // Special files are not part of a tree.
    execFileSync('mkfifo', [join(base, 'pipe')]);
    assert.equal(listConfined(base, base, { maxDepth: 1 }).entries.some(e => e.name === 'pipe'), false);
    // A folder that is not in the base is not walked at all.
    assert.deepEqual(listConfined(base, root).entries, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── T08 + T02 + T04: the Skills Studio routes ──

const studio = server.slice(server.indexOf('/** Build a recursive file tree for a directory */'), server.indexOf('// GET /api/health — Check if SQLite database is accessible'));
const discover = studio.slice(studio.indexOf('function discoverAllArtifacts() {'), studio.indexOf('// GET /api/skills-studio/library'));

test('T08: the library decides whether an artifact may be opened before it reads anything of it', () => {
  // Each read in discovery is of an artifact confineArtifact accepted, through the bounded regular-file reader.
  assert.doesNotMatch(discover, /readFileSync\(/, 'no raw read in discovery');
  assert.doesNotMatch(discover, /buildSubFileTree\(dir, ''\)/, 'no tree of a folder that was not confined first');
  const reads = [...discover.matchAll(/const content = readArtifactHead\(artifact\);/g)];
  assert.equal(reads.length, 6, 'global skills, global agents, project commands, project agents, project skills, bundled skills');
  for (const m of reads) {
    const before = discover.slice(Math.max(0, m.index - 400), m.index);
    assert.match(before, /const artifact = openArtifact\(`(skill|command|agent):\$\{\w+\}`\);\s*\n\s*if \(!artifact\) continue;/, 'confined first, skipped when refused');
  }
  assert.match(discover, /if \(content === null\) continue;/);
  // The after-the-fact filter is gone: nothing is read and then dropped.
  assert.doesNotMatch(discover, /artifacts\.filter\(\(a\) => \{ try \{ confineArtifact/);
  const head = studio.slice(studio.indexOf('function readArtifactHead('), studio.indexOf('function discoverAllArtifacts() {'));
  assert.match(head, /readConfinedFile\(artifact\.realBase, artifact\.filePath, \{ maxBytes: ARTIFACT_MD_MAX_BYTES, encoding: 'utf-8' \}\)/);
  assert.match(head, /catch \{ return null; \}/, 'one unreadable artifact does not fail the library');
});

test('T08: an artifact whose SKILL.md is a link to a FIFO or a device is refused before any read', { skip: !posix }, () => {
  const root = sandbox('t08');
  try {
    const skills = join(root, 'repo', '.claude', 'skills');
    mkdirSync(join(skills, 'pipe'), { recursive: true });
    mkdirSync(join(skills, 'zero'), { recursive: true });
    mkdirSync(join(skills, 'fifo-inside'), { recursive: true });
    mkdirSync(join(skills, 'good'), { recursive: true });
    execFileSync('mkfifo', [join(root, 'outside.fifo')]);
    symlinkSync(join(root, 'outside.fifo'), join(skills, 'pipe', 'SKILL.md'));
    symlinkSync('/dev/zero', join(skills, 'zero', 'SKILL.md'));
    execFileSync('mkfifo', [join(skills, 'fifo-inside', 'SKILL.md')]);
    writeFileSync(join(skills, 'good', 'SKILL.md'), '---\nname: good\n---\nbody');
    const roots = { skill: [{ dir: skills, anchor: join(root, 'repo') }] };
    // The check itself never opens the file.
    const started = Date.now();
    assert.equal(status(() => confineArtifact(`skill:${join(skills, 'pipe')}`, roots)), 403);
    assert.equal(status(() => confineArtifact(`skill:${join(skills, 'zero')}`, roots)), 403);
    // A FIFO that really is in the folder passes the path check and is refused by the reader, at once.
    const inside = confineArtifact(`skill:${join(skills, 'fifo-inside')}`, roots);
    assert.equal(status(() => readConfinedFile(inside.realBase, inside.filePath, { maxBytes: 1024, encoding: 'utf-8' })), 400);
    assert.ok(Date.now() - started < 1000, 'nothing waited on a pipe');
    const good = confineArtifact(`skill:${join(skills, 'good')}`, roots);
    assert.match(readConfinedFile(good.realBase, good.filePath, { encoding: 'utf-8' }), /name: good/);
    assert.equal(status(() => readConfinedFile(good.realBase, good.filePath, { maxBytes: 4 })), 413);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T02 + T04: every Skills Studio read, write, removal and walk goes through the confined helpers', () => {
  const routes = studio.slice(studio.indexOf('// GET /api/skills-studio/library'));
  for (const raw of ['readFileSync(', 'writeFileSync(', 'unlinkSync(', 'rmSync(', 'statSync(']) {
    assert.equal(routes.includes(raw), false, `${raw} is used on a pathname in a Skills Studio route`);
  }
  assert.doesNotMatch(routes, /function collectFiles\(/, 'the export walks with listConfined');
  assert.match(routes, /listConfined\(artifact\.realBase, artifact\.realBase, \{ skip: \(name\) => name\.startsWith\('\.'\) \}\)/);
  // The file tree is the bounded walk.
  const tree = studio.slice(0, studio.indexOf('function discoverAllArtifacts() {'));
  assert.match(tree, /listConfined\(artifact\.realBase, artifact\.realBase, \{ skip: /);
  assert.doesNotMatch(tree, /children: buildSubFileTree\(/, 'no unbounded recursion');
  for (const helper of ['readConfinedFile(', 'writeConfinedFile(', 'removeConfinedEntry(', 'makeConfinedDir(']) assert.ok(routes.includes(helper), helper);
  // The export is bounded in total.
  assert.match(routes, /EXPORT_MAX_BYTES/);
});

test('T02: a sub-path is still refused by the path check before any helper is called', { skip: !posix }, () => {
  const root = sandbox('t02p');
  try {
    const skills = join(root, 'skills');
    mkdirSync(join(skills, 's'), { recursive: true });
    writeFileSync(join(skills, 's', 'SKILL.md'), '# s');
    writeFileSync(join(root, 'secret'), 'secret');
    symlinkSync(join(root, 'secret'), join(skills, 's', 'leak.md'));
    const artifact = confineArtifact(`skill:${join(skills, 's')}`, { skill: [skills] });
    assert.throws(() => confineSubPath(artifact, 'leak.md'), PathConfineError);
    assert.throws(() => confineSubPath(artifact, '../x'), PathConfineError);
    assert.equal(status(() => readConfinedFile(artifact.realBase, join(artifact.dirPath, 'leak.md'))), 403, 'and the reader refuses it on its own');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── T06 ──

test('T06: a transcript that is not found is said to be, with where it was looked for', () => {
  const scoped = transcriptNotFound('/work/app');
  assert.equal(scoped.status, 404);
  assert.equal(scoped.body.code, 'transcript_not_found');
  assert.equal(scoped.body.scope, 'project');
  assert.match(scoped.body.error, /not found in this project/);
  assert.deepEqual(scoped.body.messages, []);
  const all = transcriptNotFound('');
  assert.equal(all.body.scope, 'registered');
  assert.match(all.body.error, /any registered project/);
  assert.equal(transcriptNotFound(undefined).body.scope, 'registered');
  // The route uses it; the empty success is gone, and the lookup stays strict.
  const route = server.slice(server.indexOf("app.get('/api/claude-code/sessions/:sessionId/messages'"), server.indexOf('// ── Paths built from something a browser sent ──') > 0 ? undefined : undefined);
  const body = route.slice(0, route.indexOf('const collector = createHistoryCollector();'));
  assert.doesNotMatch(body, /if \(!filePath\) return res\.json\(\{ messages: \[\] \}\);/);
  assert.match(body, /const missing = transcriptNotFound\(typeof project === 'string' \? project : ''\);/);
  assert.match(body, /return res\.status\(missing\.status\)\.json\(missing\.body\);/);
  // Strict: a named project is the only place looked in (lib/path-confine.js).
  const projectsDir = sandbox('t06');
  try {
    mkdirSync(join(projectsDir, '-work-site'), { recursive: true });
    writeFileSync(join(projectsDir, '-work-site', `${SID}.jsonl`), '{}\n');
    const projects = [{ path: '/work/app' }, { path: '/work/site' }];
    const pathToKey = (p) => p.replace(/\//g, '-');
    assert.equal(findSessionTranscript({ sessionId: SID, project: '/work/app', projects, projectsDir, pathToKey }), null);
    assert.equal(findSessionTranscript({ sessionId: SID, project: '/work/site', projects, projectsDir, pathToKey }).project, '/work/site');
  } finally { rmSync(projectsDir, { recursive: true, force: true }); }
});
