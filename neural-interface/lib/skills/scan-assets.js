import { inflateSync, brotliDecompressSync } from 'node:zlib';

export const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const MAX = 16 * 1024 * 1024;
export const ASSET_LIMITS = Object.freeze({ assetInflated: 8 * 1024 * 1024, scanInflated: 32 * 1024 * 1024, ratio: 100, ratioSlack: 64 * 1024 });
export const assetBudget = () => ({ inflated: 0, exhausted: false });
export const scriptMarkers = (s) => /(?:^|\n)[\t ]*#!|<\?php\b|<\?=|<%|<script\b/i.test(s);
// Long, language-specific markers are evidence even among non-printable bytes.
// Short markers stay restricted to printable/decoded text to avoid random pixel/glyph hits.
const rawMarkers = (s) => /<\?php\b|<script\b/i.test(s);
const printableLines = (s) => s.matchAll(/(?:^|\n)([\t\x20-\x7e]{4,})(?=\r?\n|$)/g);
const crc32 = (b) => { let crc = -1; for (const x of b) { crc ^= x; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; };

// Validate framing, offsets and the exact end, without rendering or executing the asset.
// Bounded decompression is only for metadata/font tables, never archive extraction.
export function inspectAsset(path, b, suspicious, { budget = assetBudget(), local = { inflated: 0 }, heuristic = () => {} } = {}) {
  let script = false;
  const raw = (data) => {
    const text = data.toString('latin1');
    if (rawMarkers(text)) script = true;
    // Random printable substrings of compressed pixels/glyphs are not commands.
    for (const [, line] of printableLines(text)) { const hit = suspicious(line); if (scriptMarkers(line) || hit === 'strong') script = true; else if (hit) heuristic(line); }
  };
  const text = (data, encoding = 'utf8') => {
    const value = typeof data === 'string' ? data : encoding === 'utf8' ? new TextDecoder('utf8', { fatal: true }).decode(data) : data.toString(encoding);
    if (scriptMarkers(value)) script = true;
    let start = 0;
    while (start < value.length && !script) {
      const newline = value.indexOf('\n', start), end = newline < 0 ? value.length : newline;
      const line = value.slice(start, end), hit = suspicious(line);
      if (hit === 'strong') script = true;
      else if (hit) heuristic(line);
      start = end + 1;
    }
  };
  const range = (at, n) => Number.isSafeInteger(at) && Number.isSafeInteger(n) && at >= 0 && n >= 0 && at + n <= b.length;
  const ascii = (at, n) => b.subarray(at, at + n).toString('latin1');
  const unpack = (data, brotli, visit, expected) => {
    const cap = Math.min(ASSET_LIMITS.assetInflated - local.inflated, ASSET_LIMITS.scanInflated - budget.inflated, data.length * ASSET_LIMITS.ratio + ASSET_LIMITS.ratioSlack);
    const exceeded = () => { budget.exhausted = true; return Object.assign(new Error('asset-decompression-budget'), { budget: true }); };
    if (budget.exhausted || cap <= 0 || expected > cap) throw exceeded();
    let out;
    try {
      const decoded = (brotli ? brotliDecompressSync : inflateSync)(data, { maxOutputLength: cap, info: true });
      if (decoded.engine.bytesWritten !== data.length) throw new Error('trailing compressed bytes');
      out = decoded.buffer;
    }
    catch (err) { if (err.code === 'ERR_BUFFER_TOO_LARGE') throw exceeded(); throw err; }
    local.inflated += out.length; budget.inflated += out.length;
    if (expected != null && out.length !== expected) throw new Error('invalid inflated length');
    visit(out); // Scan now; never retain decompressed outputs across chunks/tables/assets.
  };
  const fontTable = (tag, data) => {
    raw(data);
    if (tag !== 'name') {
      // A table made entirely of text is decoded metadata, not a random glyph byte run.
      if (/^[\t\r\n\x20-\x7e]+$/.test(data.toString('latin1'))) text(data, 'latin1');
      return;
    }
    if (data.length < 6) throw new Error('invalid name table');
    const count = data.readUInt16BE(2), start = data.readUInt16BE(4);
    if (6 + count * 12 > data.length || start > data.length) throw new Error('invalid names');
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 12, platform = data.readUInt16BE(at), length = data.readUInt16BE(at + 8), offset = start + data.readUInt16BE(at + 10);
      if (offset + length > data.length) throw new Error('invalid name');
      const value = data.subarray(offset, offset + length);
      if (platform === 0 || platform === 3) { if (length % 2) throw new Error('invalid unicode name'); text(Buffer.from(value).swap16(), 'utf16le'); }
      else text(value, 'latin1');
    }
  };
  function png() {
    if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
    let at = 8, image = false, header = false;
    while (range(at, 12)) {
      const n = b.readUInt32BE(at), tag = ascii(at + 4, 4);
      if (!range(at, n + 12) || !/^[A-Za-z]{4}$/.test(tag) || crc32(b.subarray(at + 4, at + 8 + n)) !== b.readUInt32BE(at + 8 + n)) return false;
      if (!header && (tag !== 'IHDR' || n !== 13 || !b.readUInt32BE(at + 8) || !b.readUInt32BE(at + 12))) return false;
      if (header && tag === 'IHDR') return false;
      header = true;
      const data = b.subarray(at + 8, at + 8 + n);
      if (tag === 'IDAT') image = true;
      if (tag === 'tEXt') { const zero = data.indexOf(0); if (zero < 1) return false; text(data.subarray(zero + 1), 'latin1'); }
      if (tag === 'zTXt' || tag === 'iCCP') { const zero = data.indexOf(0); if (zero < 1 || data[zero + 1] !== 0) return false; unpack(data.subarray(zero + 2), false, tag === 'zTXt' ? (out) => text(out, 'latin1') : raw); }
      if (tag === 'iTXt') {
        const zero = data.indexOf(0); if (zero < 1 || ![0, 1].includes(data[zero + 1]) || data[zero + 2] !== 0) return false;
        const lang = data.indexOf(0, zero + 3), translated = data.indexOf(0, lang + 1);
        if (lang < 0 || translated < 0) return false;
        if (data[zero + 1]) unpack(data.subarray(translated + 1), false, text);
        else text(data.subarray(translated + 1));
      }
      at += n + 12;
      if (tag === 'IEND') return n === 0 && image && at === b.length;
    }
    return false;
  }
  function jpeg() {
    if (b[0] !== 255 || b[1] !== 216) return false;
    let at = 2, frame = false, scan = false;
    while (at < b.length) {
      if (b[at++] !== 255) return false;
      while (b[at] === 255) at++;
      const marker = b[at++];
      if (marker === 0xd9) return frame && scan && at === b.length;
      if (!range(at, 2) || marker === 0 || marker === 0xd8) return false;
      const n = b.readUInt16BE(at); if (n < 2 || !range(at, n)) return false;
      if (marker === 0xfe) text(b.subarray(at + 2, at + n), 'latin1');
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) frame = true;
      at += n;
      if (marker === 0xda) {
        scan = true;
        while (at < b.length) {
          if (b[at] !== 255) { at++; continue; }
          if (b[at + 1] === 0 || b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7) { at += 2; continue; }
          break;
        }
      }
    }
    return false;
  }
  function gif() {
    if (!['GIF87a', 'GIF89a'].includes(ascii(0, 6)) || !range(0, 13) || !b.readUInt16LE(6) || !b.readUInt16LE(8)) return false;
    let at = 13 + (b[10] & 128 ? 3 * 2 ** ((b[10] & 7) + 1) : 0), image = false;
    const blocks = (comment = false) => { const parts = []; while (range(at, 1)) { const n = b[at++]; if (!n) { if (comment) text(Buffer.concat(parts), 'latin1'); return true; } if (!range(at, n)) return false; if (comment) parts.push(b.subarray(at, at + n)); at += n; } return false; };
    while (range(at, 1)) {
      const tag = b[at++];
      if (tag === 0x3b) return image && at === b.length;
      if (tag === 0x21) { if (!range(at, 1) || !blocks(b[at++] === 0xfe)) return false; }
      else if (tag === 0x2c) {
        if (!range(at, 9)) return false;
        const flags = b[at + 8]; at += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
        if (!range(at, 1) || b[at] < 2 || b[at++] > 8 || !blocks()) return false;
        image = true;
      } else return false;
    }
    return false;
  }
  function webp() {
    if (!range(0, 12) || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) return false;
    let at = 12, image = false;
    while (range(at, 8)) {
      const tag = ascii(at, 4), n = b.readUInt32LE(at + 4);
      if (!range(at + 8, n + (n & 1))) return false;
      if (['VP8 ', 'VP8L', 'ANMF'].includes(tag)) image = true;
      at += 8 + n + (n & 1);
    }
    return image && at === b.length;
  }
  function ico() {
    if (!range(0, 6) || b.readUInt32LE(0) !== 0x10000) return false;
    const count = b.readUInt16LE(4); if (!count || !range(6, count * 16)) return false;
    let end = 6 + count * 16;
    for (let i = 0; i < count; i++) {
      const n = b.readUInt32LE(6 + i * 16 + 8), at = b.readUInt32LE(6 + i * 16 + 12);
      if (at !== end || !range(at, n) || n < 8) return false;
      const image = b.subarray(at, at + n);
      if (image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') { const reason = inspectAsset('icon.png', image, suspicious, { budget, local, heuristic }); if (reason) throw Object.assign(new Error(reason), { reason }); }
      else {
        if (n < 40 || image.readUInt32LE(0) !== 40 || image.readUInt32LE(16) !== 0) return false;
        const w = image.readInt32LE(4), h = Math.abs(image.readInt32LE(8)) / 2, depth = image.readUInt16LE(14);
        if (w <= 0 || !Number.isInteger(h) || !h || ![1, 4, 8, 16, 24, 32].includes(depth)) return false;
        const colors = image.readUInt32LE(32) || (depth <= 8 ? 2 ** depth : 0);
        if (40 + colors * 4 + (Math.ceil(w * depth / 32) * 4 + Math.ceil(w / 32) * 4) * h !== n) return false;
      }
      end = at + n;
    }
    return end === b.length;
  }
  function font() {
    const tag = ascii(0, 4), woff = /\.woff$/i.test(path), woff2 = /\.woff2$/i.test(path);
    if (woff || woff2) {
      if (tag !== (woff2 ? 'wOF2' : 'wOFF') || !range(0, woff2 ? 48 : 44) || b.readUInt32BE(8) !== b.length || !b.readUInt16BE(12) || b.readUInt16BE(14)) return false;
      const metaAt = b.readUInt32BE(woff2 ? 28 : 24), metaSize = b.readUInt32BE(woff2 ? 32 : 28);
      const metaOriginal = b.readUInt32BE(woff2 ? 36 : 32);
      const privateAt = b.readUInt32BE(woff2 ? 40 : 36), privateSize = b.readUInt32BE(woff2 ? 44 : 40);
      if (!range(metaAt, metaSize) || !range(privateAt, privateSize) || (!metaSize && (metaAt || metaOriginal)) || (!privateSize && privateAt)) return false;
      const count = b.readUInt16BE(12), blocks = [];
      let directoryEnd;
      if (woff2) {
        const tags = 'cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill'.split(' ').map((s) => s.replace('_', ' '));
        let pos = 48, total = 0;
        const byte = () => { if (!range(pos, 1)) throw new Error('short directory'); return b[pos++]; };
        const u32 = () => { if (!range(pos, 4)) throw new Error('short directory'); const n = b.readUInt32BE(pos); pos += 4; return n; };
        const base128 = () => {
          let n = 0;
          for (let i = 0; i < 5; i++) { const v = byte(); if ((!i && v === 128) || n > 0x1ffffff) throw new Error('invalid base128'); n = n * 128 + (v & 127); if (!(v & 128)) return n; }
          throw new Error('invalid base128');
        };
        const u255 = () => { const v = byte(); return v === 253 ? byte() * 256 + byte() : v === 254 ? byte() + 506 : v === 255 ? byte() + 253 : v; };
        const tables = [];
        for (let i = 0; i < count; i++) {
          const flags = byte(), tag = (flags & 63) === 63 ? String.fromCharCode(byte(), byte(), byte(), byte()) : tags[flags & 63];
          const version = flags >>> 6, original = base128(), transformed = ['glyf', 'loca'].includes(tag) ? version !== 3 : version !== 0;
          if (['glyf', 'loca'].includes(tag) ? ![0, 3].includes(version) : version && !(tag === 'hmtx' && version === 1)) return false;
          const size = transformed ? base128() : original;
          if (tag === 'loca' && transformed && size !== 0) return false;
          tables.push({ tag, offset: total, size, transformed }); total += size;
        }
        if (ascii(4, 4) === 'ttcf') {
          if (![0x10000, 0x20000].includes(u32())) return false;
          const fonts = u255(); if (!fonts || fonts > b.length) return false;
          for (let i = 0; i < fonts; i++) {
            const n = u255(), flavor = u32(), used = new Set(), names = new Set();
            if (!n || n > count || ![0x10000, 0x4f54544f].includes(flavor)) return false;
            for (let j = 0; j < n; j++) { const index = u255(); if (index >= count || used.has(index) || names.has(tables[index].tag)) return false; used.add(index); names.add(tables[index].tag); }
            if (names.has('glyf') !== names.has('loca')) return false;
          }
        } else if (new Set(tables.map((t) => t.tag)).size !== count) return false;
        directoryEnd = pos;
        const size = b.readUInt32BE(20); if (!size || !range(pos, size)) return false;
        blocks.push({ offset: pos, size, visit: () => unpack(b.subarray(pos, pos + size), true, (out) => {
          for (const t of tables) fontTable(t.tag, out.subarray(t.offset, t.offset + t.size));
        }, total) });
      } else {
        directoryEnd = 44 + count * 20; if (!range(44, count * 20)) return false;
        for (let i = 0; i < count; i++) {
          const at = 44 + i * 20, offset = b.readUInt32BE(at + 4), size = b.readUInt32BE(at + 8), original = b.readUInt32BE(at + 12), tableTag = ascii(at, 4);
          if (!range(offset, size) || size > original || offset % 4) return false;
          blocks.push({ offset, size, visit: () => size < original ? unpack(b.subarray(offset, offset + size), false, (out) => fontTable(tableTag, out), original) : fontTable(tableTag, b.subarray(offset, offset + size)) });
        }
      }
      blocks.sort((a, b) => a.offset - b.offset);
      if (metaSize) blocks.push({ offset: metaAt, size: metaSize, visit: () => unpack(b.subarray(metaAt, metaAt + metaSize), woff2, text, metaOriginal) });
      if (privateSize) blocks.push({ offset: privateAt, size: privateSize, visit: () => raw(b.subarray(privateAt, privateAt + privateSize)) });
      let end = directoryEnd;
      for (const block of blocks) {
        if (block.offset !== end && block.offset !== Math.ceil(end / 4) * 4 || block.offset < end || !b.subarray(end, block.offset).every((v) => v === 0)) return false;
        end = block.offset + block.size;
      }
      if (end !== b.length && !(Math.ceil(end / 4) * 4 === b.length && b.subarray(end).every((v) => v === 0))) return false;
      for (const block of blocks) block.visit();
      return true;
    }
    if (!range(0, 12) || (/\.ttf$/i.test(path) ? b.readUInt32BE(0) !== 0x10000 : tag !== 'OTTO')) return false;
    const count = b.readUInt16BE(4); if (!count || !range(12, count * 16)) return false;
    let end = 12 + count * 16;
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16, offset = b.readUInt32BE(at + 8), size = b.readUInt32BE(at + 12);
      if (offset < 12 + count * 16 || !range(offset, size)) return false;
      fontTable(ascii(at, 4), b.subarray(offset, offset + size));
      end = Math.max(end, offset + size);
    }
    return end === b.length || Math.ceil(end / 4) * 4 === b.length && b.subarray(end).every((x) => x === 0);
  }
  try {
    if (b.length > MAX) return 'asset-too-large';
    const valid = /\.png$/i.test(path) ? png() : /\.jpe?g$/i.test(path) ? jpeg() : /\.gif$/i.test(path) ? gif() : /\.webp$/i.test(path) ? webp() : /\.ico$/i.test(path) ? ico() : font();
    if (!valid) return 'asset-invalid-structure';
    raw(b);
    if (script) return 'asset-script-content';
    return null;
  } catch (err) { return err.reason || (err.budget ? 'asset-decompression-budget' : 'asset-invalid-structure'); }
}
