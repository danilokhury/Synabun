// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: artifact ids in a URL
// ═══════════════════════════════════════════
//
// The library's ids (`skill:<folder>`, `command:<file.md>`, `agent:<file.md>`) travel in URLs as the base64url of
// their UTF-8 bytes; the server decodes them the same way (Buffer.from(id, 'base64url').toString('utf-8')).
// btoa() alone reads a string as Latin-1: a folder named "café" was sent as other bytes than the server reads,
// and "技能" threw. Every id is encoded from its UTF-8 bytes here. No DOM: the page and the tests load it.

/** Bytes as base64, in pieces (one String.fromCharCode call on a large array would overflow). */
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** An id as the server reads it: base64url (no padding) of its UTF-8 bytes. */
export function encodeArtifactId(id) {
  const bytes = new TextEncoder().encode(String(id ?? ''));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The id an encoded one names ('' when it is not base64url of UTF-8 text). */
export function decodeArtifactId(encoded) {
  try {
    const text = String(encoded ?? '');
    if (!/^[A-Za-z0-9_-]*$/.test(text)) return '';
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(padded);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ''; }
}
