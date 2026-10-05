// Review 4 of the Claude panel parity build (the release gate), files on disk
// and the routes that touch them.
// W01: the /permissions view reads settings files a repository can ship. They
//      are read as regular files, bounded, without blocking on a FIFO, and a
//      project's files only when they are really inside the project. The same
//      for the two other reads of a repository-supplied name in the panel's
//      server code (a project's PLAN.md, a plugin's command files).
// W03: importing a bundle never replaces a file that already exists unless the
//      request says so.
// T06: the session list finds a session of a named Claude account in that
//      account's catalogue.
// Symlinks, FIFOs: POSIX only. A read that would block runs in a child process
// with a deadline, so a regression fails here instead of hanging the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readPermissionRules } from '../lib/claude-permission-rules.js';
import * as confine from '../lib/path-confine.js';
import * as confined from '../lib/confined-fs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
const posix = process.platform !== 'win32';
const sandbox = (name) => fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `synabun-${name}-`)));
const RULES = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'], ask: ['Edit'], additionalDirectories: ['/tmp/x'], defaultMode: 'plan' } });

function repo() {
  const root = sandbox('w01');
  const home = path.join(root, 'home');
  const project = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  return { root, home, project, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// readPermissionRules() in a child process with a deadline: a read that blocks
// (a FIFO nobody writes to) is killed and reported, never waited for.
function readRulesInChild(args) {
  const url = pathToFileURL(path.join(HERE, '..', 'lib', 'claude-permission-rules.js')).href;
  const script = `import(${JSON.stringify(url)}).then(m => { process.stdout.write(JSON.stringify(m.readPermissionRules(${JSON.stringify(args)}))); });`;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 8000, killSignal: 'SIGKILL', encoding: 'utf8' });
  return { timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL', rules: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

// ── W01 ──

test('W01: a project settings file that is a FIFO, or a link to one, is refused without waiting on it', { skip: !posix }, () => {
  const s = repo();
  try {
    execFileSync('mkfifo', [path.join(s.root, 'outside.fifo')]);
    fs.symlinkSync(path.join(s.root, 'outside.fifo'), path.join(s.project, '.claude', 'settings.json'));
    execFileSync('mkfifo', [path.join(s.project, '.claude', 'settings.local.json')]);
    const started = Date.now();
    const out = readRulesInChild({ home: s.home, project: s.project });
    assert.equal(out.timedOut, false, 'the read came back: nothing waited on a pipe');
    assert.ok(Date.now() - started < 6000);
    for (const scope of [out.rules.project, out.rules.local]) {
      assert.equal(scope.exists, true);
      assert.ok(scope.error, 'the view says the file was not read');
      assert.deepEqual([scope.allow, scope.deny, scope.ask], [[], [], []]);
    }
    assert.match(out.rules.local.error, /regular file/i);
  } finally { s.done(); }
});

test('W01: a project settings file that is a link to a device is not opened as a file', { skip: !posix }, () => {
  const s = repo();
  try {
    // /dev/null stands for any device: what refuses it is its type, before a byte is read.
    fs.symlinkSync('/dev/null', path.join(s.project, '.claude', 'settings.json'));
    const rules = readPermissionRules({ home: s.home, project: s.project });
    assert.equal(rules.project.exists, true);
    assert.match(rules.project.error, /leads out of the project/);
    assert.equal(/JSON/.test(rules.project.error), false, 'it was refused, not read and found empty');
  } finally { s.done(); }
});

test('W01: a project settings file that is a link out of the project is not read', { skip: !posix }, () => {
  const s = repo();
  try {
    fs.writeFileSync(path.join(s.root, 'elsewhere.json'), JSON.stringify({ permissions: { allow: ['Bash(SECRET:*)'] } }));
    fs.symlinkSync(path.join(s.root, 'elsewhere.json'), path.join(s.project, '.claude', 'settings.json'));
    const rules = readPermissionRules({ home: s.home, project: s.project });
    assert.deepEqual(rules.project.allow, []);
    assert.match(rules.project.error, /leads out of the project/);
    assert.equal(JSON.stringify(rules).includes('SECRET'), false);

    // The whole .claude folder linked out of the project: the same.
    const other = path.join(s.root, 'repo2');
    fs.mkdirSync(path.join(s.root, 'outside'));
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(s.root, 'outside', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['SECRET'] } }));
    fs.symlinkSync(path.join(s.root, 'outside'), path.join(other, '.claude'));
    const linked = readPermissionRules({ home: s.home, project: other });
    assert.deepEqual(linked.local.deny, []);
    assert.match(linked.local.error, /leads out of the project/);
  } finally { s.done(); }
});

test('W01: a settings file larger than the bound is refused, not read', () => {
  const s = repo();
  try {
    const big = `{"permissions":{"allow":["Bash(big:*)"]}}${' '.repeat(4 * 1024 * 1024 + 16)}`;
    fs.writeFileSync(path.join(s.project, '.claude', 'settings.json'), big);
    fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), big);
    const rules = readPermissionRules({ home: s.home, project: s.project });
    for (const scope of [rules.project, rules.user]) {
      assert.deepEqual(scope.allow, []);
      assert.match(scope.error, /larger than 4 MB/);
    }
  } finally { s.done(); }
});

test('W01: the user\'s own settings file, of every account, is read the same bounded way: a FIFO or a device behind it is refused', { skip: !posix }, () => {
  const s = repo();
  try {
    const account = path.join(s.root, 'accounts', 'work');
    fs.mkdirSync(account, { recursive: true });
    execFileSync('mkfifo', [path.join(s.root, 'user.fifo')]);
    fs.symlinkSync(path.join(s.root, 'user.fifo'), path.join(s.home, '.claude', 'settings.json'));
    fs.symlinkSync('/dev/null', path.join(account, 'settings.json'));
    const def = readRulesInChild({ home: s.home });
    assert.equal(def.timedOut, false);
    assert.match(def.rules.user.error, /regular file/i);
    const named = readRulesInChild({ home: s.home, accountHome: account });
    assert.equal(named.timedOut, false);
    assert.match(named.rules.user.error, /regular file/i);
    assert.equal(named.rules.project, null);
  } finally { s.done(); }
});

test('W01: ordinary settings files read exactly as before, links the user made included', { skip: !posix }, () => {
  const s = repo();
  try {
    // The user's settings linked into their dotfiles; a named account sharing the default file.
    fs.mkdirSync(path.join(s.root, 'dotfiles'));
    fs.writeFileSync(path.join(s.root, 'dotfiles', 'claude-settings.json'), RULES);
    fs.symlinkSync(path.join(s.root, 'dotfiles', 'claude-settings.json'), path.join(s.home, '.claude', 'settings.json'));
    const account = path.join(s.root, 'accounts', 'work');
    fs.mkdirSync(account, { recursive: true });
    fs.symlinkSync(path.join(s.home, '.claude', 'settings.json'), path.join(account, 'settings.json'));
    // A project: a plain file, a file that does not parse, and a link that stays inside the project.
    fs.writeFileSync(path.join(s.project, '.claude', 'settings.json'), RULES);
    fs.writeFileSync(path.join(s.project, '.claude', 'settings.local.json'), '{ not json');
    const expected = { exists: true, defaultMode: 'plan', allow: ['Bash(ls:*)'], deny: ['WebFetch'], ask: ['Edit'], additionalDirectories: ['/tmp/x'], error: '' };

    const rules = readPermissionRules({ home: s.home, project: s.project });
    assert.deepEqual(rules.user, { path: path.join(s.home, '.claude', 'settings.json'), ...expected });
    assert.deepEqual(rules.project, { path: path.join(s.project, '.claude', 'settings.json'), ...expected });
    assert.equal(rules.local.exists, true);
    assert.match(rules.local.error, /^could not be read \(/);
    assert.deepEqual(rules.local.allow, []);

    const named = readPermissionRules({ home: s.home, accountHome: account, project: s.project });
    assert.deepEqual(named.user, { path: path.join(account, 'settings.json'), ...expected, shared: true, editable: true });

    fs.rmSync(path.join(s.project, '.claude', 'settings.local.json'));
    fs.writeFileSync(path.join(s.project, '.claude', 'shared.json'), RULES);
    fs.symlinkSync(path.join(s.project, '.claude', 'shared.json'), path.join(s.project, '.claude', 'settings.local.json'));
    assert.deepEqual(readPermissionRules({ home: s.home, project: s.project }).local.allow, ['Bash(ls:*)'], 'a link that stays in the project is read');

    // Nothing there: not an error.
    const empty = readPermissionRules({ home: path.join(s.root, 'nobody'), project: path.join(s.root, 'nothing') });
    assert.deepEqual(empty.user, { path: path.join(s.root, 'nobody', '.claude', 'settings.json'), exists: false, defaultMode: '', allow: [], deny: [], ask: [], additionalDirectories: [], error: '' });
    assert.equal(empty.project.exists, false);
    assert.equal(readPermissionRules({ home: s.home }).project, null);
  } finally { s.done(); }
});

test('W01: the permission-rules module reads no file with an unbounded call', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'claude-permission-rules.js'), 'utf8');
  assert.equal(/\breadFileSync\b/.test(src), false, 'readFileSync is gone from the module');
  assert.match(src, /readConfinedFile\(/);
});

// ── W01, the other reads of a repository-supplied name ──

function cut(from, to) {
  const a = server.indexOf(from);
  const b = server.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `server.js still has the section between ${JSON.stringify(from.slice(0, 50))} and ${JSON.stringify(to.slice(0, 50))}`);
  return server.slice(a, b);
}
const raw = (name) => () => { throw new Error(`raw ${name} on a repository-supplied path`); };

test('W01: a project\'s PLAN.md is compared through a bounded regular-file read', { skip: !posix }, () => {
  const root = sandbox('w01plan');
  try {
    const src = cut('function cleanupMatchingRootPlan(cwd, content) {', 'const _NARRATION_PREFIX');
    const project = path.join(root, 'repo');
    fs.mkdirSync(project);
    const deps = {
      resolve: path.resolve, existsSync: fs.existsSync, statSync: fs.statSync, unlinkSync: fs.unlinkSync,
      validateProjectPath: (p) => (path.resolve(p).startsWith(project + path.sep) ? path.resolve(p) : null),
      readFileSync: raw('readFileSync'), ...confined,
    };
    const cleanup = new Function(...Object.keys(deps), `${src}; return cleanupMatchingRootPlan;`)(...Object.values(deps));
    // The ordinary case: the same plan in the project root is removed.
    fs.writeFileSync(path.join(project, 'PLAN.md'), '# Plan\r\n\r\nDo it\r\n');
    assert.equal(cleanup(project, '# Plan\n\nDo it'), true);
    assert.equal(fs.existsSync(path.join(project, 'PLAN.md')), false);
    // Another plan stays.
    fs.writeFileSync(path.join(project, 'PLAN.md'), '# Other');
    assert.equal(cleanup(project, '# Plan\n\nDo it'), false);
    assert.equal(fs.existsSync(path.join(project, 'PLAN.md')), true);
    // A PLAN.md far larger than a plan is not read into memory.
    fs.writeFileSync(path.join(project, 'PLAN.md'), `# Plan${' '.repeat(3 * 1024 * 1024)}`);
    assert.equal(cleanup(project, '# Plan'), false);
    assert.equal(fs.existsSync(path.join(project, 'PLAN.md')), true);
    // A PLAN.md that is a link out of the project is neither read nor removed.
    fs.rmSync(path.join(project, 'PLAN.md'));
    fs.writeFileSync(path.join(root, 'outside.md'), '# Plan');
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(project, 'PLAN.md'));
    assert.equal(cleanup(project, '# Plan'), false);
    assert.equal(fs.lstatSync(path.join(project, 'PLAN.md')).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('W01: a plugin\'s command files are read as regular files, bounded, never a FIFO or a device', { skip: !posix }, () => {
  const root = sandbox('w01plug');
  try {
    const src = cut("app.get('/api/claude-code/plugin-commands', (req, res) => {", '// POST /api/sidepanel/kill-session');
    const commands = path.join(root, '.claude', 'plugins', 'cache', 'market', 'plug', '1.0.0', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    fs.writeFileSync(path.join(commands, 'good.md'), '---\ndescription: a good one\n---\nBody');
    fs.writeFileSync(path.join(commands, 'toml.toml'), 'description = "from toml"\n');
    execFileSync('mkfifo', [path.join(commands, 'pipe.md')]);
    fs.symlinkSync('/dev/zero', path.join(commands, 'zero.md'));
    fs.writeFileSync(path.join(root, 'secret.md'), '---\ndescription: SECRET\n---\n');
    fs.symlinkSync(path.join(root, 'secret.md'), path.join(commands, 'leak.md'));
    fs.writeFileSync(path.join(commands, 'huge.md'), `---\ndescription: huge\n---\n${' '.repeat(2 * 1024 * 1024)}`);
    let handler = null;
    const deps = {
      app: { get: (route, h) => { handler = h; } }, os: { homedir: () => root },
      join: path.join, dirname: path.dirname, existsSync: fs.existsSync, readdirSync: fs.readdirSync,
      readFileSync: raw('readFileSync'), ...confined,
    };
    new Function(...Object.keys(deps), src)(...Object.values(deps));
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const started = Date.now();
    handler({ query: {} }, res);
    assert.ok(Date.now() - started < 3000, 'nothing waited on a pipe or read a device');
    assert.equal(res.statusCode, 200);
    const byName = Object.fromEntries(res.body.commands.map(c => [c.name, c.description]));
    // Every command is still listed; what could not be read as a small regular file has no description.
    assert.deepEqual(byName, { good: 'a good one', toml: 'from toml', pipe: '', zero: '', leak: '', huge: '' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── W03 ──

// The Skills Studio routes, run from their own source (see claude-review3-studio-routes.test.mjs).
function studio() {
  const root = sandbox('studio4');
  const home = path.join(root, 'home');
  const project = path.join(root, 'repo');
  const bundled = path.join(root, 'bundled');
  for (const d of [path.join(home, '.claude', 'skills'), path.join(home, '.claude', 'agents'), path.join(home, '.claude', 'commands'),
    path.join(project, '.claude', 'skills'), path.join(project, '.claude', 'commands'), path.join(project, '.claude', 'agents'), bundled]) fs.mkdirSync(d, { recursive: true });
  const src = cut('function getGlobalAgentsDir() {', '// GET /api/health — Check if SQLite database is accessible');
  const routes = new Map();
  const reg = (method) => (route, ...handlers) => routes.set(`${method} ${route}`, handlers[handlers.length - 1]);
  const deps = {
    app: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') }, express: { raw: () => (req, res, next) => next?.() }, Buffer,
    process: { env: { HOME: home }, platform: process.platform },
    join: path.join, resolve: path.resolve, basename: path.basename, dirname: path.dirname, extname: path.extname,
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, cpSync: fs.cpSync,
    readFileSync: raw('readFileSync'), writeFileSync: raw('writeFileSync'), mkdirSync: raw('mkdirSync'), unlinkSync: raw('unlinkSync'), rmSync: raw('rmSync'), statSync: raw('statSync'),
    loadHookProjects: () => [{ path: project, label: 'Repo' }],
    getGlobalSkillsDir: () => path.join(home, '.claude', 'skills'),
    SKILLS_SOURCE_DIR: bundled,
    isDirEntry: (entry) => entry.isDirectory() || entry.isSymbolicLink(),
    ...confine, ...confined,
  };
  new Function(...Object.keys(deps), src)(...Object.values(deps));
  const call = (method, route, { params = {}, query = {}, body = undefined } = {}) => {
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `${method} ${route} is registered`);
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    handler({ params, query, body, headers: {} }, res);
    return res;
  };
  const importBundle = (bundle, extra = {}) => call('POST', '/api/skills-studio/import', { body: { bundle: { format: 'synabun-skill-bundle', version: 1, ...bundle }, scope: 'global', ...extra } });
  return { root, home, project, call, importBundle, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const [type, folder] of [['command', 'commands'], ['agent', 'agents']]) {
  test(`W03: importing a ${type} bundle never replaces a sibling ${type} that already exists`, { skip: !posix }, () => {
    const s = studio();
    try {
      const dir = path.join(s.home, '.claude', folder);
      fs.writeFileSync(path.join(dir, 'existing.md'), 'the user wrote this');
      fs.writeFileSync(path.join(dir, 'existing.icon.svg'), '<svg>theirs</svg>');
      const res = s.importBundle({ type, name: 'fresh', files: { 'fresh.md': 'new', 'existing.md': 'OVERWRITTEN', 'existing.icon.svg': '<svg>OVERWRITTEN</svg>' } });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'import_exists');
      assert.deepEqual(res.body.existing, ['existing.md', 'existing.icon.svg'], 'the files in the way are named');
      assert.match(res.body.error, /existing\.md/);
      assert.equal(fs.readFileSync(path.join(dir, 'existing.md'), 'utf8'), 'the user wrote this');
      assert.equal(fs.readFileSync(path.join(dir, 'existing.icon.svg'), 'utf8'), '<svg>theirs</svg>');
      assert.equal(fs.existsSync(path.join(dir, 'fresh.md')), false, 'nothing of a refused bundle is written');

      // The same in a project.
      fs.writeFileSync(path.join(s.project, '.claude', folder, 'existing.md'), 'project file');
      const inProject = s.importBundle({ type, name: 'fresh', files: { 'fresh.md': 'new', 'existing.md': 'OVERWRITTEN' } }, { scope: 'project', projectPath: s.project });
      assert.equal(inProject.statusCode, 409);
      assert.deepEqual(inProject.body.existing, ['existing.md']);
      assert.equal(fs.readFileSync(path.join(s.project, '.claude', folder, 'existing.md'), 'utf8'), 'project file');
    } finally { s.done(); }
  });

  test(`W03: a ${type} bundle whose own file exists is refused the same way, and replaces only when the request confirms it`, { skip: !posix }, () => {
    const s = studio();
    try {
      const dir = path.join(s.home, '.claude', folder);
      fs.writeFileSync(path.join(dir, 'mine.md'), 'old');
      const bundle = { type, name: 'mine', files: { 'mine.md': 'new', 'mine.icon.svg': '<svg/>' } };
      const refused = s.importBundle(bundle);
      assert.equal(refused.statusCode, 409);
      assert.deepEqual(refused.body.existing, ['mine.md']);
      assert.equal(fs.readFileSync(path.join(dir, 'mine.md'), 'utf8'), 'old');
      assert.equal(fs.existsSync(path.join(dir, 'mine.icon.svg')), false);
      // Anything but `overwrite: true` is not a confirmation.
      for (const overwrite of ['true', 1, 'yes', {}, false, null]) assert.equal(s.importBundle(bundle, { overwrite }).statusCode, 409, `overwrite: ${JSON.stringify(overwrite)}`);
      assert.equal(fs.readFileSync(path.join(dir, 'mine.md'), 'utf8'), 'old');
      const confirmed = s.importBundle(bundle, { overwrite: true });
      assert.equal(confirmed.statusCode, 200);
      assert.deepEqual(confirmed.body, { ok: true, name: 'mine', type });
      assert.equal(fs.readFileSync(path.join(dir, 'mine.md'), 'utf8'), 'new');
      assert.equal(fs.readFileSync(path.join(dir, 'mine.icon.svg'), 'utf8'), '<svg/>');
    } finally { s.done(); }
  });
}

test('W03: a bundle that collides with nothing imports as before (command, agent, skill)', { skip: !posix }, () => {
  const s = studio();
  try {
    const cmd = s.importBundle({ type: 'command', name: 'go', files: { 'go.md': 'Go', 'go.icon.png': { base64: Buffer.from([1, 2, 3]).toString('base64') } } });
    assert.equal(cmd.statusCode, 200);
    assert.deepEqual(cmd.body, { ok: true, name: 'go', type: 'command' });
    assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'commands', 'go.md'), 'utf8'), 'Go');
    assert.deepEqual([...fs.readFileSync(path.join(s.home, '.claude', 'commands', 'go.icon.png'))], [1, 2, 3]);
    const agent = s.importBundle({ type: 'agent', name: 'helper', files: { 'helper.md': 'Help' } }, { scope: 'project', projectPath: s.project });
    assert.equal(agent.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(s.project, '.claude', 'agents', 'helper.md'), 'utf8'), 'Help');
    const skill = s.importBundle({ type: 'skill', name: 'kit', files: { 'SKILL.md': 'Skill', 'modules/a.md': 'a' } });
    assert.equal(skill.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'kit', 'modules', 'a.md'), 'utf8'), 'a');
    // A path that is not a plain name is still skipped for a command, not written elsewhere.
    const odd = s.importBundle({ type: 'command', name: 'odd', files: { 'odd.md': 'Odd', '../escape.md': 'x', 'sub/inner.md': 'x' } });
    assert.equal(odd.statusCode, 200);
    assert.deepEqual(fs.readdirSync(path.join(s.home, '.claude', 'commands')).sort(), ['go.icon.png', 'go.md', 'odd.md']);
    assert.equal(fs.existsSync(path.join(s.home, '.claude', 'escape.md')), false);
  } finally { s.done(); }
});

test('W03: a skill import never writes into a skill that exists, confirmed or not, and names no file twice', { skip: !posix }, () => {
  const s = studio();
  try {
    const dir = path.join(s.home, '.claude', 'skills', 'kit');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'theirs');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'theirs too');
    for (const extra of [{}, { overwrite: true }]) {
      const res = s.importBundle({ type: 'skill', name: 'kit', files: { 'SKILL.md': 'OVERWRITTEN', 'notes.md': 'OVERWRITTEN' } }, extra);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.error, /already exists/);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'theirs');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'theirs too');
    // Two names for one file in a bundle: refused before anything is written.
    const twice = s.importBundle({ type: 'skill', name: 'twice', files: { 'SKILL.md': 'one', './SKILL.md': 'two' } });
    assert.equal(twice.statusCode, 400);
    assert.equal(fs.existsSync(path.join(s.home, '.claude', 'skills', 'twice')), false);
    // The same on a disk that ignores case: nothing is made, so nothing is left half written.
    const cased = s.importBundle({ type: 'skill', name: 'cased', files: { 'SKILL.md': 'one', 'skill.md': 'two' } });
    assert.equal(cased.statusCode, 400);
    assert.equal(fs.existsSync(path.join(s.home, '.claude', 'skills', 'cased')), false);
    for (const overwrite of [undefined, true]) {
      const cmd = s.importBundle({ type: 'command', name: 'deploy', files: { 'Deploy.md': 'one', 'deploy.md': 'two' } }, { overwrite });
      assert.equal(cmd.statusCode, 400);
      assert.match(cmd.body.error, /same file twice/);
    }
    assert.deepEqual(fs.readdirSync(path.join(s.home, '.claude', 'commands')), []);
  } finally { s.done(); }
});

test('W03: the files of an import are created exclusively unless the overwrite was confirmed', () => {
  const src = cut("app.post('/api/skills-studio/import', (req, res) => {", '// GET /api/health — Check if SQLite database is accessible');
  const writes = src.match(/writeConfinedFile\([^;]*;/g) || [];
  assert.equal(writes.length, 2, 'one write for a skill, one for a command or an agent');
  for (const w of writes) assert.match(w, /exclusive:/, w);
  assert.match(src, /req\.body\??\.overwrite === true|overwrite === true/);
});

// ── T06 ──

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const keyOf = (p) => p.replace(/[/\\]/g, '-').replace(/:/g, '-');

test('T06: the projects of one account that hold a session', { skip: !posix }, () => {
  const root = sandbox('t06');
  try {
    const projects = [{ path: path.join(root, 'a') }, { path: path.join(root, 'b') }, { path: path.join(root, 'c') }];
    const work = path.join(root, 'accounts', 'work', 'projects');
    fs.mkdirSync(path.join(work, keyOf(projects[1].path)), { recursive: true });
    fs.writeFileSync(path.join(work, keyOf(projects[1].path), `${SID}.jsonl`), '{}\n');
    assert.equal(typeof confine.sessionProjects, 'function');
    assert.deepEqual(confine.sessionProjects({ sessionId: SID, projects, projectsDir: work, pathToKey: keyOf }), [projects[1].path]);
    assert.deepEqual(confine.sessionProjects({ sessionId: SID, projects, projectsDir: path.join(root, 'nowhere'), pathToKey: keyOf }), []);
    assert.throws(() => confine.sessionProjects({ sessionId: '../../etc/passwd', projects, projectsDir: work, pathToKey: keyOf }), (err) => err instanceof confine.PathConfineError && err.status === 400);
    // A transcript that is a link out of its folder is not a session of that project.
    fs.mkdirSync(path.join(work, keyOf(projects[2].path)));
    fs.writeFileSync(path.join(root, 'outside.jsonl'), '{}\n');
    fs.symlinkSync(path.join(root, 'outside.jsonl'), path.join(work, keyOf(projects[2].path), `${SID}.jsonl`));
    assert.deepEqual(confine.sessionProjects({ sessionId: SID, projects, projectsDir: work, pathToKey: keyOf }), [projects[1].path]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function sessionsRoute({ guest = false } = {}) {
  const root = sandbox('t06route');
  const home = path.join(root, 'home');
  const projects = [{ path: path.join(root, 'a'), label: 'A' }, { path: path.join(root, 'b'), label: 'B' }];
  const accountHomes = { work: path.join(root, 'accounts', 'work') };
  const put = (base, project, sid) => {
    const dir = path.join(base, 'projects', keyOf(project.path));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), '{}\n');
  };
  const src = cut("app.get('/api/claude-code/sessions', async (req, res) => {", '// GET /api/codex/sessions');
  let handler = null;
  const scanned = [];
  const deps = {
    app: { get: (route, h) => { handler = h; } },
    _sessionCacheMap: new Map(), _sessionEntriesCaches: new Map(), SESSION_CACHE_DIR: path.join(root, 'cache'),
    readdirSync: fs.readdirSync, unlinkSync: fs.unlinkSync, existsSync: fs.existsSync,
    join: path.join, resolve: path.resolve, basename: path.basename,
    process: { env: { HOME: home } },
    claudeSessionOverlay: { invalidate() {}, forProject: async () => new Map() },
    loadHookProjects: () => projects,
    pathToClaudeKey: keyOf,
    // The default account's list is built from its cache; a stand-in that lists the folder's transcripts.
    getSessionEntriesForRequest: async (projDir) => { scanned.push(projDir); return fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')).map(f => ({ sessionId: f.slice(0, -6), firstPrompt: 'hello', modified: '2026-10-03T00:00:00.000Z', created: '2026-10-03T00:00:00.000Z' })); },
    overlaySessions: (entries) => entries,
    matchesSessionFilter: (e, { search }) => !search || e.sessionId.toLowerCase().includes(search),
    isGuestRequest: () => guest,
    panelAccountHome: (value) => {
      if (!value || value === 'default') return '';
      if (!accountHomes[value]) throw Object.assign(new Error('That Claude account is no longer set up in SynaBun.'), { status: 404, code: 'account_unavailable' });
      return accountHomes[value];
    },
    sessionProjects: confine.sessionProjects,
  };
  new Function(...Object.keys(deps), src)(...Object.values(deps));
  const call = async (query) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query, headers: {} }, res);
    return res;
  };
  const owners = (res) => (res.body.projects || []).filter(p => p.sessions.some(x => x.sessionId === SID)).map(p => p.label);
  return { root, home, projects, accountHomes, put, call, owners, scanned, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('T06: the session list finds a named account\'s session in that account\'s catalogue, not in the default one', { skip: !posix }, async () => {
  const r = sessionsRoute();
  try {
    // The tab names project A; the work account's transcript is under B. The default account has no such session.
    r.put(r.accountHomes.work, r.projects[1], SID);
    const named = await r.call({ search: SID, limit: '5', account: 'work' });
    assert.equal(named.statusCode, 200);
    assert.deepEqual(r.owners(named), ['B']);
    assert.deepEqual(named.body.projects.map(p => [p.label, p.total]), [['A', 0], ['B', 1]]);
    assert.deepEqual(r.scanned, [], 'the default account\'s list and its cache were not used for a named account');
    // The default account's catalogue does not have it, and still answers as before.
    const def = await r.call({ search: SID, limit: '5' });
    assert.deepEqual(r.owners(def), []);
    assert.deepEqual(await r.call({ search: SID, limit: '5', account: 'default' }).then(r.owners), []);

    // And the other way round: a default-account session is not reported for the named account.
    const other = '11111111-1111-4111-8111-111111111111';
    r.put(path.join(r.home, '.claude'), r.projects[0], other);
    const mine = await r.call({ search: other, limit: '5' });
    assert.deepEqual(mine.body.projects.find(p => p.label === 'A').sessions.map(x => x.sessionId), [other]);
    assert.equal(mine.body.projects.find(p => p.label === 'A').sessions[0].firstPrompt, 'hello', 'the default list is what it was');
    const theirs = await r.call({ search: other, limit: '5', account: 'work' });
    assert.deepEqual(theirs.body.projects.map(p => p.total), [0, 0]);
  } finally { r.done(); }
});

test('T06: an account that is gone, a guest, or a search that is not a session id is refused for a named account', { skip: !posix }, async () => {
  const r = sessionsRoute();
  try {
    const gone = await r.call({ search: SID, account: 'removed' });
    assert.equal(gone.statusCode, 404);
    assert.equal(gone.body.code, 'account_unavailable');
    const text = await r.call({ search: 'hello', account: 'work' });
    assert.equal(text.statusCode, 400);
    assert.deepEqual(r.scanned, []);
  } finally { r.done(); }
  const g = sessionsRoute({ guest: true });
  try {
    g.put(g.accountHomes.work, g.projects[1], SID);
    const res = await g.call({ search: SID, account: 'work' });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.stringify(res.body).includes(SID), false);
  } finally { g.done(); }
});
