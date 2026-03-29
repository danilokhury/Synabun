#!/usr/bin/env node

/**
 * Automated tests for the User Learning hook system.
 *
 * Tests the full lifecycle:
 *   prompt-submit nudge → stop hook enforcement → post-remember clearing
 *
 * Run: node hooks/claude-code/test-user-learning.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PENDING_REMEMBER_DIR = join(DATA_DIR, 'pending-remember');
const HOOK_FEATURES_PATH = join(DATA_DIR, 'hook-features.json');

const PROMPT_SUBMIT = join(__dirname, 'prompt-submit.mjs');
const STOP_HOOK = join(__dirname, 'stop.mjs');
const POST_REMEMBER = join(__dirname, 'post-remember.mjs');

const TEST_SESSION = 'test-user-learning-001';
const FLAG_PATH = join(PENDING_REMEMBER_DIR, `${TEST_SESSION}.json`);

// Colors
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', X = '\x1b[0m';

let passed = 0, failed = 0;

function assert(condition, name) {
  if (condition) { console.log(`  ${G}✓${X} ${name}`); passed++; }
  else { console.log(`  ${R}✗${X} ${name}`); failed++; }
}

function runHook(scriptPath, stdinData) {
  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      let parsed = {};
      try { parsed = stdout ? JSON.parse(stdout) : {}; } catch { /* ok */ }
      resolve({ code, stdout, stderr, parsed });
    });
    proc.stdin.write(JSON.stringify(stdinData));
    proc.stdin.end();
  });
}

function readFlag() {
  try { return JSON.parse(readFileSync(FLAG_PATH, 'utf-8')); }
  catch { return null; }
}

function writeFlag(flag) {
  writeFileSync(FLAG_PATH, JSON.stringify(flag));
}

function cleanup() {
  try { unlinkSync(FLAG_PATH); } catch { /* ok */ }
}

function getContext(result) {
  return result.parsed?.hookSpecificOutput?.additionalContext || '';
}

// Save original features to restore later
let originalFeatures;
try { originalFeatures = readFileSync(HOOK_FEATURES_PATH, 'utf-8'); }
catch { originalFeatures = '{}'; }

async function main() {
  console.log(`\n${B}User Learning Hook System — Automated Tests${X}\n`);

  if (!existsSync(PENDING_REMEMBER_DIR)) mkdirSync(PENDING_REMEMBER_DIR, { recursive: true });

  const testFeatures = {
    conversationMemory: true,
    greeting: false,
    userLearning: true,
    userLearningThreshold: 3,
    autoStoreOnEnd: false,
  };
  writeFileSync(HOOK_FEATURES_PATH, JSON.stringify(testFeatures));

  try {
    // ═══════════════════════════════════════════════════════════
    // TEST 1: No nudge below threshold
    // ═══════════════════════════════════════════════════════════
    console.log(`${Y}Test 1: No nudge below threshold${X}`);
    cleanup();

    // Message 1
    await runHook(PROMPT_SUBMIT, { prompt: 'Describe the color scheme in detail please', session_id: TEST_SESSION });
    let flag = readFlag();
    assert(flag !== null, 'Flag file created after message 1');
    assert(flag.messageCount === 1, `messageCount = 1 (got ${flag?.messageCount})`);
    assert(flag.totalSessionMessages === 1, `totalSessionMessages = 1 (got ${flag?.totalSessionMessages})`);

    // Message 2
    const r2 = await runHook(PROMPT_SUBMIT, { prompt: 'Now describe the typography choices', session_id: TEST_SESSION });
    flag = readFlag();
    assert(flag.messageCount === 2, `messageCount = 2 (got ${flag?.messageCount})`);
    assert(!flag.userLearningPending, 'userLearningPending not set at message 2');
    const ctx2 = getContext(r2);
    assert(!ctx2.includes('User Learning'), 'No user learning nudge at message 2');

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Nudge fires at threshold
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 2: Nudge fires at threshold (message 3)${X}`);

    const r3 = await runHook(PROMPT_SUBMIT, { prompt: 'What font sizes are being used here', session_id: TEST_SESSION });
    flag = readFlag();
    assert(flag.messageCount === 3, `messageCount = 3 (got ${flag?.messageCount})`);
    assert(flag.totalSessionMessages === 3, `totalSessionMessages = 3 (got ${flag?.totalSessionMessages})`);
    assert(flag.userLearningPending === true, 'userLearningPending = true');
    assert(flag.userLearningNudgeCount === 1, `nudgeCount = 1 (got ${flag?.userLearningNudgeCount})`);

    const ctx3 = getContext(r3);
    assert(ctx3.includes('User Learning'), 'Nudge text contains "User Learning"');
    assert(ctx3.includes('communication-style'), 'Nudge mentions communication-style');

    // ═══════════════════════════════════════════════════════════
    // TEST 2b: Nudge content has anti-misuse guardrails
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 2b: Nudge contains anti-misuse guardrails${X}`);

    assert(ctx3.includes('never `conversations`'), 'Nudge explicitly forbids conversations category');
    assert(ctx3.includes('NOT a session summary'), 'Nudge says "NOT a session summary"');
    assert(ctx3.includes('NOT what was worked on'), 'Nudge says content is NOT about what was worked on');
    assert(ctx3.includes('GOOD example'), 'Nudge has GOOD example');
    assert(ctx3.includes('BAD example'), 'Nudge has BAD example');
    assert(ctx3.includes('instruction patterns') && ctx3.includes('correction style'), 'Nudge lists specific observation targets');
    assert(ctx3.includes('AVOID DUPLICATES'), 'Nudge warns about duplicates');
    assert(ctx3.includes('reflect'), 'Nudge mentions reflect as an option');

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Stop hook blocks when userLearningPending
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 3: Stop hook blocks for user learning${X}`);

    const stop1 = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(stop1.parsed.decision === 'block', 'Stop hook blocks (retry 1)');
    const stopReason = stop1.parsed.reason || '';
    assert(stopReason.includes('communication-style'), 'Block reason mentions communication-style');

    // ─── TEST 3b: Stop block has anti-misuse guardrails ───
    console.log(`\n${Y}Test 3b: Stop block contains anti-misuse guardrails${X}`);

    assert(stopReason.includes('NOT') && stopReason.includes('conversations'), 'Stop block forbids conversations category');
    assert(stopReason.includes('NOT a session summary'), 'Stop block says NOT a session summary');
    assert(stopReason.includes('GOOD'), 'Stop block has GOOD example');
    assert(stopReason.includes('BAD'), 'Stop block has BAD example');
    assert(stopReason.includes('AVOID DUPLICATES'), 'Stop block warns about duplicates');
    assert(stopReason.includes('reflect'), 'Stop block mentions reflect as an option');

    // ─── TEST 3c: After 1 retry, stop allows (lightweight enforcement) ───
    console.log(`\n${Y}Test 3c: Stop allows after 1 retry (lightweight enforcement)${X}`);

    flag = readFlag();
    assert(flag.userLearningRetries === 1, `userLearningRetries = 1 (got ${flag?.userLearningRetries})`);

    // 2nd stop call — should allow (1-retry max for user learning)
    const stop1b = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(!stop1b.parsed.decision, 'Stop allows after 1 retry (user learning max reached)');

    // Reset for Test 4
    flag = readFlag();
    flag.userLearningPending = true;
    flag.userLearningRetries = 0;
    writeFlag(flag);

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Stop hook blocks once then gives up (1-retry max)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 4: Stop hook blocks once then gives up (lightweight)${X}`);

    const stop2 = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(stop2.parsed.decision === 'block', 'Block on retry 1');

    // After 1 retry, should soft-cleanup and allow
    const stop3 = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(!stop3.parsed.decision, 'No block after 1 retry (allows stop)');

    flag = readFlag();
    assert(flag.userLearningPending === false, 'userLearningPending cleared after soft cleanup');
    assert(flag.userLearningRetries === 0, 'userLearningRetries reset to 0');

    // ═══════════════════════════════════════════════════════════
    // TEST 5: post-remember clears pending on communication-style
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 5: post-remember clears on communication-style remember${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningPending: true, userLearningNudgeCount: 1, userLearningRetries: 0,
    });

    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'communication-style', text: 'User is direct and concise', project: 'global', importance: 6 },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.userLearningPending === false, 'userLearningPending cleared');
    assert(flag.userLearningObserved === true, 'userLearningObserved set after remember');

    // Verify stop hook now allows stop
    const stop5 = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(!stop5.parsed.decision, 'Stop allows after communication-style remember');

    // ═══════════════════════════════════════════════════════════
    // TEST 5b: userLearningObserved skips subsequent nudges
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 5b: userLearningObserved skips subsequent nudges${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningNudgeCount: 1, userLearningPending: false,
      userLearningObserved: true,
      greetingDelivered: true,
    });

    // Message 6 → totalSessionMessages = 6 = 2x threshold(3), but observed=true
    const rObserved = await runHook(PROMPT_SUBMIT, { prompt: 'Show me the sidebar component details please', session_id: TEST_SESSION });
    flag = readFlag();
    assert(flag.userLearningNudgeCount === 1, `nudgeCount stays at 1 (got ${flag?.userLearningNudgeCount})`);
    assert(!flag.userLearningPending, 'No pending set when already observed');
    const ctxObserved = getContext(rObserved);
    assert(!ctxObserved.includes('User Learning'), 'No user learning nudge when already observed');

    // ═══════════════════════════════════════════════════════════
    // TEST 6: post-remember preserves pending on unrelated category
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 6: post-remember preserves pending on unrelated remember${X}`);
    cleanup();

    writeFlag({
      editCount: 3, retries: 0, files: ['test.js'],
      messageCount: 5, totalSessionMessages: 5,
      userLearningPending: true, userLearningNudgeCount: 1, userLearningRetries: 0,
    });

    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'bug-fixes', text: 'Fixed a rendering bug' },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.userLearningPending === true, 'userLearningPending preserved after bug-fixes remember');

    // ═══════════════════════════════════════════════════════════
    // TEST 7: Reflect clears pending when userLearningPending is true
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 7: Reflect clears pending when userLearningPending is true${X}`);
    cleanup();

    // 7a: reflect when pending is true → should clear (Claude is acting on the UL nudge)
    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningPending: true, userLearningNudgeCount: 1, userLearningRetries: 0,
    });

    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__reflect',
      tool_input: { memory_id: 'some-comm-style-uuid', content: 'Updated: user is direct, terse, no greetings' },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.userLearningPending === false, 'Reflect clears pending when userLearningPending is true');
    assert(flag.userLearningObserved === true, 'userLearningObserved set after reflect');

    // ═══════════════════════════════════════════════════════════
    // TEST 7b: Reflect does NOT set observed when pending is false
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 7b: Reflect does NOT set observed when pending is false${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningPending: false, userLearningNudgeCount: 0, userLearningRetries: 0,
    });

    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__reflect',
      tool_input: { memory_id: 'some-unrelated-memory-id', content: 'Refined architecture observation' },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(!flag.userLearningObserved, 'userLearningObserved not set when pending was false');

    // ═══════════════════════════════════════════════════════════
    // TEST 8: personality category also clears pending
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 8: personality category also clears pending${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningPending: true, userLearningNudgeCount: 1, userLearningRetries: 0,
    });

    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'personality', text: 'User prefers dark themes', project: 'global', importance: 5 },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.userLearningPending === false, 'userLearningPending cleared by personality remember');

    // ═══════════════════════════════════════════════════════════
    // TEST 8b: conversations category does NOT clear pending
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 8b: conversations category does NOT clear pending (the original bug)${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningPending: true, userLearningNudgeCount: 1, userLearningRetries: 0,
    });

    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'conversations', text: 'Session summary: user asked about hooks' },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.userLearningPending === true, 'userLearningPending NOT cleared by conversations remember');

    // ═══════════════════════════════════════════════════════════
    // TEST 9: Second nudge fires at next threshold multiple
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 9: Second nudge at 2x threshold${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 5, totalSessionMessages: 5,
      userLearningNudgeCount: 1, userLearningPending: false,
      greetingDelivered: true,
    });

    // Message 6 → totalSessionMessages = 6 = 2x threshold(3)
    const r6 = await runHook(PROMPT_SUBMIT, { prompt: 'Show me how the layout grid works please', session_id: TEST_SESSION });
    flag = readFlag();
    assert(flag.totalSessionMessages === 6, `totalSessionMessages = 6 (got ${flag?.totalSessionMessages})`);
    assert(flag.userLearningNudgeCount === 2, `nudgeCount = 2 (got ${flag?.userLearningNudgeCount})`);
    assert(flag.userLearningPending === true, 'userLearningPending set for 2nd nudge');

    const ctx6 = getContext(r6);
    assert(ctx6.includes('User Learning') || ctx6.includes('communication'), 'Second nudge present in context');

    // ═══════════════════════════════════════════════════════════
    // TEST 10: Max nudges cap (3) prevents further nudges
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 10: Max nudges cap prevents further nudges${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 11, totalSessionMessages: 11,
      userLearningNudgeCount: 3, userLearningPending: false,
      greetingDelivered: true,
    });

    // Message 12 → totalSessionMessages = 12 = 4x threshold(3), but nudgeCount=3 = max
    const r12 = await runHook(PROMPT_SUBMIT, { prompt: 'Explain the animation system in the project', session_id: TEST_SESSION });
    flag = readFlag();
    assert(flag.userLearningNudgeCount === 3, `nudgeCount stays 3 (got ${flag?.userLearningNudgeCount})`);
    assert(!flag.userLearningPending, 'No pending set when max nudges reached');

    // ═══════════════════════════════════════════════════════════
    // TEST 11: Feature disabled → no nudge
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 11: Feature disabled skips nudge entirely${X}`);
    cleanup();

    writeFileSync(HOOK_FEATURES_PATH, JSON.stringify({ ...testFeatures, userLearning: false }));

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 2, totalSessionMessages: 2,
      greetingDelivered: true,
    });

    // Message 3 → would normally fire, but feature is off
    const rOff = await runHook(PROMPT_SUBMIT, { prompt: 'Describe the button styles currently used', session_id: TEST_SESSION });
    flag = readFlag();
    assert(!flag.userLearningPending, 'No nudge when feature disabled');
    assert(!flag.userLearningNudgeCount, 'nudgeCount stays 0 when disabled');

    const ctxOff = getContext(rOff);
    assert(!ctxOff.includes('User Learning'), 'No user learning text in output when disabled');

    // Restore features
    writeFileSync(HOOK_FEATURES_PATH, JSON.stringify(testFeatures));

    // ═══════════════════════════════════════════════════════════
    // TEST 12: softCleanupFlag preserves tracking fields
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 12: softCleanupFlag preserves session tracking${X}`);
    cleanup();

    writeFlag({
      editCount: 0, retries: 0, files: [],
      messageCount: 2, totalSessionMessages: 7,
      totalEdits: 5, greetingDelivered: true, rememberCount: 1,
      userLearningNudgeCount: 2, userLearningPending: false, userLearningRetries: 0,
      userLearningObserved: true,
    });

    // Stop hook with editCount=0 and no blocking conditions → softCleanup runs
    await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    flag = readFlag();
    assert(flag.userLearningNudgeCount === 2, `nudgeCount preserved (got ${flag?.userLearningNudgeCount})`);
    assert(flag.greetingDelivered === true, 'greetingDelivered preserved');
    assert(flag.totalSessionMessages === 7, `totalSessionMessages preserved (got ${flag?.totalSessionMessages})`);
    assert(flag.totalEdits === 5, `totalEdits preserved (got ${flag?.totalEdits})`);
    assert(flag.editCount === 0, `editCount reset to 0 (got ${flag?.editCount})`);
    assert(flag.files.length === 0, 'files array cleared');
    assert(flag.userLearningObserved === true, 'userLearningObserved preserved through softCleanup');

    // ═══════════════════════════════════════════════════════════
    // TEST 13: Full happy path lifecycle
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 13: Full lifecycle — nudge → stop block → remember → clear → allow stop${X}`);
    cleanup();

    // Simulate 3 messages to trigger nudge
    await runHook(PROMPT_SUBMIT, { prompt: 'First message about the project layout', session_id: TEST_SESSION });
    await runHook(PROMPT_SUBMIT, { prompt: 'Second message about the styling approach', session_id: TEST_SESSION });
    const r3full = await runHook(PROMPT_SUBMIT, { prompt: 'Third message explaining the component tree', session_id: TEST_SESSION });

    flag = readFlag();
    assert(flag.userLearningPending === true, 'Lifecycle: nudge fired at message 3');

    // Stop blocks
    const stopBlock = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(stopBlock.parsed.decision === 'block', 'Lifecycle: stop blocks for user learning');

    // Claude calls remember with communication-style
    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'communication-style', text: 'User gives detailed, multi-sentence instructions', project: 'global', importance: 6 },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.userLearningPending === false, 'Lifecycle: pending cleared after remember');

    // Stop now allows
    const stopAllow = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(!stopAllow.parsed.decision, 'Lifecycle: stop allows after user learning complete');

    // ═══════════════════════════════════════════════════════════
    // TEST 14: Edit-heavy session — user learning bundled with task remember
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${Y}Test 14: User learning bundled with task-remember in edit-heavy session${X}`);
    cleanup();

    // Simulate: 3 messages + 3 edits + userLearningPending
    writeFlag({
      editCount: 3, retries: 0, files: ['a.js', 'b.js', 'c.js'],
      messageCount: 3, totalSessionMessages: 3,
      userLearningPending: true, userLearningNudgeCount: 1, userLearningRetries: 0,
      greetingDelivered: true,
    });

    // Stop should block with BOTH obligations bundled in one block
    const stopBundled = await runHook(STOP_HOOK, { session_id: TEST_SESSION });
    assert(stopBundled.parsed.decision === 'block', 'Bundled: blocks with combined obligations');
    const bundledReason = stopBundled.parsed.reason || '';
    assert(bundledReason.includes('Task memory'), 'Bundled: reason includes task memory');
    assert(bundledReason.includes('User learning'), 'Bundled: reason includes user learning');
    assert(bundledReason.includes('communication-style'), 'Bundled: reason mentions communication-style');

    // Claude does task remember → editCount resets, userLearningPending preserved
    await runHook(POST_REMEMBER, {
      session_id: TEST_SESSION,
      tool_name: 'mcp__SynaBun__remember',
      tool_input: { category: 'bug-fixes', text: 'Fixed rendering issues' },
      tool_response: { success: true },
    });

    flag = readFlag();
    assert(flag.editCount === 0, 'Bundled: editCount reset after task remember');
    assert(flag.userLearningPending === true, 'Bundled: userLearningPending still true (needs comm-style remember)');

  } finally {
    cleanup();
    writeFileSync(HOOK_FEATURES_PATH, originalFeatures);
  }

  // Summary
  console.log(`\n${B}Results: ${G}${passed} passed${X}${failed > 0 ? `, ${R}${failed} failed${X}` : ''}${X}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  try { writeFileSync(HOOK_FEATURES_PATH, originalFeatures); } catch { /* ok */ }
  cleanup();
  process.exit(1);
});
