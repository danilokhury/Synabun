// C127: the panel monolith (public/shared/ui-claude-panel.js) cannot be imported
// outside a browser, so nothing in the Node suite executed its 11k lines: a
// renamed helper or a missing import showed only when a user clicked the thing.
// This resolves every name in the monolith and in the cp/ modules with
// TypeScript's checker (allowJs + checkJs): an identifier that is declared
// nowhere, an import a module does not export, a module path that does not exist.
// It reads types from nothing and judges no types: only whether names resolve.
//
// TypeScript is a devDependency of mcp-server/ (nothing is installed for this
// test); without it the check is skipped, never failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, '..', 'public', 'shared');

function loadTypeScript() {
  for (const base of [join(HERE, '..', '..', 'mcp-server', 'package.json'), join(HERE, '..', 'package.json'), join(HERE, '..', '..', 'package.json')]) {
    try { return createRequire(base)('typescript'); } catch {}
  }
  return null;
}
const ts = loadTypeScript();

// 2304 cannot find name · 2552 cannot find name (did you mean) · 2305 / 2614 / 2724
// module has no such export · 2307 cannot find module · 2448 / 2454 used before
// its declaration / assignment.
const NAME_CODES = new Set([2304, 2552, 2305, 2614, 2724, 2307, 2448, 2454]);

function unresolvedNames(entryFiles, inScope) {
  const program = ts.createProgram(entryFiles, {
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  const found = [];
  let checked = 0;
  for (const sf of program.getSourceFiles()) {
    if (!inScope(sf.fileName)) continue;
    checked++;
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (!NAME_CODES.has(d.code) || d.start == null) continue;
      const { line } = sf.getLineAndCharacterOfPosition(d.start);
      const text = sf.text.split('\n')[line] || '';
      if (/^\s*(\*|\/\*\*|\/\/)/.test(text)) continue;             // a name inside a JSDoc line is prose
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      if (d.code === 2307 && /'https?:\/\//.test(message)) continue; // marked is loaded from its CDN at runtime
      found.push(`${sf.fileName.split('/public/shared/').pop()}:${line + 1} ${message}`);
    }
  }
  return { found, checked };
}

test('every name in the panel monolith and the cp/ modules resolves', { skip: ts ? false : 'typescript is not installed (mcp-server devDependency)' }, () => {
  const { found, checked } = unresolvedNames(
    [join(SHARED, 'ui-claude-panel.js')],
    (file) => file.endsWith('/public/shared/ui-claude-panel.js') || file.includes('/public/shared/cp/'),
  );
  assert.ok(checked >= 20, `the monolith and its cp/ modules were checked (${checked} files)`);
  assert.deepEqual(found, [], `unresolved names:\n${found.join('\n')}`);
});

test('the check has teeth: an undeclared name, a missing export and a missing module are reported', { skip: ts ? false : 'typescript is not installed (mcp-server devDependency)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-names-'));
  try {
    writeFileSync(join(dir, 'lib.js'), 'export function known() { return 1; }\n');
    writeFileSync(join(dir, 'main.js'), [
      "import { known, missingExport } from './lib.js';",
      "import { x } from './no-such-module.js';",
      '/** @param ctx { notAType } prose in a comment is not a name */',
      'export function run(tab) {',
      '  known(); missingExport(); x();',
      '  return renamedHelper(tab);',
      '}',
    ].join('\n'));
    const { found } = unresolvedNames([join(dir, 'main.js')], (file) => file.startsWith(dir) || file.includes('synabun-names-'));
    const text = found.join('\n');
    assert.match(text, /renamedHelper/);
    assert.match(text, /missingExport/);
    assert.match(text, /no-such-module/);
    assert.doesNotMatch(text, /notAType/);
    assert.equal(found.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
