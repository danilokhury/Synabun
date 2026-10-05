import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTerminalModel } from '../lib/pty-host/snapshot.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

function freshTerminal(cols, rows) {
  const t = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, logLevel: 'off' });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
const writeAsync = (t, data) => new Promise(r => t.write(data, r));
const barrier = (m) => new Promise(r => m.barrier(r));

function cells(t, row) {
  const line = t.buffer.active.getLine(row);
  const out = [];
  for (let x = 0; x < t.cols; x++) {
    const c = line.getCell(x);
    out.push([c.getChars(), c.getWidth(), c.getFgColor(), c.getFgColorMode(), c.getBgColor(), c.isBold(), c.isItalic(), c.isUnderline()]);
  }
  return out;
}

test('snapshot round-trips colors, attributes, wide glyphs, modes, scroll region, cursor style and title', async () => {
  const model = createTerminalModel({ cols: 40, rows: 10, scrollback: 1000 });
  const input = [
    'plain \x1b[31mred\x1b[0m \x1b[38;5;208m256\x1b[0m \x1b[38;2;255;100;0;1mTRUE\x1b[0m\r\n',
    '\x1b[3mitalic\x1b[0m \x1b[4munder\x1b[0m 👍 中文 end\r\n',
    '\x1b[?2004h\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[5 q\x1b]0;My Title\x07',
    '\x1b[3;8r\x1b[5;4H\x1b[?25l',
  ].join('');
  model.write(input);
  await barrier(model);
  const snap = model.serialize();
  assert.equal(snap.cols, 40);
  assert.equal(snap.rows, 10);
  assert.ok(snap.plain.includes('plain red 256 TRUE'), snap.plain);
  assert.ok(snap.plain.includes('👍'), 'wide glyphs survive in plain text');

  // Reference terminal fed the raw input vs. a fresh one fed only the snapshot.
  const ref = freshTerminal(40, 10);
  await writeAsync(ref, input);
  const restored = freshTerminal(40, 10);
  await writeAsync(restored, snap.ansi);

  for (const row of [0, 1]) assert.deepEqual(cells(restored, row), cells(ref, row), `row ${row} cells`);
  assert.deepEqual(restored.modes, ref.modes, 'bracketed paste, app cursor keys, mouse tracking');
  const rc = restored._core, fc = ref._core;
  assert.equal(rc.coreMouseService.activeEncoding, 'SGR', 'SGR mouse encoding restored');
  assert.equal(rc.coreService.isCursorHidden, true, 'hidden cursor restored');
  assert.equal(rc.buffer.scrollTop, fc.buffer.scrollTop, 'scroll region top');
  assert.equal(rc.buffer.scrollBottom, fc.buffer.scrollBottom, 'scroll region bottom');
  assert.equal(rc.buffer.x, fc.buffer.x, 'cursor x');
  assert.equal(rc.buffer.y, fc.buffer.y, 'cursor y');
  assert.equal(rc.coreService.decPrivateModes.cursorStyle, 'bar');
  assert.equal(rc.coreService.decPrivateModes.cursorBlink, true);
  let restoredTitle = '';
  const probe = freshTerminal(40, 10);
  probe.onTitleChange(t => { restoredTitle = t; });
  await writeAsync(probe, snap.ansi);
  assert.equal(restoredTitle, 'My Title');
  model.dispose();
});

test('snapshot restores the alternate screen and serializes after resizes sequenced behind output', async () => {
  const model = createTerminalModel({ cols: 30, rows: 6, scrollback: 100 });
  model.write('shell line\r\n');
  model.write('\x1b[?1049h\x1b[HTUI SCREEN');
  model.resize(50, 8);
  await barrier(model);
  const snap = model.serialize();
  assert.equal(snap.cols, 50);
  assert.equal(snap.rows, 8);
  const restored = freshTerminal(50, 8);
  await writeAsync(restored, snap.ansi);
  assert.equal(restored.buffer.active.type, 'alternate');
  assert.ok(restored.buffer.active.getLine(0).translateToString(true).includes('TUI SCREEN'));
  assert.ok(snap.plain.includes('TUI SCREEN'));
  // Serialization is cached per parse generation.
  assert.equal(model.serialize(), snap);
  model.write('more');
  await barrier(model);
  assert.notEqual(model.serialize(), snap);
  model.dispose();
});
