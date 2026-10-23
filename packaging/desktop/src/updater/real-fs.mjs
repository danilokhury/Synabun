/**
 * Node's own file system, without Electron's .asar layer. Inside Electron the
 * `fs` module treats every `.asar` file as a folder of the files packed in it:
 * a walk of an unpacked update would go into Contents/Resources/app.asar, read
 * a file that does not exist on disk, and find "files" the archive never had;
 * a removal of the folder would fail on it. Electron's `original-fs` is `fs`
 * without that layer; under plain Node (the tests) `fs` is already that.
 */

import { createRequire } from 'node:module';
import * as nodeFs from 'node:fs';

const require = createRequire(import.meta.url);

/** `original-fs` inside Electron, `node:fs` everywhere else: the files on disk as they are. */
export const realFs = process.versions?.electron ? require('original-fs') : nodeFs;
