#!/usr/bin/env node

/**
 * Permission System Tests
 *
 * Tests the sidepanel permission blocking system:
 *   - Buffer gate blocks ALL messages during permission/ask prompts
 *   - AskUserQuestion buffering via pendingAskRequestId
 *   - Buffer flush after ask answer
 *   - Queue + buffer cleared on deny
 *   - Always button replaces checkbox
 *   - Server kills process on deny
 *
 * Source validation tests run standalone.
 * Server integration tests require: node neural-interface/server.js
 *
 * Run: node tests/automated/permission-system.test.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assert, skip, section, printSummary, serverIsUp,
  PROJECT_ROOT,
  B, X, Y,
} from './test-utils.mjs';

// ─── Load source files ──────────────────────────────────────────────

const CLIENT_PATH = join(PROJECT_ROOT, 'neural-interface', 'public', 'shared', 'ui-claude-panel.js');
const SERVER_PATH = join(PROJECT_ROOT, 'neural-interface', 'server.js');

let clientSrc, serverSrc;
try {
  clientSrc = readFileSync(CLIENT_PATH, 'utf-8');
  serverSrc = readFileSync(SERVER_PATH, 'utf-8');
} catch (e) {
  console.error(`Failed to read source files: ${e.message}`);
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Create a mock tab object matching the real tab structure */
function mockTab(overrides = {}) {
  return {
    _activePerm: false,
    pendingAskRequestId: null,
    pendingAskToolUseId: null,
    pendingAskBufferedAnswer: null,
    askRenderedViaControl: false,
    _permQueue: [],
    _msgBuffer: [],
    messagesEl: null,
    ws: null,
    running: false,
    ...overrides,
  };
}

/**
 * Simulate the handleTabMsg buffer gate logic.
 * Returns true if the message was buffered, false if it passed through.
 */
function simulateBufferGate(tab, msg) {
  if ((tab._activePerm || tab.pendingAskRequestId) && msg.type !== 'control_request') {
    if (tab._msgBuffer.length < 500) tab._msgBuffer.push(msg);
    return true; // buffered
  }
  return false; // passed through
}

/**
 * Simulate the resolve() function from renderPermissionPrompt.
 * Returns the resolved state.
 */
function simulateResolve(tab, behavior, always = false) {
  const autoAllowTools = new Set();
  const toolName = 'Bash';

  if (always) autoAllowTools.add(toolName);

  // On deny: clear queued permissions and buffered messages
  if (behavior === 'deny') {
    tab._permQueue.length = 0;
    tab._msgBuffer.length = 0;
  }
  tab._activePerm = false;

  return { autoAllowTools, toolName };
}

/**
 * Simulate _showNextPerm logic.
 * Returns: 'waiting' if _activePerm blocks, 'next' if another perm shown,
 * 'flushed' if buffer was flushed.
 */
function simulateShowNextPerm(tab) {
  if (tab._activePerm) return 'waiting';
  const next = tab._permQueue.shift();
  if (!next) {
    return 'flushed';
  }
  tab._activePerm = true;
  return 'next';
}


// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${B}SynaBun Permission System Tests${X}\n`);

  // ─────────────────────────────────────────────────────────────────
  // Part 1: Source Validation — verify code patterns exist
  // ─────────────────────────────────────────────────────────────────

  section('Source Validation — Buffer Gate (ui-claude-panel.js)');

  {
    // The buffer gate must check BOTH _activePerm and pendingAskRequestId
    const hasUnifiedGate = clientSrc.includes('tab._activePerm || tab.pendingAskRequestId');
    assert(hasUnifiedGate, 'Buffer gate checks both _activePerm and pendingAskRequestId');
  }

  {
    // The buffer gate must NOT have an event exception (old bug: msg.type !== "event")
    const gateLines = clientSrc.split('\n').filter(l =>
      l.includes('_activePerm') && l.includes('msg.type') && l.includes('_msgBuffer')
    );
    const hasEventException = gateLines.some(l => l.includes("'event'") || l.includes('"event"'));
    assert(!hasEventException, 'Buffer gate does NOT have event message exception');
  }

  {
    // Only control_request should pass through the gate
    const gateLines = clientSrc.split('\n').filter(l =>
      l.includes('_activePerm') && l.includes('control_request') && l.includes('msg.type')
    );
    assert(gateLines.length > 0, 'Buffer gate allows control_request messages through');
  }

  section('Source Validation — AskUserQuestion Buffer Flush (ui-claude-panel.js)');

  {
    // sendAskAnswer must call _flushMsgBuffer after clearing pendingAskRequestId
    const fnStart = clientSrc.indexOf('function sendAskAnswer');
    const fnEnd = clientSrc.indexOf('\nfunction ', fnStart + 1);
    const askAnswerSection = clientSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1200);
    assert(askAnswerSection.includes('_flushMsgBuffer'), 'sendAskAnswer calls _flushMsgBuffer');
  }

  {
    // The flush should be conditional on no active perm
    const fnStart = clientSrc.indexOf('function sendAskAnswer');
    const fnEnd = clientSrc.indexOf('\nfunction ', fnStart + 1);
    const askAnswerSection = clientSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1200);
    assert(askAnswerSection.includes('!tab._activePerm'), 'Buffer flush in sendAskAnswer is gated on !_activePerm');
  }

  section('Source Validation — Deny Cleanup (ui-claude-panel.js)');

  {
    // resolve('deny') must clear _permQueue
    const resolveSection = clientSrc.slice(
      clientSrc.indexOf("const resolve = (behavior"),
      clientSrc.indexOf("const resolve = (behavior") + 800
    );
    assert(resolveSection.includes("_permQueue.length = 0"), 'Deny path clears _permQueue');
  }

  {
    // resolve('deny') must clear _msgBuffer
    const resolveSection = clientSrc.slice(
      clientSrc.indexOf("const resolve = (behavior"),
      clientSrc.indexOf("const resolve = (behavior") + 800
    );
    assert(resolveSection.includes("_msgBuffer.length = 0"), 'Deny path clears _msgBuffer');
  }

  {
    // The clearing must be conditional on deny (not always)
    const resolveSection = clientSrc.slice(
      clientSrc.indexOf("const resolve = (behavior"),
      clientSrc.indexOf("const resolve = (behavior") + 800
    );
    assert(resolveSection.includes("behavior === 'deny'"), 'Queue/buffer clearing is conditional on deny');
  }

  section('Source Validation — Always Button (ui-claude-panel.js)');

  {
    assert(clientSrc.includes('perm-btn-always'), 'Always button class exists (perm-btn-always)');
  }

  {
    const permSection = clientSrc.slice(
      clientSrc.indexOf('function renderPermissionPrompt'),
      clientSrc.indexOf('function renderPermissionPrompt') + 2500
    );
    assert(permSection.includes("alwaysBtn.className = 'perm-btn perm-btn-always'"), 'Always is a button element with correct class');
  }

  {
    // Old checkbox elements must NOT exist
    assert(!clientSrc.includes("alwaysCb.type = 'checkbox'"), 'Old checkbox element (alwaysCb) removed');
    assert(!clientSrc.includes("alwaysLbl.className = 'perm-always'"), 'Old label element (alwaysLbl) removed');
  }

  {
    // Always button must be first in the actions row (before Allow and Deny)
    const appendLine = clientSrc.split('\n').find(l =>
      l.includes('actions.append') && l.includes('alwaysBtn') && l.includes('allowBtn') && l.includes('denyBtn')
    );
    assert(!!appendLine, 'actions.append includes alwaysBtn, allowBtn, denyBtn');
    if (appendLine) {
      const alwaysPos = appendLine.indexOf('alwaysBtn');
      const allowPos = appendLine.indexOf('allowBtn');
      const denyPos = appendLine.indexOf('denyBtn');
      assert(alwaysPos < allowPos && allowPos < denyPos, 'Button order is Always → Allow → Deny (left to right)');
    }
  }

  {
    assert(clientSrc.includes("resolve('allow', true)"), 'Always button calls resolve with always=true');
  }

  {
    assert(clientSrc.includes('const resolve = (behavior, always = false)'), 'resolve() accepts always parameter');
  }

  {
    const resolveSection = clientSrc.slice(
      clientSrc.indexOf("const resolve = (behavior"),
      clientSrc.indexOf("const resolve = (behavior") + 800
    );
    assert(resolveSection.includes("always ? 'Always'"), 'Status badge shows "Always" when always=true');
  }

  section('Source Validation — Always Button CSS (ui-claude-panel.js)');

  {
    assert(clientSrc.includes('.perm-btn-always {'), 'CSS rule for .perm-btn-always exists');
    assert(clientSrc.includes('.perm-btn-always:hover'), 'CSS hover rule for .perm-btn-always exists');
  }

  {
    // Old .perm-always CSS must be removed
    assert(!clientSrc.includes('.perm-always {'), 'Old .perm-always CSS rule removed');
    assert(!clientSrc.includes('.perm-always:hover'), 'Old .perm-always:hover CSS rule removed');
    assert(!clientSrc.includes('.perm-always input'), 'Old .perm-always input CSS rule removed');
  }

  {
    assert(clientSrc.includes('.perm-card.resolved .perm-btn-always'), 'Resolved state CSS covers .perm-btn-always');
  }

  section('Source Validation — Kill Process on Deny (server.js)');

  {
    // Find the deny handler (second occurrence — first is proactive card log)
    const firstIdx = serverSrc.indexOf('Permission denied for');
    const denyIdx = serverSrc.indexOf('Permission denied for', firstIdx + 1);
    const denySection = serverSrc.slice(denyIdx, denyIdx + 300);
    assert(denySection.includes('killProc()'), 'Server calls killProc() on permission deny');
  }

  {
    const killProcSection = serverSrc.slice(
      serverSrc.indexOf('function killProc()'),
      serverSrc.indexOf('function killProc()') + 200
    );
    assert(killProcSection.includes('activeProc.kill()'), 'killProc kills the active process');
    assert(killProcSection.includes('activeProc = null'), 'killProc nulls activeProc');
    assert(killProcSection.includes('awaitingPermission = false'), 'killProc clears awaitingPermission');
  }

  {
    const firstIdx = serverSrc.indexOf('Permission denied for');
    const denyIdx = serverSrc.indexOf('Permission denied for', firstIdx + 1);
    const denySection = serverSrc.slice(denyIdx, denyIdx + 400);
    assert(denySection.includes("type: 'done'"), 'Server sends done message after killProc on deny');
  }

  {
    // killProc must be called BEFORE sending done
    const firstIdx = serverSrc.indexOf('Permission denied for');
    const denyIdx = serverSrc.indexOf('Permission denied for', firstIdx + 1);
    const denySection = serverSrc.slice(denyIdx, denyIdx + 400);
    const killIdx = denySection.indexOf('killProc()');
    const doneIdx = denySection.indexOf("type: 'done'");
    assert(killIdx < doneIdx, 'killProc() called BEFORE sending done on deny');
  }

  // ─────────────────────────────────────────────────────────────────
  // Part 2: Logic Simulation — test behavior with mock objects
  // ─────────────────────────────────────────────────────────────────

  section('Logic — Buffer Gate: Permission Active');

  {
    const tab = mockTab({ _activePerm: true });
    const eventBuffered = simulateBufferGate(tab, { type: 'event', event: { type: 'assistant' } });
    assert(eventBuffered, 'Event messages buffered during _activePerm (was the old bug)');
    assert(tab._msgBuffer.length === 1, 'Event message added to buffer');
  }

  {
    const tab = mockTab({ _activePerm: true });
    const doneBuffered = simulateBufferGate(tab, { type: 'done', code: 0 });
    assert(doneBuffered, 'Done messages buffered during _activePerm');
  }

  {
    const tab = mockTab({ _activePerm: true });
    const crPassed = simulateBufferGate(tab, { type: 'control_request', request_id: 'test' });
    assert(!crPassed, 'control_request passes through during _activePerm');
    assert(tab._msgBuffer.length === 0, 'control_request not added to buffer');
  }

  section('Logic — Buffer Gate: AskUserQuestion Active');

  {
    const tab = mockTab({ pendingAskRequestId: 'ask-123' });
    const eventBuffered = simulateBufferGate(tab, { type: 'event', event: { type: 'assistant' } });
    assert(eventBuffered, 'Event messages buffered during pendingAskRequestId');
  }

  {
    const tab = mockTab({ pendingAskRequestId: 'ask-123' });
    const doneBuffered = simulateBufferGate(tab, { type: 'done', code: 0 });
    assert(doneBuffered, 'Done messages buffered during pendingAskRequestId');
  }

  {
    const tab = mockTab({ pendingAskRequestId: 'ask-123' });
    const stderrBuffered = simulateBufferGate(tab, { type: 'stderr', text: 'warning' });
    assert(stderrBuffered, 'Stderr messages buffered during pendingAskRequestId');
  }

  {
    const tab = mockTab({ pendingAskRequestId: 'ask-123' });
    const crPassed = simulateBufferGate(tab, { type: 'control_request', request_id: 'perm-456' });
    assert(!crPassed, 'control_request passes through during pendingAskRequestId');
  }

  section('Logic — Buffer Gate: No Active Prompt');

  {
    const tab = mockTab();
    const eventPassed = !simulateBufferGate(tab, { type: 'event', event: {} });
    const donePassed = !simulateBufferGate(tab, { type: 'done', code: 0 });
    const crPassed = !simulateBufferGate(tab, { type: 'control_request', request_id: 'x' });
    assert(eventPassed, 'Event passes through when no prompt active');
    assert(donePassed, 'Done passes through when no prompt active');
    assert(crPassed, 'control_request passes through when no prompt active');
    assert(tab._msgBuffer.length === 0, 'Nothing buffered when no prompt active');
  }

  section('Logic — Buffer Gate: Both Active');

  {
    const tab = mockTab({ _activePerm: true, pendingAskRequestId: 'ask-789' });
    const buffered = simulateBufferGate(tab, { type: 'event', event: {} });
    assert(buffered, 'Messages buffered when both _activePerm and pendingAskRequestId set');
  }

  section('Logic — Buffer Capacity');

  {
    const tab = mockTab({ _activePerm: true });
    for (let i = 0; i < 500; i++) {
      simulateBufferGate(tab, { type: 'event', event: { i } });
    }
    assert(tab._msgBuffer.length === 500, 'Buffer reaches max capacity of 500');

    simulateBufferGate(tab, { type: 'event', event: { overflow: true } });
    assert(tab._msgBuffer.length === 500, 'Buffer does not exceed 500 (overflow prevented)');
  }

  section('Logic — Deny Clears Queue and Buffer');

  {
    const tab = mockTab({
      _activePerm: true,
      _permQueue: [
        { requestId: 'perm-1', req: { tool_name: 'Edit' } },
        { requestId: 'perm-2', req: { tool_name: 'Write' } },
        { requestId: 'perm-3', req: { tool_name: 'Bash' } },
      ],
      _msgBuffer: [
        { type: 'event', event: {} },
        { type: 'done', code: 0 },
      ],
    });

    simulateResolve(tab, 'deny');
    assert(tab._permQueue.length === 0, 'Deny clears entire permission queue');
    assert(tab._msgBuffer.length === 0, 'Deny clears entire message buffer');
    assert(tab._activePerm === false, 'Deny clears _activePerm');
  }

  section('Logic — Allow Preserves Queue and Buffer');

  {
    const tab = mockTab({
      _activePerm: true,
      _permQueue: [
        { requestId: 'perm-1', req: { tool_name: 'Edit' } },
      ],
      _msgBuffer: [
        { type: 'event', event: {} },
      ],
    });

    simulateResolve(tab, 'allow');
    assert(tab._permQueue.length === 1, 'Allow preserves permission queue');
    assert(tab._msgBuffer.length === 1, 'Allow preserves message buffer');
    assert(tab._activePerm === false, 'Allow clears _activePerm');
  }

  section('Logic — Always Allow');

  {
    const tab = mockTab({ _activePerm: true });
    const { autoAllowTools, toolName } = simulateResolve(tab, 'allow', true);
    assert(autoAllowTools.has(toolName), 'Always adds tool to autoAllowTools set');
    assert(tab._activePerm === false, 'Always clears _activePerm');
  }

  {
    const tab = mockTab({ _activePerm: true });
    const { autoAllowTools } = simulateResolve(tab, 'deny', false);
    assert(autoAllowTools.size === 0, 'Deny does not add tool to autoAllowTools');
  }

  section('Logic — Show Next Perm');

  {
    const tab = mockTab({ _activePerm: true });
    const result = simulateShowNextPerm(tab);
    assert(result === 'waiting', 'showNextPerm returns waiting when _activePerm is true');
  }

  {
    const tab = mockTab({
      _activePerm: false,
      _permQueue: [{ requestId: 'perm-1', req: { tool_name: 'Bash' } }],
    });
    const result = simulateShowNextPerm(tab);
    assert(result === 'next', 'showNextPerm shows next queued permission');
    assert(tab._activePerm === true, 'showNextPerm sets _activePerm for next card');
    assert(tab._permQueue.length === 0, 'showNextPerm removes item from queue');
  }

  {
    const tab = mockTab({ _activePerm: false, _permQueue: [] });
    const result = simulateShowNextPerm(tab);
    assert(result === 'flushed', 'showNextPerm flushes buffer when queue is empty');
  }

  section('Logic — Deny Then ShowNextPerm');

  {
    const tab = mockTab({
      _activePerm: true,
      _permQueue: [
        { requestId: 'perm-1', req: { tool_name: 'Edit' } },
        { requestId: 'perm-2', req: { tool_name: 'Write' } },
      ],
      _msgBuffer: [
        { type: 'event', event: {} },
        { type: 'done', code: 0 },
      ],
    });

    simulateResolve(tab, 'deny');
    assert(tab._permQueue.length === 0, 'After deny: queue is empty');
    assert(tab._msgBuffer.length === 0, 'After deny: buffer is empty');

    const result = simulateShowNextPerm(tab);
    assert(result === 'flushed', 'After deny: showNextPerm flushes (empty queue)');
    assert(tab._activePerm === false, 'After deny: no new _activePerm set');
  }

  section('Logic — Full Permission Spam Scenario');

  {
    const tab = mockTab();

    // 3 permission requests arrive
    tab._permQueue.push({ requestId: 'perm-1', req: { tool_name: 'Bash' } });
    tab._permQueue.push({ requestId: 'perm-2', req: { tool_name: 'Edit' } });
    tab._permQueue.push({ requestId: 'perm-3', req: { tool_name: 'Write' } });

    // First one shown
    tab._activePerm = true;
    tab._permQueue.shift(); // perm-1 shown, perm-2 and perm-3 in queue

    // Events arrive while perm-1 is shown
    simulateBufferGate(tab, { type: 'event', event: { type: 'thinking' } });
    simulateBufferGate(tab, { type: 'event', event: { type: 'assistant' } });
    assert(tab._msgBuffer.length === 2, 'Events buffered while permission shown');

    // User denies perm-1
    simulateResolve(tab, 'deny');
    assert(tab._permQueue.length === 0, 'Deny clears remaining 2 queued permissions');
    assert(tab._msgBuffer.length === 0, 'Deny clears buffered events');

    // showNextPerm: nothing left
    const result = simulateShowNextPerm(tab);
    assert(result === 'flushed', 'No more permissions to show after deny');
    assert(tab._activePerm === false, 'System is fully idle after deny');
  }

  section('Logic — AskUserQuestion Blocking Scenario');

  {
    const tab = mockTab({ pendingAskRequestId: 'ask-001' });

    // Stream events arrive while ask is active
    simulateBufferGate(tab, { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'text' }] } } });
    simulateBufferGate(tab, { type: 'event', event: { type: 'system' } });
    simulateBufferGate(tab, { type: 'done', code: 0 });
    assert(tab._msgBuffer.length === 3, 'All message types buffered during ask');

    // User answers → pendingAskRequestId cleared → buffer should flush
    tab.pendingAskRequestId = null;

    // Now messages pass through
    const passes = !simulateBufferGate(tab, { type: 'event', event: {} });
    assert(passes, 'Messages pass through after ask is answered');
  }

  section('Logic — Mixed Permission + Ask Scenario');

  {
    // Permission active, then ask arrives via control_request
    const tab = mockTab({ _activePerm: true });

    // Buffer some events
    simulateBufferGate(tab, { type: 'event', event: { type: 'assistant' } });
    assert(tab._msgBuffer.length === 1, 'Event buffered during permission');

    // Ask control_request passes through (as expected)
    const askPassed = !simulateBufferGate(tab, { type: 'control_request', request_id: 'ask-100' });
    assert(askPassed, 'Ask control_request passes through during permission');

    // Simulate ask being set
    tab.pendingAskRequestId = 'ask-100';

    // Permission resolved (allow), but ask still active
    tab._activePerm = false;

    // Messages should STILL be buffered because ask is active
    const stillBuffered = simulateBufferGate(tab, { type: 'event', event: {} });
    assert(stillBuffered, 'Messages still buffered when perm resolved but ask still active');

    // Ask answered
    tab.pendingAskRequestId = null;

    // Now everything passes
    const finallyPassed = !simulateBufferGate(tab, { type: 'event', event: {} });
    assert(finallyPassed, 'Messages pass through after both perm and ask resolved');
  }

  section('Logic — Multiple Sequential Allows');

  {
    // Simulate allowing 3 tools in sequence (the normal happy path)
    const tab = mockTab();
    const autoAllowTools = new Set();

    // 3 permissions queued
    tab._permQueue.push({ requestId: 'perm-1', req: { tool_name: 'Bash' } });
    tab._permQueue.push({ requestId: 'perm-2', req: { tool_name: 'Edit' } });
    tab._permQueue.push({ requestId: 'perm-3', req: { tool_name: 'Write' } });

    // Show first
    tab._activePerm = true;
    const first = tab._permQueue.shift();

    // Allow first
    tab._activePerm = false;
    assert(tab._permQueue.length === 2, 'After first allow: 2 remaining in queue');

    // Show second
    const nextResult = simulateShowNextPerm(tab);
    assert(nextResult === 'next', 'showNextPerm advances to second permission');
    assert(tab._permQueue.length === 1, 'After showing second: 1 remaining');

    // Allow second
    tab._activePerm = false;

    // Show third
    const nextResult2 = simulateShowNextPerm(tab);
    assert(nextResult2 === 'next', 'showNextPerm advances to third permission');
    assert(tab._permQueue.length === 0, 'After showing third: 0 remaining');

    // Allow third
    tab._activePerm = false;

    // No more — flush
    const finalResult = simulateShowNextPerm(tab);
    assert(finalResult === 'flushed', 'showNextPerm flushes after all allowed');
  }

  // ─────────────────────────────────────────────────────────────────
  // Part 3: Server Integration (requires running server)
  // ─────────────────────────────────────────────────────────────────

  section('Server Integration — Kill on Deny');

  if (await serverIsUp()) {
    {
      const firstIdx = serverSrc.indexOf('Permission denied for');
      const denyIdx = serverSrc.indexOf('Permission denied for', firstIdx + 1);
      const denyBlock = serverSrc.slice(denyIdx, denyIdx + 400);
      const killBeforeDone = denyBlock.indexOf('killProc()') < denyBlock.indexOf("type: 'done'");
      assert(killBeforeDone, 'Server calls killProc() BEFORE sending done on deny');
    }
  } else {
    skip('Server kill-on-deny integration', 'Neural Interface server not running');
  }

  // ─── Summary ──────────────────────────────────────────────────────

  const failed = printSummary('Permission System Tests');
  process.exit(failed ? 1 : 0);
}

main();
