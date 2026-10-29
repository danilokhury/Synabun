// One app-server per dispatched worker. The SDK-shaped surface keeps the native
// worker's event/usage contract while thread/resume reopens its durable thread.
import { spawn, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const toml = (v) => Array.isArray(v) ? `[${v.map(toml).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(',')}}`
    : JSON.stringify(v);

// Match the SDK's leaf overrides: pins/switches address only their intended
// fields and leave native command/url/env definitions in the native config.
// Codex splits override paths literally on dots (it does not parse TOML keys).
// Top-level keys may already be override paths; nested keys are literal segments.
export function codexWorkerConfigOverrides(config) {
  const overrides = [];
  const visit = (value, path) => {
    if (value == null) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (path && /[.=\x00-\x1f\x7f]/.test(key)) throw new Error('Codex override paths cannot address this config key');
        visit(child, path ? `${path}.${key}` : key);
      }
    } else overrides.push(`${path}=${toml(value)}`);
  };
  visit(config, '');
  return overrides;
}

export class CodexWorkerAppServer {
  constructor({ codexPathOverride, env, config = {}, configArgs = [], apiKey, signal, onProcess = () => {} }) {
    this.pending = new Map();
    this.seq = 0;
    this.listener = null;
    this.failure = null;
    const args = [...configArgs];
    for (const override of codexWorkerConfigOverrides(config)) args.push('-c', override);
    // Run identity in the command line permits conservative orphan identification.
    args.push('-c', `synabun_worker_run=${JSON.stringify(env.SYNABUN_TERMINAL_SESSION || '')}`, 'app-server');
    this.proc = spawn(codexPathOverride, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise((r) => this.proc.once('close', r));
    onProcess({ pid: this.proc.pid, startedAt: new Date().toISOString() });
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && !msg.method) {
          const p = this.pending.get(msg.id); if (!p) continue;
          this.pending.delete(msg.id); clearTimeout(p.timer);
          msg.error ? p.reject(new Error(msg.error.message || 'Codex RPC failed')) : p.resolve(msg.result);
        } else if (msg.id != null) {
          // Workers have approvalPolicy never. Never grant an unexpected request.
          this.write({ id: msg.id, error: { code: -32601, message: 'Unattended worker does not accept interactive requests' } });
        } else this.listener?.(msg);
      }
    });
    // Drain stderr without exposing credentials/config to the worker transcript.
    this.proc.stderr.resume();
    this.proc.on('error', (error) => this.fail(error));
    this.proc.stdin.on('error', (error) => this.fail(error));
    this.proc.on('close', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal || code})`)));
    this.ready = (async () => {
      await this.rpc('initialize', { clientInfo: { name: 'synabun-worker', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      if (apiKey) await this.rpc('account/login/start', { type: 'apiKey', apiKey });
    })();
    this.ready.catch(() => {});
    this.startupSignal = signal;
    this.cancelStartup = () => { this.dispose().catch(() => {}); };
    signal?.addEventListener('abort', this.cancelStartup, { once: true });
    if (signal?.aborted) this.cancelStartup();
  }
  write(value) { if (!this.proc.stdin.destroyed) this.proc.stdin.write(JSON.stringify(value) + '\n'); }
  fail(error) {
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.listener?.({ method: 'synabun/exit', error });
  }
  rpc(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  startThread(options) { return this.thread(null, options); }
  resumeThread(id, options) { return this.thread(id, options); }
  thread(id, options) {
    const owner = this;
    const sandboxPolicy = options.sandboxMode === 'read-only' ? { type: 'readOnly', networkAccess: !!options.networkAccessEnabled }
      : options.sandboxMode === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [options.workingDirectory, ...(options.additionalDirectories || [])], networkAccess: !!options.networkAccessEnabled }
        : { type: 'dangerFullAccess' };
    const ready = this.ready.then(async () => {
      const reply = await this.rpc(id ? 'thread/resume' : 'thread/start', {
        ...(id ? { threadId: id } : {}), cwd: options.workingDirectory,
        model: options.model || null, approvalPolicy: 'never', sandbox: options.sandboxMode,
        config: { web_search: options.webSearchMode || 'disabled', sandbox_workspace_write: { network_access: !!options.networkAccessEnabled, writable_roots: options.additionalDirectories || [] } },
      });
      const actual = reply?.thread?.id;
      if (!actual || (id && actual !== id)) throw new Error('Codex did not resume the requested thread');
      id = actual;
    });
    ready.catch(() => {});
    return {
      get id() { return id; }, ready: () => ready,
      async runStreamed(prompt, { signal, outputSchema } = {}) {
        await ready;
        const queue = []; const text = new Map(); let wake; let done = false; let failure; let turnId;
        const push = (event) => { queue.push(event); wake?.(); };
        const abort = () => {
          failure = Object.assign(new Error('Codex turn aborted'), { name: 'AbortError' }); done = true; wake?.();
          if (turnId) owner.rpc('turn/interrupt', { threadId: id, turnId }).catch(() => {});
        };
        owner.listener = (msg) => {
          const p = msg.params || {};
          if (p.threadId && p.threadId !== id) return;
          if (msg.method === 'synabun/exit') { failure = msg.error; done = true; wake?.(); }
          if (msg.method === 'item/agentMessage/delta') {
            const value = (text.get(p.itemId) || '') + (p.delta || '');
            text.set(p.itemId, value);
            push({ type: 'item.updated', item: { id: p.itemId, type: 'agent_message', text: value } });
          }
          if (msg.method === 'item/started' || msg.method === 'item/completed') {
            const item = p.item || {};
            const types = { agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search', reasoning: 'reasoning' };
            push({ type: msg.method === 'item/started' ? 'item.started' : 'item.completed', item: { ...item, type: types[item.type] || item.type, aggregated_output: item.aggregatedOutput, exit_code: item.exitCode } });
          }
          if (msg.method === 'turn/completed') {
            if (p.turn?.status === 'failed') push({ type: 'turn.failed', error: p.turn.error || { message: 'Codex turn failed' } });
            else if (p.turn?.status === 'interrupted') failure = Object.assign(new Error('Codex turn interrupted'), { name: 'AbortError' });
            else push({ type: 'turn.completed' }); // rollout meter is authoritative across resumes
            done = true; wake?.();
          }
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (signal?.aborted) throw Object.assign(new Error('Codex turn aborted'), { name: 'AbortError' });
          const reply = await owner.rpc('turn/start', { threadId: id, input: [{ type: 'text', text: String(prompt), text_elements: [] }], approvalPolicy: 'never', sandboxPolicy, effort: options.modelReasoningEffort || null, ...(outputSchema ? { outputSchema } : {}) });
          turnId = reply?.turn?.id;
          if (signal?.aborted) abort();
        } catch (error) { owner.listener = null; signal?.removeEventListener('abort', abort); throw error; }
        return { events: (async function* () {
          try {
            yield { type: 'thread.started', thread_id: id };
            while (!done || queue.length) {
              if (queue.length) yield queue.shift();
              else await new Promise((r) => { wake = r; });
            }
            if (failure) throw failure;
          } finally { owner.listener = null; signal?.removeEventListener('abort', abort); }
        })() };
      },
    };
  }
  async dispose() {
    this.startupSignal?.removeEventListener('abort', this.cancelStartup);
    if (this.proc.exitCode !== null || this.proc.signalCode) return;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { timeout: 5000, stdio: 'ignore', windowsHide: true }); } catch {}
    } else this.proc.kill('SIGTERM');
    let timer;
    await Promise.race([this.exited, new Promise((r) => { timer = setTimeout(r, 1500); })]);
    clearTimeout(timer);
    if (this.proc.exitCode === null && !this.proc.signalCode) this.proc.kill('SIGKILL');
  }
}
