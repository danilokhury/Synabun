// Review 3, Skills Studio end to end. The routes live in server.js, which
// cannot be imported in a test (it starts the server), so this runs their
// source, cut from the file between two markers, against a stand-in for
// `app`, with HOME and the registered project pointing at a sandbox. What the
// file-confinement fixes (T02, T04, T08) must not break: listing, opening,
// saving, creating, deleting, icons, export and import of legitimate
// artifacts, including ones that are links inside the allowed folders. What
// they must refuse: links that lead out, FIFOs, cycles.
// POSIX only (symlinks, mkfifo).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import * as confine from '../lib/path-confine.js';
import * as confined from '../lib/confined-fs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
const posix = process.platform !== 'win32';

function studio() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'synabun-studio-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'repo');
  const bundled = path.join(root, 'bundled');
  for (const d of [path.join(home, '.claude', 'skills'), path.join(home, '.claude', 'agents'), path.join(home, '.claude', 'commands'),
    path.join(project, '.claude', 'skills'), path.join(project, '.claude', 'commands'), path.join(project, '.claude', 'agents'), bundled]) fs.mkdirSync(d, { recursive: true });
  const src = server.slice(server.indexOf('function getGlobalAgentsDir() {'), server.indexOf('// GET /api/health — Check if SQLite database is accessible'));
  assert.ok(src.length > 10000, 'the Skills Studio section was found');
  const routes = new Map();
  const reg = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers[handlers.length - 1]);
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') };
  const express = { raw: () => (req, res, next) => next?.() };
  const deps = {
    app, express, Buffer,
    process: { env: { HOME: home }, platform: process.platform },
    join: path.join, resolve: path.resolve, basename: path.basename, dirname: path.dirname, extname: path.extname,
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, cpSync: fs.cpSync,
    // Not handed over on purpose: a route that still calls one of these on a pathname fails here.
    readFileSync: () => { throw new Error('raw readFileSync in a Skills Studio route'); },
    writeFileSync: () => { throw new Error('raw writeFileSync in a Skills Studio route'); },
    mkdirSync: () => { throw new Error('raw mkdirSync in a Skills Studio route'); },
    unlinkSync: () => { throw new Error('raw unlinkSync in a Skills Studio route'); },
    rmSync: () => { throw new Error('raw rmSync in a Skills Studio route'); },
    statSync: () => { throw new Error('raw statSync in a Skills Studio route'); },
    loadHookProjects: () => [{ path: project, label: 'Repo' }],
    getGlobalSkillsDir: () => path.join(home, '.claude', 'skills'),
    SKILLS_SOURCE_DIR: bundled,
    isDirEntry: (entry) => entry.isDirectory() || entry.isSymbolicLink(),
    ...confine, ...confined,
  };
  new Function(...Object.keys(deps), src)(...Object.values(deps));
  const call = (method, route, { params = {}, query = {}, body = undefined, headers = {} } = {}) => {
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `${method} ${route} is registered`);
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    handler({ params, query, body, headers }, res);
    return res;
  };
  const id = (text) => Buffer.from(text).toString('base64url');
  return { root, home, project, bundled, call, id, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const skillMd = (name) => `---\nname: ${name}\ndescription: about ${name}\n---\nBody of ${name}\n`;

test('Skills Studio: the library lists legitimate artifacts, linked ones included, and survives hostile ones', { skip: !posix }, () => {
  const s = studio();
  try {
    const gs = path.join(s.home, '.claude', 'skills');
    // A plain global skill with files, a link inside it, and a link cycle inside it.
    fs.mkdirSync(path.join(gs, 'plain', 'modules', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(gs, 'plain', 'SKILL.md'), skillMd('plain'));
    fs.writeFileSync(path.join(gs, 'plain', 'modules', 'a.md'), 'a');
    fs.symlinkSync(path.join(gs, 'plain', 'modules', 'a.md'), path.join(gs, 'plain', 'alias.md'));
    fs.symlinkSync(path.join(gs, 'plain', 'modules'), path.join(gs, 'plain', 'modules', 'deep', 'loop1'));
    fs.symlinkSync(path.join(gs, 'plain', 'modules'), path.join(gs, 'plain', 'modules', 'deep', 'loop2'));
    // A skill folder the user linked into their skills folder (dotfiles).
    fs.mkdirSync(path.join(s.root, 'dev', 'linked'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'dev', 'linked', 'SKILL.md'), skillMd('linked'));
    fs.writeFileSync(path.join(s.root, 'dev', 'linked', 'notes.md'), 'notes');
    fs.symlinkSync(path.join(s.root, 'dev', 'linked'), path.join(gs, 'linked'));
    // A skill whose SKILL.md is a link to a file inside the same skill.
    fs.mkdirSync(path.join(gs, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(gs, 'inner', 'real.md'), skillMd('inner'));
    fs.symlinkSync(path.join(gs, 'inner', 'real.md'), path.join(gs, 'inner', 'SKILL.md'));
    // Agents and commands.
    fs.writeFileSync(path.join(s.home, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: helps\n---\nBe helpful');
    fs.writeFileSync(path.join(s.project, '.claude', 'commands', 'ship.md'), '---\ndescription: ship it\n---\nShip');
    fs.writeFileSync(path.join(s.project, '.claude', 'agents', 'review.md'), '---\nname: review\ndescription: reviews\n---\nReview');
    fs.mkdirSync(path.join(s.project, '.claude', 'skills', 'proj'));
    fs.writeFileSync(path.join(s.project, '.claude', 'skills', 'proj', 'SKILL.md'), skillMd('proj'));
    fs.mkdirSync(path.join(s.bundled, 'shipped'));
    fs.writeFileSync(path.join(s.bundled, 'shipped', 'SKILL.md'), skillMd('shipped'));
    // Hostile, as a repository could ship them: SKILL.md → a FIFO, → /dev/zero, → a file outside; a FIFO named SKILL.md.
    fs.writeFileSync(path.join(s.root, 'secret.md'), skillMd('SECRET'));
    execFileSync('mkfifo', [path.join(s.root, 'outside.fifo')]);
    for (const [name, target] of [['pipe', path.join(s.root, 'outside.fifo')], ['zero', '/dev/zero'], ['leak', path.join(s.root, 'secret.md')]]) {
      fs.mkdirSync(path.join(s.project, '.claude', 'skills', name));
      fs.symlinkSync(target, path.join(s.project, '.claude', 'skills', name, 'SKILL.md'));
    }
    fs.mkdirSync(path.join(s.project, '.claude', 'skills', 'fifo'));
    execFileSync('mkfifo', [path.join(s.project, '.claude', 'skills', 'fifo', 'SKILL.md')]);

    const started = Date.now();
    const res = s.call('GET', '/api/skills-studio/library');
    assert.ok(Date.now() - started < 3000, 'nothing waited on a pipe or read a device');
    assert.equal(res.statusCode, 200);
    const names = res.body.artifacts.map(a => `${a.type}:${a.scope}:${a.dirName}`).sort();
    assert.deepEqual(names, ['agent:global:helper', 'agent:project:review', 'command:project:ship', 'skill:bundled:shipped', 'skill:global:inner', 'skill:global:linked', 'skill:global:plain', 'skill:project:proj']);
    assert.equal(JSON.stringify(res.body).includes('SECRET'), false, 'nothing of a file outside the folders left the server');
    const plain = res.body.artifacts.find(a => a.dirName === 'plain');
    assert.equal(plain.description, 'about plain');
    const flat = [];
    (function walk(nodes) { for (const n of nodes) { flat.push(n.path); if (n.children) walk(n.children); } })(plain.subFiles);
    assert.deepEqual(flat.sort(), ['alias.md', 'modules', 'modules/a.md', 'modules/deep'], 'the cycle is not walked; the inner link is listed');
    assert.deepEqual(res.body.artifacts.find(a => a.dirName === 'linked').subFiles.map(f => f.name), ['notes.md']);
    assert.equal(res.body.artifacts.find(a => a.dirName === 'inner').name, 'inner');
  } finally { s.done(); }
});

test('Skills Studio: open, save, sub-files, icons and delete work on a legitimate skill, a linked one included', { skip: !posix }, () => {
  const s = studio();
  try {
    const gs = path.join(s.home, '.claude', 'skills');
    fs.mkdirSync(path.join(s.root, 'dev', 'linked', 'modules'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'dev', 'linked', 'SKILL.md'), skillMd('linked'));
    fs.writeFileSync(path.join(s.root, 'dev', 'linked', 'modules', 'a.md'), 'a');
    fs.symlinkSync(path.join(s.root, 'dev', 'linked'), path.join(gs, 'linked'));
    const id = s.id(`skill:${path.join(gs, 'linked')}`);
    const real = path.join(s.root, 'dev', 'linked');

    const open = s.call('GET', '/api/skills-studio/artifact/:id', { params: { id } });
    assert.equal(open.statusCode, 200);
    assert.equal(open.body.frontmatter.name, 'linked');
    assert.deepEqual(open.body.subFiles.map(f => f.path), ['modules']);

    assert.equal(s.call('PUT', '/api/skills-studio/artifact/:id', { params: { id }, body: { rawContent: skillMd('renamed') } }).statusCode, 200);
    assert.match(fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8'), /name: renamed/);

    assert.equal(s.call('GET', '/api/skills-studio/artifact/:id/file', { params: { id }, query: { path: 'modules/a.md' } }).body.content, 'a');
    assert.equal(s.call('PUT', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'modules/a.md', content: 'changed' } }).statusCode, 200);
    assert.equal(fs.readFileSync(path.join(real, 'modules', 'a.md'), 'utf8'), 'changed');
    assert.equal(s.call('PUT', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'new/dir/b.md', content: 'b' } }).statusCode, 200);
    assert.equal(fs.readFileSync(path.join(real, 'new', 'dir', 'b.md'), 'utf8'), 'b');
    assert.equal(s.call('POST', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'c.md', content: 'c' } }).statusCode, 200);
    assert.equal(s.call('POST', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'c.md', content: 'again' } }).statusCode, 409);
    assert.equal(fs.readFileSync(path.join(real, 'c.md'), 'utf8'), 'c');
    assert.equal(s.call('POST', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'folder/sub', isDir: true } }).statusCode, 200);
    assert.equal(fs.statSync(path.join(real, 'folder', 'sub')).isDirectory(), true);
    assert.equal(s.call('DELETE', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'new' } }).statusCode, 200);
    assert.equal(fs.existsSync(path.join(real, 'new')), false);
    assert.equal(s.call('DELETE', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'missing.md' } }).statusCode, 404);

    // Icons.
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    assert.equal(s.call('POST', '/api/skills-studio/artifact/:id/icon', { params: { id }, body: png, headers: { 'content-type': 'image/png' } }).statusCode, 200);
    assert.deepEqual([...fs.readFileSync(path.join(real, 'icon.png'))], [...png]);
    const icon = s.call('GET', '/api/skills-studio/artifact/:id/icon', { params: { id } });
    assert.equal(icon.headers['Content-Type'], 'image/png');
    assert.deepEqual([...icon.body], [...png]);
    assert.equal(s.call('POST', '/api/skills-studio/artifact/:id/icon', { params: { id }, body: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } }).statusCode, 200);
    assert.equal(fs.existsSync(path.join(real, 'icon.png')), false, 'the old icon is replaced');
    assert.equal(s.call('DELETE', '/api/skills-studio/artifact/:id/icon', { params: { id } }).statusCode, 200);
    assert.equal(fs.existsSync(path.join(real, 'icon.svg')), false);

    // Links that lead out are refused, and nothing outside is touched.
    fs.writeFileSync(path.join(s.root, 'victim.txt'), 'do not touch');
    fs.symlinkSync(path.join(s.root, 'victim.txt'), path.join(real, 'out.md'));
    fs.symlinkSync(s.root, path.join(real, 'up'));
    assert.equal(s.call('GET', '/api/skills-studio/artifact/:id/file', { params: { id }, query: { path: 'out.md' } }).statusCode, 403);
    assert.equal(s.call('PUT', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'out.md', content: 'x' } }).statusCode, 403);
    assert.equal(s.call('PUT', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'up/planted.md', content: 'x' } }).statusCode, 403);
    assert.equal(s.call('DELETE', '/api/skills-studio/artifact/:id/file', { params: { id }, body: { path: 'up/victim.txt' } }).statusCode, 403);
    assert.equal(fs.readFileSync(path.join(s.root, 'victim.txt'), 'utf8'), 'do not touch');
    assert.equal(fs.existsSync(path.join(s.root, 'planted.md')), false);
    // A FIFO among the sub-files: refused at once, not read.
    execFileSync('mkfifo', [path.join(real, 'pipe.md')]);
    const started = Date.now();
    assert.equal(s.call('GET', '/api/skills-studio/artifact/:id/file', { params: { id }, query: { path: 'pipe.md' } }).statusCode, 400);
    assert.ok(Date.now() - started < 1000);

    // Deleting the skill removes the link the user made, not the folder it points to.
    assert.equal(s.call('DELETE', '/api/skills-studio/artifact/:id', { params: { id } }).statusCode, 200);
    assert.equal(fs.existsSync(path.join(gs, 'linked')), false);
    assert.equal(fs.existsSync(path.join(real, 'SKILL.md')), true);
  } finally { s.done(); }
});

test('Skills Studio: create, export, import, install and uninstall', { skip: !posix }, () => {
  const s = studio();
  try {
    const made = s.call('POST', '/api/skills-studio/create', { body: { type: 'skill', scope: 'project', projectPath: s.project, name: 'fresh', rawContent: skillMd('fresh') } });
    assert.equal(made.statusCode, 200);
    const dir = path.join(s.project, '.claude', 'skills', 'fresh');
    assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /name: fresh/);
    assert.equal(s.call('POST', '/api/skills-studio/create', { body: { type: 'skill', scope: 'project', projectPath: s.project, name: 'fresh', rawContent: 'x' } }).statusCode, 409);
    assert.equal(s.call('POST', '/api/skills-studio/create', { body: { type: 'command', scope: 'global', name: 'go', rawContent: '---\ndescription: go\n---\nGo' } }).statusCode, 200);
    assert.equal(fs.existsSync(path.join(s.home, '.claude', 'commands', 'go.md')), true);

    // Export: the skill's own files, a link cycle walked once, a link out and a FIFO left out.
    fs.mkdirSync(path.join(dir, 'modules'));
    fs.writeFileSync(path.join(dir, 'modules', 'a.md'), 'a');
    fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.from([1, 2, 3]));
    fs.symlinkSync(dir, path.join(dir, 'modules', 'loop'));
    fs.writeFileSync(path.join(s.root, 'secret.txt'), 'SECRET');
    fs.symlinkSync(path.join(s.root, 'secret.txt'), path.join(dir, 'leak.txt'));
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    const id = s.id(`skill:${dir}`);
    const started = Date.now();
    const exported = s.call('GET', '/api/skills-studio/export/:id', { params: { id } });
    assert.ok(Date.now() - started < 2000);
    assert.equal(exported.statusCode, 200);
    const bundle = JSON.parse(exported.body);
    assert.deepEqual(Object.keys(bundle.files).sort(), ['SKILL.md', 'modules/a.md', 'shot.png']);
    assert.equal(bundle.files['shot.png'].base64, Buffer.from([1, 2, 3]).toString('base64'));
    assert.equal(exported.body.includes('SECRET'), false);
    const cmd = JSON.parse(s.call('GET', '/api/skills-studio/export/:id', { params: { id: s.id(`command:${path.join(s.home, '.claude', 'commands', 'go.md')}`) } }).body);
    assert.deepEqual(Object.keys(cmd.files), ['go.md']);

    // Import: into the user's folders, and refused where a link would take the write elsewhere.
    const imported = s.call('POST', '/api/skills-studio/import', { body: { bundle: { ...bundle, name: 'copy' }, scope: 'global' } });
    assert.equal(imported.statusCode, 200);
    const copy = path.join(s.home, '.claude', 'skills', 'copy');
    assert.equal(fs.readFileSync(path.join(copy, 'modules', 'a.md'), 'utf8'), 'a');
    assert.deepEqual([...fs.readFileSync(path.join(copy, 'shot.png'))], [1, 2, 3]);
    assert.equal(s.call('POST', '/api/skills-studio/import', { body: { bundle: { ...bundle, name: 'copy' }, scope: 'global' } }).statusCode, 409);
    assert.equal(s.call('POST', '/api/skills-studio/import', { body: { bundle: { ...cmd, name: 'go2', files: { 'go2.md': 'Go 2' } }, scope: 'project', projectPath: s.project } }).statusCode, 200);
    assert.equal(fs.readFileSync(path.join(s.project, '.claude', 'commands', 'go2.md'), 'utf8'), 'Go 2');
    fs.writeFileSync(path.join(s.root, 'victim.txt'), 'do not touch');
    fs.symlinkSync(path.join(s.root, 'victim.txt'), path.join(s.project, '.claude', 'commands', 'evil.icon.png'));
    const evil = s.call('POST', '/api/skills-studio/import', { body: { bundle: { format: 'synabun-skill-bundle', version: 1, type: 'command', name: 'evil', files: { 'evil.md': 'x', 'evil.icon.png': { base64: 'AAAA' } } }, scope: 'project', projectPath: s.project } });
    assert.equal(evil.statusCode, 403);
    assert.equal(fs.readFileSync(path.join(s.root, 'victim.txt'), 'utf8'), 'do not touch');

    // Install a bundled skill over whatever is there, and uninstall it.
    fs.mkdirSync(path.join(s.bundled, 'shipped'));
    fs.writeFileSync(path.join(s.bundled, 'shipped', 'SKILL.md'), skillMd('shipped'));
    const target = path.join(s.home, '.claude', 'skills', 'shipped');
    fs.mkdirSync(path.join(s.root, 'elsewhere'));
    fs.writeFileSync(path.join(s.root, 'elsewhere', 'keep.txt'), 'keep');
    fs.symlinkSync(path.join(s.root, 'elsewhere'), target);
    assert.equal(s.call('POST', '/api/skills-studio/install', { body: { dirName: 'shipped' } }).statusCode, 200);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false, 'the link was replaced, not written through');
    assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /name: shipped/);
    assert.deepEqual(fs.readdirSync(path.join(s.root, 'elsewhere')), ['keep.txt']);
    assert.equal(s.call('DELETE', '/api/skills-studio/install', { body: { dirName: 'shipped' } }).statusCode, 200);
    assert.equal(fs.existsSync(target), false);
    assert.equal(s.call('DELETE', '/api/skills-studio/install', { body: { dirName: 'shipped' } }).statusCode, 200);
  } finally { s.done(); }
});
