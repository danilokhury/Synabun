// ═══════════════════════════════════════════
// SynaBun — bzip2, read
// ═══════════════════════════════════════════
//
// Git for Windows publishes its full installation as a .tar.bz2, and Node has
// no bzip2. A Windows 10 tar.exe may not have one either (older builds stop at
// "unable to run program bzip2 -d"), so SynaBun reads the file itself, the same
// way on the build machine and on the user's: this decoder, then the tar
// reader in install.js.
//
// The whole format of bzip2 1.0 (Julian Seward's): one stream or several
// concatenated, each "BZh1".."BZh9", blocks of Huffman-coded move-to-front
// values with their runs, the inverse Burrows-Wheeler transform, the final run
// decoding. Every block's CRC is compared with the one it carries, and every
// stream's combined CRC with its trailer: a block that decodes to anything else
// than what was compressed stops the read. A "randomised" block (written only
// by bzip2 0.9.0, before 1998) is refused rather than guessed at.
//
// What it hands out is the decompressed bytes, block by block
// (bunzip2Blocks: a generator, so a caller can stop at any block, and see how
// far into the file it got). Every problem is a Bzip2Error.
//
// No imports: install.js and the extraction worker load it, and so does a
// build, from the application it stages.

export class Bzip2Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'Bzip2Error';
    this.code = 'unpack';
  }
}

const BLOCK_MAGIC_HI = 0x314159;   // π
const BLOCK_MAGIC_LO = 0x265359;
const END_MAGIC_HI = 0x177245;     // √π
const END_MAGIC_LO = 0x385090;
const MAX_GROUPS = 6;
const MAX_ALPHA = 258;
const MAX_CODE_LEN = 20;
const MAX_SELECTORS = 18002;
const RUNA = 0;
const RUNB = 1;
const GROUP_SIZE = 50;

/** CRC-32 as bzip2 has it: polynomial 0x04c11db7, most significant bit first. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** Reads a Buffer bit by bit, most significant bit first. */
class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.pos = 0;      // the next byte to take
    this.bits = 0;     // what is held, in the low `count` bits
    this.count = 0;
  }

  /** `n` bits (1 to 24) as a number. */
  read(n) {
    while (this.count < n) {
      if (this.pos >= this.buffer.length) throw new Bzip2Error('The archive ends inside a compressed block.');
      this.bits = ((this.bits << 8) | this.buffer[this.pos++]) >>> 0;
      this.count += 8;
    }
    this.count -= n;
    const value = (this.bits >>> this.count) & ((1 << n) - 1);
    this.bits &= (1 << this.count) - 1;
    return value;
  }

  bit() {
    if (this.count === 0) {
      if (this.pos >= this.buffer.length) throw new Bzip2Error('The archive ends inside a compressed block.');
      this.bits = this.buffer[this.pos++];
      this.count = 8;
    }
    this.count--;
    const value = (this.bits >>> this.count) & 1;
    this.bits &= (1 << this.count) - 1;
    return value;
  }

  read32() {
    return ((this.read(16) << 16) | this.read(16)) >>> 0;
  }

  /** Drop what is left of the current byte (a stream ends on a byte boundary). */
  align() {
    this.bits = 0;
    this.count = 0;
  }

  get done() {
    return this.count === 0 && this.pos >= this.buffer.length;
  }
}

/** Canonical Huffman decoding tables of one group, as bzip2's hbCreateDecodeTables makes them. */
function decodeTables(lengths, alphaSize) {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] < minLen) minLen = lengths[i];
  }
  const perm = new Int32Array(MAX_ALPHA);
  const base = new Int32Array(MAX_CODE_LEN + 2);
  const limit = new Int32Array(MAX_CODE_LEN + 1).fill(-1);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) for (let j = 0; j < alphaSize; j++) if (lengths[j] === len) perm[pp++] = j;
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len];
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len++) base[len] = ((limit[len - 1] + 1) << 1) - base[len];
  return { minLen, maxLen, perm, base, limit };
}

/** The next symbol of a group's code. */
function nextSymbol(reader, table) {
  let len = table.minLen;
  let code = reader.read(len);
  while (len <= table.maxLen && code > table.limit[len]) {
    len++;
    code = (code << 1) | reader.bit();
  }
  if (len > table.maxLen) throw new Bzip2Error('The archive holds a code its tables do not know.');
  const index = code - table.base[len];
  if (index < 0 || index >= MAX_ALPHA) throw new Bzip2Error('The archive holds a code its tables do not know.');
  return table.perm[index];
}

/**
 * One block, from just after its magic: its bytes (the final run decoding done) and the CRC it carries.
 * `tt` is the block's workspace, as large as the stream's block size.
 */
function decodeBlock(reader, tt, blockSize) {
  const storedCrc = reader.read32();
  if (reader.bit()) throw new Bzip2Error('The archive has a randomised block (bzip2 0.9.0), which this reader does not read.');
  const origPtr = reader.read(24);

  // Which byte values the block uses.
  const used = [];
  const inUse16 = reader.read(16);
  for (let i = 0; i < 16; i++) {
    if (!(inUse16 & (0x8000 >>> i))) continue;
    const bits = reader.read(16);
    for (let j = 0; j < 16; j++) if (bits & (0x8000 >>> j)) used.push(i * 16 + j);
  }
  if (!used.length) throw new Bzip2Error('The archive has a block that uses no byte value.');
  const alphaSize = used.length + 2;
  const eob = used.length + 1;

  // The Huffman groups and which one codes each run of fifty symbols.
  const groups = reader.read(3);
  if (groups < 2 || groups > MAX_GROUPS) throw new Bzip2Error('The archive has a block with an impossible number of code tables.');
  const selectorCount = reader.read(15);
  if (selectorCount < 1) throw new Bzip2Error('The archive has a block without code selectors.');
  const mtfGroups = [0, 1, 2, 3, 4, 5].slice(0, groups);
  const selectors = new Uint8Array(Math.min(selectorCount, MAX_SELECTORS));
  for (let i = 0; i < selectorCount; i++) {
    let j = 0;
    while (reader.bit()) {
      j++;
      if (j >= groups) throw new Bzip2Error('The archive has a block with an impossible code selector.');
    }
    // Selectors past the most a block can use are read and dropped, as bzip2 1.0.8 does.
    if (i >= MAX_SELECTORS) continue;
    const value = mtfGroups[j];
    for (let k = j; k > 0; k--) mtfGroups[k] = mtfGroups[k - 1];
    mtfGroups[0] = value;
    selectors[i] = value;
  }

  const tables = [];
  for (let t = 0; t < groups; t++) {
    const lengths = new Uint8Array(alphaSize);
    let current = reader.read(5);
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (current < 1 || current > MAX_CODE_LEN) throw new Bzip2Error('The archive has a block with an impossible code length.');
        if (!reader.bit()) break;
        current += reader.bit() ? -1 : 1;
      }
      lengths[i] = current;
    }
    tables.push(decodeTables(lengths, alphaSize));
  }

  // The move-to-front values and their runs: the block before the inverse transform.
  const counts = new Int32Array(256);
  const order = new Uint8Array(256);
  for (let i = 0; i < 256; i++) order[i] = i;
  let length = 0;
  let selector = 0;
  let left = 0;
  let table = null;
  const next = () => {
    if (left === 0) {
      if (selector >= selectors.length) throw new Bzip2Error('The archive has a block that runs past its code selectors.');
      table = tables[selectors[selector++]];
      left = GROUP_SIZE;
    }
    left--;
    return nextSymbol(reader, table);
  };
  let symbol = next();
  for (;;) {
    if (symbol === eob) break;
    if (symbol === RUNA || symbol === RUNB) {
      let run = 0;
      let weight = 1;
      do {
        run += (symbol === RUNA ? 1 : 2) * weight;
        weight <<= 1;
        if (run > blockSize) throw new Bzip2Error('The archive has a block larger than its stream says blocks are.');
        symbol = next();
      } while (symbol === RUNA || symbol === RUNB);
      const value = used[order[0]];
      if (length + run > blockSize) throw new Bzip2Error('The archive has a block larger than its stream says blocks are.');
      counts[value] += run;
      tt.fill(value, length, length + run);
      length += run;
      continue;
    }
    if (length >= blockSize) throw new Bzip2Error('The archive has a block larger than its stream says blocks are.');
    const index = symbol - 1;
    const front = order[index];
    order.copyWithin(1, 0, index);
    order[0] = front;
    const value = used[front];
    counts[value]++;
    tt[length++] = value;
    symbol = next();
  }
  if (origPtr >= length) throw new Bzip2Error('The archive has a block whose start lies outside it.');

  // The inverse Burrows-Wheeler transform: each byte's successor in the upper 24 bits.
  const start = new Int32Array(256);
  for (let i = 0, sum = 0; i < 256; i++) { start[i] = sum; sum += counts[i]; }
  for (let i = 0; i < length; i++) {
    const value = tt[i] & 0xff;
    tt[start[value]++] |= i << 8;
  }

  // The final run decoding (four equal bytes and a count), with the CRC over what comes out.
  let out = Buffer.allocUnsafe(Math.max(1024, length + (length >>> 2)));
  let at = 0;
  let crc = 0xffffffff;
  const room = (need) => {
    const bigger = Buffer.allocUnsafe(Math.max(need, out.length * 2));
    out.copy(bigger, 0, 0, at);
    out = bigger;
  };
  let pos = tt[origPtr] >>> 8;
  let last = -1;
  let same = 0;
  for (let i = 0; i < length; i++) {
    const entry = tt[pos];
    const byte = entry & 0xff;
    pos = entry >>> 8;
    if (same === 4) {
      if (at + byte > out.length) room(at + byte);
      for (let k = 0; k < byte; k++) {
        out[at++] = last;
        crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ last) & 0xff];
      }
      same = 0;
      last = -1;
      continue;
    }
    if (byte === last) same++;
    else { last = byte; same = 1; }
    if (at === out.length) room(at + 1);
    out[at++] = byte;
    crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff];
  }
  crc = (~crc) >>> 0;
  if (crc !== storedCrc) throw new Bzip2Error('A block of the archive does not decode to what was compressed (CRC mismatch).');
  return { data: out.subarray(0, at), crc };
}

/**
 * The decompressed bytes of `buffer` (one or more concatenated bzip2 streams), one block at a time. `progress`,
 * when given, is told after each block how far into `buffer` the reader is.
 * @param {Buffer} buffer
 * @param {{ progress?: (consumed: number, total: number) => void }} [o]
 */
export function* bunzip2Blocks(buffer, { progress } = {}) {
  const reader = new BitReader(buffer);
  let streams = 0;
  while (!reader.done) {
    // Zero bytes after the last stream are padding some writers leave; anything else has to be a stream.
    if (streams > 0 && buffer.subarray(reader.pos).every((byte) => byte === 0)) break;
    if (reader.read(8) !== 0x42 || reader.read(8) !== 0x5a || reader.read(8) !== 0x68) throw new Bzip2Error(streams ? 'The archive has something after its last stream.' : 'The archive is not a bzip2 file.');
    const level = reader.read(8) - 0x30;
    if (level < 1 || level > 9) throw new Bzip2Error('The archive names an impossible block size.');
    const blockSize = level * 100000;
    const tt = new Uint32Array(blockSize);
    let combined = 0;
    for (;;) {
      const hi = reader.read(24);
      const lo = reader.read(24);
      if (hi === BLOCK_MAGIC_HI && lo === BLOCK_MAGIC_LO) {
        const block = decodeBlock(reader, tt, blockSize);
        combined = (((combined << 1) | (combined >>> 31)) ^ block.crc) >>> 0;
        progress?.(reader.pos, buffer.length);
        if (block.data.length) yield block.data;
        continue;
      }
      if (hi === END_MAGIC_HI && lo === END_MAGIC_LO) {
        if (reader.read32() !== combined) throw new Bzip2Error('The archive does not decode to what was compressed (stream CRC mismatch).');
        reader.align();
        break;
      }
      throw new Bzip2Error('The archive has something that is not a bzip2 block.');
    }
    streams++;
  }
  if (!streams) throw new Bzip2Error('The archive is empty.');
}

/** All of `buffer`, decompressed (tests and small files). */
export function bunzip2(buffer) {
  const parts = [...bunzip2Blocks(buffer)];
  return Buffer.concat(parts);
}
