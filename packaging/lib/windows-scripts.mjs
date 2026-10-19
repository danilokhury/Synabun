/**
 * The byte rule for every script Windows reads in a code page of its own: the
 * Windows installer's PowerShell helpers and NSIS includes
 * (packaging/desktop/build) and the application's .ps1, .cmd and .bat files.
 *
 * Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI
 * code page (Windows-1252 on an English or Portuguese Windows), cmd.exe reads a
 * batch file in the OEM code page, and makensis is told its input is UTF-8. A
 * UTF-8 character outside ASCII therefore means something else to two of the
 * three. SynaBun 2.0.7's synabun-verify.ps1 had an em dash (E2 80 94) in a
 * double-quoted string; Windows-1252 reads those bytes as "a-circumflex, euro
 * sign, right double quotation mark", and PowerShell takes U+201D for a closing
 * quote, so the script never parsed and every install failed after unpacking.
 *
 * So: ASCII only. A PowerShell or NSIS file that truly needs more is UTF-8 with
 * a byte order mark (both read that as UTF-8). A batch file never has one:
 * cmd.exe runs the mark as part of the first command.
 *
 * Pure (packaging/tests/windows-scripts.test.mjs; scripts/release/lib/artifact-audit.mjs
 * runs it over the scripts a finished Windows installer carries).
 */

import { extname } from 'node:path';

export const WINDOWS_SCRIPT_EXTENSIONS = Object.freeze(['.ps1', '.psm1', '.psd1', '.nsh', '.nsi', '.cmd', '.bat']);
const BATCH = new Set(['.cmd', '.bat']);

/** Whether a file name is one of the scripts the rule covers. */
export function isWindowsScript(name) {
  return WINDOWS_SCRIPT_EXTENSIONS.includes(extname(String(name)).toLowerCase());
}

const hasBom = (bytes) => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

/**
 * What is wrong with one script's bytes, as a sentence, or null when nothing is: the first byte outside ASCII
 * (with its line and column) in a file without a UTF-8 byte order mark, a byte order mark on a batch file, or a
 * byte order mark on something that is not UTF-8.
 */
export function windowsScriptProblem(name, bytes) {
  const ext = extname(String(name)).toLowerCase();
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (hasBom(data)) {
    if (BATCH.has(ext)) return 'starts with a UTF-8 byte order mark, which cmd.exe runs as part of its first command';
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(3));
    } catch {
      return 'has a UTF-8 byte order mark but is not UTF-8';
    }
    return null;
  }
  let line = 1;
  let column = 1;
  for (let at = 0; at < data.length; at++) {
    const byte = data[at];
    if (byte === 0x0a) { line++; column = 1; continue; }
    if (byte > 0x7f) {
      const reader = ext.startsWith('.ps') ? 'Windows PowerShell 5.1 reads it as Windows-1252, where U+201C and U+201D end a string'
        : BATCH.has(ext) ? 'cmd.exe reads it in the OEM code page' : 'the PowerShell helpers it carries are read as Windows-1252';
      return `byte 0x${byte.toString(16).toUpperCase()} at line ${line}, column ${column} is not ASCII and the file has no UTF-8 byte order mark (${reader})`;
    }
    column++;
  }
  return null;
}

// Windows-1252 differs from Latin-1 only in 0x80-0x9F. Node 22's TextDecoder('windows-1252') reads those bytes
// as Latin-1 too (Node 24 does not), so the table is written out here.
const CP1252_80_9F = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

/** How Windows PowerShell 5.1 reads a script's bytes: as UTF-8 after a byte order mark, otherwise as Windows-1252. */
export function powershellReads(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (hasBom(data)) return new TextDecoder('utf-8').decode(data.subarray(3));
  let text = '';
  for (const byte of data) text += byte >= 0x80 && byte <= 0x9f ? CP1252_80_9F[byte - 0x80] : String.fromCharCode(byte);
  return text;
}
