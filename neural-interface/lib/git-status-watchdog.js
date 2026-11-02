// Started and acknowledged before the first git child. IPC disconnect survives a
// hard parent exit; removal on child exit prevents later deadlines using its PID.
import { spawn } from 'node:child_process';
const owned = new Map();
let disconnected = false;
async function end(pid, record) {
  if (owned.get(pid) !== record || record.killing) return;
  record.killing = true;
  if (process.platform === 'win32') {
    await new Promise(done => {
      let child, timer, finished = false;
      const finish = code => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (code !== 0 && owned.get(pid) === record) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        done();
      };
      try {
        child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        child.once('error', () => finish(-1)); child.once('exit', finish); child.once('close', finish);
        timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(-1); }, 1000);
      } catch { finish(-1); }
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (owned.get(pid) === record) owned.delete(pid);
  if (disconnected && !owned.size) process.exit(0);
}
process.on('message', message => {
  if (Number.isInteger(message?.add) && message.add > 0) owned.set(message.add, { deadline: message.deadline });
  if (Number.isInteger(message?.remove)) owned.delete(message.remove);
});
process.on('disconnect', () => {
  disconnected = true;
  for (const [pid, record] of owned) void end(pid, record);
  if (!owned.size) process.exit(0);
});
setInterval(() => { for (const [pid, record] of owned) if (Date.now() >= record.deadline) void end(pid, record); }, 300);
process.send?.('ready');
