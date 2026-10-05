// The tab displays only these fields; challenge and proof remain transport-local.
export function codexVerificationCardParams(params = {}) {
  if (params.mode !== 'openai/userVerification') return params;
  return { mode: params.mode, title: typeof params.title === 'string' ? params.title : '',
    description: typeof params.description === 'string' ? params.description : '' };
}

/** Per-elicitation gate. Never log challenges or proofs. */
export class CodexVerificationOperation {
  constructor() { this.started = false; this.inFlight = false; this.resolved = false; this.rpcId = null; this.proof = null; }
  start() {
    if (this.started || this.resolved) throw new Error('Verification is already started or resolved.');
    this.started = true; this.inFlight = true;
  }
  captureRpcId(id) { this.rpcId = id; }
  complete(result) {
    this.inFlight = false;
    if (this.resolved) return false;
    if (typeof result?.proof?.credentialId !== 'string' || typeof result?.proof?.signature !== 'string') throw new Error('Codex did not return a verification proof.');
    this.proof = result.proof;
    return true;
  }
  finish(action, content = null) {
    if (this.resolved) return null;
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('Invalid verification decision.');
    if (action === 'accept' && (!this.proof || content?.credentialId !== this.proof.credentialId || content?.signature !== this.proof.signature)) throw new Error('Verify before accepting this request.');
    this.resolved = true;
    const cancelId = this.inFlight ? this.rpcId : null;
    this.inFlight = false;
    const result = { action, content: action === 'accept' ? this.proof : null };
    this.proof = null;
    return { cancelId, result };
  }
}
