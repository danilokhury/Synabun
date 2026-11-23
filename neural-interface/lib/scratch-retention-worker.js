// The worker thread of a scratch retention pass. The live owners' last word comes from the main thread: no answer
// within five seconds means the folder stays.
import { parentPort, workerData } from 'node:worker_threads';
import { runPass } from './scratch-retention-core.js';

const CONFIRM_TIMEOUT_MS = 5000;
const waiting = new Map();
let nextId = 0;

const onMessage = ({ id, ok }) => {
  const done = waiting.get(id);
  if (done) done(ok === true);
};
parentPort.on('message', onMessage);

function confirm(row) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const finish = (ok) => { clearTimeout(timer); waiting.delete(id); resolve(ok); };
    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
    waiting.set(id, finish);
    parentPort.postMessage({ confirm: { ...row, id } });
  });
}

try {
  const summary = await runPass({
    dataHome: workerData.dataHome, dryRun: workerData.dryRun !== false, confirm,
    emit: (row) => parentPort.postMessage({ folder: row }),
  });
  parentPort.postMessage({ summary });
} catch (error) {
  parentPort.postMessage({ failed: String(error?.message || error) });
} finally {
  parentPort.off('message', onMessage); // nothing left to wait for: the thread ends once its messages are out
  parentPort.unref();
}
