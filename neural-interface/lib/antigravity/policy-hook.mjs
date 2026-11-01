#!/usr/bin/env node
// ═══════════════════════════════════════════
// SynaBun — the PreToolUse hook of a SynaBun Antigravity home (lib/antigravity/home.js)
// ═══════════════════════════════════════════
//
// Antigravity runs this before every tool call of a brain or run SynaBun started, with the call on
// stdin ({ toolCall: { name, args }, conversationId, workspacePaths, … }) and the agent's own
// environment, which carries where SynaBun listens (SYNABUN_AGY_POLICY_URL, a loopback address) and
// the home's token (SYNABUN_AGY_POLICY_TOKEN). It prints SynaBun's answer ({ decision, reason? }).
// Whatever goes wrong (no token, SynaBun not answering, a bad answer) the call is refused with the
// reason: a SynaBun home never runs a tool nobody checked. No imports of SynaBun's own: it starts
// for every call, so it stays small.

const MAX_INPUT = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function answer(value) {
  process.stdout.write(JSON.stringify(value));
}
function refuse(reason) {
  answer({ decision: 'deny', reason: `SynaBun policy: ${reason}` });
}

async function readStdin() {
  let size = 0;
  const chunks = [];
  let truncated = false;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) { truncated = true; continue; }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function loopbackUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? url : null;
  } catch { return null; }
}

async function main() {
  const url = loopbackUrl(process.env.SYNABUN_AGY_POLICY_URL);
  const token = String(process.env.SYNABUN_AGY_POLICY_TOKEN || '');
  if (!url || !token) { refuse('this Antigravity session is missing its SynaBun policy settings, so no tool runs. End the turn and report it.'); return; }
  const input = await readStdin();
  if (input.truncated) { refuse('the tool-call input exceeded the size limit, so it is refused.'); return; }
  let payload;
  try { payload = JSON.parse(input.text); } catch { refuse('the tool-call input is not valid JSON, so it is refused.'); return; }
  const toolCall = payload?.toolCall;
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall) || typeof toolCall.name !== 'string' || !toolCall.name.trim()) {
    refuse('the input has no valid tool call, so it is refused.'); return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // An agent's own call says who it is (lib/owner-authority.js isAgentCall): its pin, never a secret.
      headers: { 'Content-Type': 'application/json', 'X-Synabun-Terminal': String(process.env.SYNABUN_TERMINAL_SESSION || 'antigravity').slice(0, 200) },
      body: JSON.stringify({ token, payload: { toolCall: payload?.toolCall || null, conversationId: payload?.conversationId || null, stepIdx: payload?.stepIdx ?? null } }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.decision !== 'string') { refuse(`SynaBun did not answer for this call (HTTP ${res.status}), so it is refused.`); return; }
    if (body.decision === 'deny') { answer({ decision: 'deny', reason: String(body.reason || 'SynaBun refused this call.') }); return; }
    answer(body.decision === 'allow' ? { decision: 'allow' } : { decision: 'ask' });
  } catch (error) {
    refuse(`SynaBun could not be reached to check this call (${error?.name === 'AbortError' ? 'timed out' : String(error?.message || error).slice(0, 120)}), so it is refused.`);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => refuse(`the check failed (${String(error?.message || error).slice(0, 120)}).`));
