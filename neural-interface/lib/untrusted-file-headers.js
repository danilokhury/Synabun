// The headers of a file a user uploaded or an agent made, served back to the page: a pasted or generated image, a
// category logo, a custom file icon, a Skills Studio icon, a Style Guide logo, an Assistant run's media. An <img> or
// <video> in the app shows it as before (it ignores all three); opened by its address it runs nothing. An SVG is a
// document that can carry script, so it also comes as a download there. tests/untrusted-file-headers.test.mjs.
import { basename } from 'node:path';

/** No script, no request, no plugin, no form; a unique origin (sandbox). Inline styles stay, so an SVG still draws. */
export const UNTRUSTED_FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Is this file an SVG, by its name or by the type it is sent as? */
export function isSvgFile(name, type = '') {
  return /\.svg$/i.test(String(name || '')) || /^image\/svg\+xml\b/i.test(String(type || ''));
}

/**
 * Set the three headers on `res` (an Express response) for the file `name` (a path or a file name) sent as `type`.
 * Call it before the body goes out; it does not touch Content-Type.
 */
export function setUntrustedFileHeaders(res, name, type = '') {
  res.setHeader('Content-Security-Policy', UNTRUSTED_FILE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (isSvgFile(name, type)) {
    const file = basename(String(name || '')) || 'image.svg';
    const ascii = file.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.setHeader('Content-Disposition', ascii === file ? `attachment; filename="${file}"` : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  }
}
