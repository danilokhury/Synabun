import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

const entry = pathToFileURL(resolve(__dirname, 'dist', 'preload.js')).href;
await import(entry);
