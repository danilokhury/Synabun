// ═══════════════════════════════════════════
// SynaBun — Git for Windows: the unpacking, in a thread of its own
// ═══════════════════════════════════════════
//
// install.js unpackInWorker() starts this with what unpackAndCheck() takes and
// a shared flag the server raises to stop it. The reading of the .tar.bz2, the
// writing of some ten thousand files and the digest of what was written take
// about a minute of CPU: here, they never hold the server's event loop. The
// thread answers with messages: `step`, `progress` (a few times a second at
// most), then `done` with the result or `error` with a GitBashError's code.

import { parentPort, workerData } from 'node:worker_threads';
import { asGitBashError, unpackAndCheck } from './install.js';

const { flag, ...options } = workerData;
let last = 0;

try {
  const result = unpackAndCheck({
    ...options,
    stopped: () => Atomics.load(flag, 0) === 1,
    onStep: (step) => parentPort.postMessage({ type: 'step', step }),
    onProgress: (progress) => {
      const now = Date.now();
      if (progress.consumed !== progress.total && now - last < 250) return;
      last = now;
      parentPort.postMessage({ type: 'progress', progress });
    },
  });
  parentPort.postMessage({ type: 'done', result });
} catch (failure) {
  const error = asGitBashError(failure, 'unpack', 'The archive could not be unpacked.');
  parentPort.postMessage({ type: 'error', code: error.code, message: error.message, detail: error.detail || null });
}
