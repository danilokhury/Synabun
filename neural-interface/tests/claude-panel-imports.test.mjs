import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The Claude sidepanel is a browser module that no test can import (it touches
// the DOM at load). A name it imports from a cp/ module that the module does
// not export is a load failure for the whole panel, and nothing else catches
// it before a browser does. This checks every such import against the real
// exports, and that the cp/ modules load without a document.

const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const statements = [...panel.matchAll(/import \{([^}]+)\} from '\.\/(cp\/[^']+)';/g)].map(m => ({
  names: m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean),
  path: m[2],
}));

test('the panel imports from its cp modules', () => {
  assert.ok(statements.length >= 15, `found ${statements.length} import statements`);
  assert.ok(statements.some(s => s.path === 'cp/cp-events.js'));
});

for (const { names, path } of statements) {
  test(`every name imported from ${path} is exported by it`, async () => {
    const mod = await import(new URL(`../public/shared/${path}`, import.meta.url));
    for (const name of names) assert.ok(name in mod, `${path} does not export ${name}`);
  });
}

test('automation tabs do not offer controls that act on another session', () => {
  const body = (signature) => {
    const start = panel.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found`);
    const rest = panel.slice(start + signature.length);
    const next = rest.search(/\n(?:async )?function /);
    return next >= 0 ? rest.slice(0, next) : rest;
  };
  // The mode control is hidden while the run is active (it lives in the loop
  // runtime, where this tab's mode does not reach) and back once it has ended:
  // what is sent then runs in this tab's own session, in the mode picked here.
  assert.match(body('function populateModeDropdown($dd, tab) {'), /\$dd\.hidden = !tab\.sdkMode \|\| !!tab\.automationActive;/);
  // The button is built by _attachRewindButton (live prompts and the rows of a
  // restored snapshot alike): an automation tab gets none on either path.
  assert.match(body('function _stampUserMessageUuid(tab, uuid) {'), /if \(!tab\.sdkMode\) return;\n  _attachRewindButton\(tab, row, uuid\);/);
  assert.match(body('function _attachRewindButton(tab, row, uuid) {'), /if \(!tab \|\| !row \|\| !uuid \|\| tab\.automationRunId \|\| row\.querySelector\('\.cp-rewind-btn'\)\) return;/);
  const send = body('function send({ shift = false } = {}) {');
  assert.match(send, /Could not stop the automation/);
  assert.doesNotMatch(send, /\}\)\.catch\(\(\) => \{\}\);\n\s+setRunning\(tab, false\);/, 'a failed stop no longer shows the tab as stopped');
});
