import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeQr, renderQrSvg } from '../lib/whatsapp/qr-svg.js';
import { qrcodegen } from '../lib/whatsapp/vendor/qrcodegen.js';

const LINK_REF = '2@Xj8pQm3TzL0v4nKc9YhB1wR7sA6dF5gE2hJ0kM4nP8qS3tU6vW9xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4z,5aB6cD7eF8gH9iJ0kL1mN2oP3qR4sT5uV6wX7yZ8=,Q2hIeW9uZUluZmluaXR5,ZmFrZQ==';

/** Rebuild the module grid from the path: every "Mx,yhNv1h-Nz" run marks N dark modules. */
function gridFromSvg(svg, border) {
  const d = /<path d="([^"]*)"/.exec(svg)[1];
  const dark = new Set();
  for (const m of d.matchAll(/M(\d+),(\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, run, back] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    assert.equal(run, back, 'each run closes on itself');
    for (let i = 0; i < run; i++) dark.add(`${x - border + i},${y - border}`);
  }
  assert.equal(d.replace(/M\d+,\d+h\d+v1h-\d+z/g, ''), '', 'the path holds nothing but runs');
  return dark;
}

test('one black <path> on a white square, crisp edges, viewBox = size + 2 * border', () => {
  const svg = renderQrSvg(LINK_REF);
  const { size } = encodeQr(LINK_REF);
  const dim = size + 8;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.equal((svg.match(/<path\b/g) || []).length, 1);
  assert.match(svg, new RegExp(`viewBox="0 0 ${dim} ${dim}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /role="img" aria-label="QR code"/);
  assert.match(svg, new RegExp(`<rect width="${dim}" height="${dim}" fill="#FFFFFF"/>`));
  assert.match(svg, /<path d="M[^"]+" fill="#000000"\/>/);
  assert.equal(svg, renderQrSvg(LINK_REF), 'deterministic');
});

test('the path draws exactly the dark modules of the code', () => {
  for (const [text, ecc, border] of [[LINK_REF, 'M', 4], ['https://wa.me/15550001111?text=SB-123456', 'Q', 2], ['x', 'L', 0], ['Olá, 世界 😀', 'H', 1]]) {
    const svg = renderQrSvg(text, { ecc, border });
    const got = gridFromSvg(svg, border);
    const qr = qrcodegen.QrCode.encodeText(text, { L: qrcodegen.QrCode.Ecc.LOW, M: qrcodegen.QrCode.Ecc.MEDIUM, Q: qrcodegen.QrCode.Ecc.QUARTILE, H: qrcodegen.QrCode.Ecc.HIGH }[ecc]);
    const want = new Set();
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) want.add(`${x},${y}`);
    assert.deepEqual([...got].sort(), [...want].sort(), `${ecc}/${border}`);
    assert.match(svg, new RegExp(`viewBox="0 0 ${qr.size + 2 * border} ${qr.size + 2 * border}"`));
  }
});

test('finder patterns sit in three corners (a scannable layout)', () => {
  const { size, dark } = encodeQr('https://example.com');
  const finderAt = (ox, oy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(dark(ox + x, oy + y), ring !== 2, `finder module ${ox + x},${oy + y}`);
      }
    }
  };
  finderAt(0, 0);
  finderAt(size - 7, 0);
  finderAt(0, size - 7);
});

test('the encoded text never reaches the markup, and the label is escaped', () => {
  const hostile = '"><script>alert(1)</script><a href="javascript:x">';
  const svg = renderQrSvg(hostile, { label: 'Scan "me" <now> & go' });
  assert.equal(svg.includes('<script'), false);
  assert.equal(svg.includes('javascript:'), false);
  assert.equal(svg.includes(hostile), false);
  assert.match(svg, /aria-label="Scan &quot;me&quot; &lt;now&gt; &amp; go"/);
  const secret = 'SB-482913';
  assert.equal(renderQrSvg(`https://wa.me/15550001111?text=${secret}`).includes(secret), false);
  // Only the tags we emit.
  assert.deepEqual([...svg.matchAll(/<(\w+)/g)].map((m) => m[1]), ['svg', 'rect', 'path']);
});

test('bad input is refused; a bad border falls back to 4', () => {
  assert.throws(() => renderQrSvg(''), TypeError);
  assert.throws(() => renderQrSvg(null), TypeError);
  assert.throws(() => renderQrSvg('x', { ecc: 'Z' }), RangeError);
  assert.throws(() => renderQrSvg('9'.repeat(8000)), RangeError, 'data too long');
  const { size } = encodeQr('abc');
  assert.match(renderQrSvg('abc', { border: -1 }), new RegExp(`viewBox="0 0 ${size + 8} ${size + 8}"`));
  assert.match(renderQrSvg('abc', { border: 0 }), new RegExp(`viewBox="0 0 ${size} ${size}"`));
});

test('the vendored generator keeps its MIT header and provenance', () => {
  const source = readFileSync(new URL('../lib/whatsapp/vendor/qrcodegen.js', import.meta.url), 'utf8');
  assert.match(source, /^\/\* \n \* QR Code generator library \(TypeScript\)\n \* \n \* Copyright \(c\) Project Nayuki\. \(MIT License\)/);
  assert.match(source, /Permission is hereby granted, free of charge/);
  assert.match(source, /commit 8329a7108fc22be3e1eec0a9f9318978579e3621/);
  assert.match(source, /export \{ qrcodegen \};/);
});
