// QR codes for the WhatsApp settings tab: the link QR (Baileys' pairing ref)
// and the claim card's wa.me QR, drawn server-side with Project Nayuki's
// generator (vendor/qrcodegen.js, MIT) so no QR library ever ships to the page.
//
// Output is one self-contained SVG: a white background and ONE <path> with
// every dark module, black, shape-rendering="crispEdges" so it stays sharp
// at any size (the tab shows it at >= 240 px through an <img> data URI). The
// encoded text never reaches an attribute or the markup: only the module grid
// does, and the accessible name is a fixed label.

import { qrcodegen } from './vendor/qrcodegen.js';

const ECC = Object.freeze({
  L: qrcodegen.QrCode.Ecc.LOW,
  M: qrcodegen.QrCode.Ecc.MEDIUM,
  Q: qrcodegen.QrCode.Ecc.QUARTILE,
  H: qrcodegen.QrCode.Ecc.HIGH,
});

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

/** The module grid for `text`: { size, dark(x, y) }. Throws RangeError when the text is too long for a QR code. */
export function encodeQr(text, { ecc = 'M' } = {}) {
  if (typeof text !== 'string' || !text) throw new TypeError('encodeQr: text must be a non-empty string');
  const level = ECC[String(ecc).toUpperCase()];
  if (!level) throw new RangeError(`encodeQr: ecc must be one of ${Object.keys(ECC).join(', ')}`);
  const qr = qrcodegen.QrCode.encodeText(text, level);
  return { size: qr.size, version: qr.version, dark: (x, y) => qr.getModule(x, y) };
}

/**
 * @param {string} text   what the code encodes (never echoed into the SVG)
 * @param {{ecc?: 'L'|'M'|'Q'|'H', border?: number, label?: string}} [opts]
 *   border: quiet zone in modules (0-16, default 4 — the spec's minimum)
 * @returns {string} `<svg …>` markup
 */
export function renderQrSvg(text, { ecc = 'M', border = 4, label = 'QR code' } = {}) {
  const b = Number.isInteger(border) && border >= 0 && border <= 16 ? border : 4;
  const { size, dark } = encodeQr(text, { ecc });
  const dim = size + b * 2;
  // One subpath per horizontal run of dark modules keeps the path short.
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!dark(x, y)) continue;
      let run = 1;
      while (x + run < size && dark(x + run, y)) run++;
      d += `M${x + b},${y + b}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const name = escapeAttr(String(label || 'QR code').slice(0, 80));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${name}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="#FFFFFF"/>`
    + `<path d="${d}" fill="#000000"/>`
    + '</svg>';
}
