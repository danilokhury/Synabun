// Style Guide color math (lib/style-guide/color.js): parsing, sRGB ↔ OKLCH, the 11-step scale,
// WCAG and APCA contrast, harmony and the dark-theme derivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE_STEPS, apcaContrast, contrastReport, deriveDarkSemantic, harmony, hexToOklch, isColor, oklchToHex,
  parseColor, relativeLuminance, scaleFromBase, toHex, wcagContrast,
} from '../lib/style-guide/color.js';

test('toHex reads hex, rgb, hsl, oklch, names and the bare HSL triple; anything else is null', () => {
  assert.equal(toHex('#3B82F6'), '#3b82f6');
  assert.equal(toHex('#3bf'), '#33bbff');
  assert.equal(toHex('rgb(59, 130, 246)'), '#3b82f6');
  assert.equal(toHex('rgb(59 130 246 / 50%)'), '#3b82f680');
  assert.equal(toHex('rgba(0,0,0,.06)'), '#0000000f');
  assert.equal(toHex('hsl(0, 100%, 50%)'), '#ff0000');
  assert.equal(toHex('hsl(120deg 100% 25%)'), '#008000');
  assert.equal(toHex('oklch(1 0 0)'), '#ffffff');
  assert.equal(toHex('oklch(0% 0 0)'), '#000000');
  assert.equal(toHex('white'), '#ffffff');
  assert.equal(toHex('0 0% 100%'), '#ffffff', 'the shadcn custom-property form');
  for (const bad of ['', 'banana', '#12', '#gggggg', 'rgb(1,2)', 'var(--x)', null, undefined, '{primary.500}']) assert.equal(toHex(bad), null, String(bad));
  assert.equal(isColor('#fff'), true);
  assert.equal(isColor('nope'), false);
  assert.deepEqual(parseColor('#ff000080'), { r: 255, g: 0, b: 0, a: 0.502 });
});

test('hue units convert to degrees in both HSL and OKLCH', () => {
  assert.equal(toHex('hsl(120grad 50% 50%)'), '#59bf40');
  assert.equal(toHex('hsl(100grad 100% 50%)'), '#80ff00');
  assert.equal(toHex('oklch(0.6 0.1 0.5turn)'), oklchToHex({ l: 0.6, c: 0.1, h: 180 }));
  for (const [angle, degrees] of [['108', 108], ['108deg', 108], ['120grad', 108], [`${Math.PI}rad`, 180], ['0.5turn', 180], ['-100grad', 270], ['1.5turn', 180]]) {
    assert.equal(toHex(`hsl(${angle} 50% 50%)`), toHex(`hsl(${degrees} 50% 50%)`), angle);
    assert.equal(toHex(`oklch(0.6 0.1 ${angle})`), oklchToHex({ l: 0.6, c: 0.1, h: degrees }), angle);
  }
});

test('malformed components, alpha, arity and RGB objects are unparseable', () => {
  for (const input of [
    'hsl(abc 50% 50%)', 'oklch(0.6)', 'rgb(1 2)', '', 'rgb(12oops 2 3)',
    'oklch(0.6 nope 180)', 'oklch(0.6 0.1 180oops)', 'hsl(120 50oops 50%)',
    'hsl(120foo 50% 50%)', 'hsl(120% 50% 50%)', 'rgb(1deg 2 3)', 'rgb(1 2 3 / nope)',
    'rgb(1 2 3 /)', 'rgb(1,,2,3)', 'rgb(1 2 3 4 5)', 'rgb(1 2 3 / .5 / .6)',
    'rgb(1e999 2 3)', 'hsl(1e308turn 50% 50%)', '1..2 50% 50%', '0 1..2% 50%',
    '0 50% 50% / 1..2', { r: 12 }, { r: 1, g: 2, b: NaN }, { r: 1, g: 2, b: 3, a: 'bad' }, Object.create(null),
  ]) {
    assert.equal(parseColor(input), null);
    assert.equal(toHex(input), null);
    assert.equal(isColor(input), false);
  }
  assert.equal(toHex('rgb(1e2 +2 .3 / 5e1%)'), '#64020080');
  assert.deepEqual(parseColor({ r: 12, g: 2, b: 3 }), { r: 12, g: 2, b: 3, a: 1 });
});

test('sRGB → OKLCH → sRGB is the identity on every color tried, and the known anchors hold', () => {
  for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#3b82f6', '#8b5cf6', '#eab308', '#64748b', '#0f172a', '#fbf7f1', '#b4532a', '#123456']) {
    assert.equal(oklchToHex(hexToOklch(hex)), hex, hex);
  }
  const white = hexToOklch('#ffffff');
  const black = hexToOklch('#000000');
  assert.ok(Math.abs(white.l - 1) < 1e-4 && white.c < 1e-4);
  assert.ok(black.l < 1e-6 && black.c < 1e-6);
  const red = hexToOklch('#ff0000');
  assert.ok(Math.abs(red.l - 0.628) < 0.002 && Math.abs(red.c - 0.2577) < 0.002 && Math.abs(red.h - 29.23) < 0.2, JSON.stringify(red));
  // Out of gamut: chroma is given up, never the lightness.
  const clipped = hexToOklch(oklchToHex({ l: 0.7, c: 0.5, h: 150 }));
  assert.ok(Math.abs(clipped.l - 0.7) < 0.01 && clipped.c < 0.5);
});

test('scaleFromBase: 11 steps, the base at 500 byte for byte, lightness falling from 50 to 950', () => {
  for (const base of ['#3b82f6', '#8b5cf6', '#eab308', '#64748b', '#0f172a', '#ff0000', '#22d3ee', '#b4532a', '#0a7c66', '#fde047']) {
    const scale = scaleFromBase(base);
    assert.deepEqual(Object.keys(scale), [...PALETTE_STEPS], base);
    assert.equal(scale['500'], base, base);
    for (const hex of Object.values(scale)) assert.match(hex, /^#[0-9a-f]{6}$/, base);
    const lightness = PALETTE_STEPS.map((step) => hexToOklch(scale[step]).l);
    for (let i = 1; i < lightness.length; i++) assert.ok(lightness[i] < lightness[i - 1], `${base}: step ${PALETTE_STEPS[i]} (${lightness[i]}) is not darker than ${PALETTE_STEPS[i - 1]} (${lightness[i - 1]})`);
  }
  // The extremes cannot be strictly monotonic, but never go the wrong way.
  for (const base of ['#ffffff', '#000000']) {
    const lightness = PALETTE_STEPS.map((step) => hexToOklch(scaleFromBase(base)[step]).l);
    for (let i = 1; i < lightness.length; i++) assert.ok(lightness[i] <= lightness[i - 1] + 1e-9, base);
  }
  assert.equal(scaleFromBase('rgb(59 130 246)')['500'], '#3b82f6', 'any CSS color is a base');
  assert.equal(scaleFromBase('nope'), null);
  assert.deepEqual(scaleFromBase('#3b82f6'), scaleFromBase('#3b82f6'), 'deterministic');
});

test('scaleFromBase: hueShift moves the ends apart and chroma scales the saturation, the base untouched', () => {
  const plain = scaleFromBase('#3b82f6');
  const shifted = scaleFromBase('#3b82f6', { hueShift: 30 });
  const muted = scaleFromBase('#3b82f6', { chroma: 0.3 });
  assert.equal(shifted['500'], '#3b82f6');
  assert.equal(muted['500'], '#3b82f6');
  assert.notEqual(shifted['100'], plain['100']);
  assert.ok(hexToOklch(shifted['900']).h > hexToOklch(plain['900']).h, 'the dark end drifts with the shift');
  assert.ok(hexToOklch(shifted['100']).h < hexToOklch(plain['100']).h, 'the light end drifts against it');
  for (const step of ['200', '700']) assert.ok(hexToOklch(muted[step]).c < hexToOklch(plain[step]).c, step);
});

test('WCAG contrast: black on white is 21:1, the known pairs and the thresholds', () => {
  assert.equal(wcagContrast('#000000', '#ffffff'), 21);
  assert.equal(wcagContrast('#ffffff', '#000000'), 21, 'the ratio has no direction');
  assert.equal(wcagContrast('#ffffff', '#ffffff'), 1);
  assert.ok(Math.abs(wcagContrast('#777777', '#ffffff') - 4.478) < 0.01);
  assert.ok(Math.abs(wcagContrast('#767676', '#ffffff') - 4.54) < 0.01, 'the classic AA gray');
  assert.equal(wcagContrast('nope', '#fff'), null);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.deepEqual(contrastReport('#000', '#fff'), { ratio: 21, aa: true, aaa: true, aaLarge: true, aaaLarge: true, apca: 106 });
  assert.deepEqual(contrastReport('#777777', '#ffffff'), { ratio: 4.48, aa: false, aaa: false, aaLarge: true, aaaLarge: false, apca: 71.1 });
  assert.deepEqual(contrastReport('#777777', '#ffffff', { size: 'large' }), { ratio: 4.48, aa: true, aaa: false, aaLarge: true, aaaLarge: false, apca: 71.1 });
  assert.equal(contrastReport('x', '#fff'), null);
  // A translucent foreground is measured as painted.
  assert.ok(wcagContrast('rgba(0,0,0,.5)', '#ffffff') < 21);
});

test('APCA: positive for dark text on light, negative for light on dark, the reference values, zero in the noise', () => {
  assert.ok(Math.abs(apcaContrast('#000000', '#ffffff') - 106.04) < 0.05);
  assert.ok(Math.abs(apcaContrast('#ffffff', '#000000') - -107.88) < 0.05);
  assert.ok(apcaContrast('#1b232e', '#ffffff') > 0);
  assert.ok(apcaContrast('#f0f3f7', '#0e141c') < 0);
  assert.equal(apcaContrast('#ffffff', '#ffffff'), 0);
  assert.equal(apcaContrast('#fefefe', '#ffffff'), 0, 'below the clip');
  assert.equal(apcaContrast('nope', '#fff'), null);
});

test('harmony: complementary, analogous, triadic and split-complementary hexes around the base', () => {
  const h = harmony('#3b82f6');
  assert.deepEqual(Object.keys(h), ['complementary', 'analogous', 'triadic', 'splitComplementary']);
  assert.deepEqual([h.complementary.length, h.analogous.length, h.triadic.length, h.splitComplementary.length], [1, 2, 2, 2]);
  for (const hex of Object.values(h).flat()) assert.match(hex, /^#[0-9a-f]{6}$/);
  const base = hexToOklch('#3b82f6');
  const turn = (hex) => (hexToOklch(hex).h - base.h + 360) % 360;
  assert.ok(Math.abs(turn(h.complementary[0]) - 180) < 3);
  assert.ok(Math.abs(turn(h.triadic[0]) - 120) < 3 && Math.abs(turn(h.triadic[1]) - 240) < 3);
  assert.equal(harmony('nope'), null);
});

test('deriveDarkSemantic: neutral steps mirror, brand steps go lighter, white becomes the darkest neutral', () => {
  const dark = deriveDarkSemantic({ background: '#ffffff', surface: '{neutral.50}', text: '{neutral.900}', border: '{neutral.200}', primary: '{primary.500}', onPrimary: '#ffffff', link: '{primary.600}', cream: '#fbf7f1', ink: '#0b0b0c', butter: '#fde68a', other: '{status.danger}' });
  assert.deepEqual(dark, { background: '{neutral.950}', surface: '{neutral.950}', text: '{neutral.100}', border: '{neutral.800}', primary: '{primary.400}', onPrimary: '{neutral.950}', link: '{primary.300}', cream: '{neutral.950}', ink: '{neutral.50}', butter: dark.butter, other: '{status.danger}' });
  assert.match(dark.butter, /^#[0-9a-f]{6}$/);
  assert.ok(hexToOklch(dark.butter).l < 0.25 && hexToOklch(dark.butter).l < hexToOklch('#fde68a').l, 'a literal color has its lightness inverted');
  assert.deepEqual(deriveDarkSemantic({ surface: '{gray.100}' }, { neutral: 'gray' }), { surface: '{gray.900}' });
});
