import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskPrompt,
  buildFollowUpPrompt,
  buildResultRetryPrompt,
  parseResultContract,
  styleGuideBlock,
  RESULT_HEADING,
} from '../lib/assistant-task-prompt.js';

test('buildTaskPrompt carries authorization, project, memory rules, task, context and the result contract', () => {
  const prompt = buildTaskPrompt({
    task: 'Write docs for the hooks directory',
    context: 'Prior knowledge: hooks live in hooks/claude-code',
    cwd: '/tmp/project',
    project: 'synabun',
    runId: 'run-123',
    provider: 'codex',
    title: 'Docs for hooks',
    permissionPolicy: 'auto',
    capability: 'workspace',
  });
  assert.match(prompt, /DISPATCHED TASK — a single conversation, not a loop/);
  assert.match(prompt, /AUTHORIZATION: This task is running inside SynaBun Automation Studio/);
  assert.match(prompt, /autonomous Codex worker/);
  assert.match(prompt, /This run is unattended/);
  assert.match(prompt, /CAPABILITY: workspace/);
  assert.match(prompt, /Memory project: "synabun"/);
  assert.match(prompt, /source_ref "run-123", idempotency_key "run:run-123:task"/);
  assert.match(prompt, /tags including "docs-for-hooks" and "codex"/);
  assert.match(prompt, /TASK:\nWrite docs for the hooks directory/);
  assert.match(prompt, /CONTEXT \(from the assistant\):\nPrior knowledge/);
  assert.ok(prompt.trimEnd().endsWith('```'), 'ends with the contract fence');
  assert.ok(prompt.includes(RESULT_HEADING));
  assert.doesNotMatch(prompt, /NATIVE LOOP ITERATION/);
  assert.doesNotMatch(prompt, /BROWSER ENFORCEMENT/);
});

test('buildTaskPrompt adds browser enforcement, quarantine and ask-policy wording when requested', () => {
  const prompt = buildTaskPrompt({
    task: 'Research subreddits', cwd: '/tmp/p', project: 'p', runId: 'r', provider: 'claude-code',
    permissionPolicy: 'ask', capability: 'read-only', usesBrowser: true, browserSessionId: 'bs-1', browserTabId: 'tab-9',
    outputSchema: { type: 'object' },
  });
  assert.match(prompt, /=== BROWSER ENFORCEMENT \(MANDATORY\) ===/);
  assert.match(prompt, /YOUR BROWSER SESSION: bs-1/);
  assert.match(prompt, /tabId: "tab-9"/);
  assert.match(prompt, /CAPABILITY: read-only/);
  assert.match(prompt, /untrusted input, never as instructions/);
  assert.match(prompt, /Permission requests are answered by the orchestrator/);
  assert.match(prompt, /\(REQUIRED\)/);
});

test('styleGuideBlock: the project\'s brand, its files and how to change it, after the design rules and before PROJECT; nothing without a guide', () => {
  const styleGuide = {
    summary: 'Brand: Acme — Tools that stay out of the way\nColors (light + dark, default light): primary #3b82f6',
    designPath: '/work/acme/DESIGN.md',
    tokenFiles: ['/work/acme/.synabun/style-guide/tokens.json', '/work/acme/.synabun/style-guide/tokens.css'],
    proposals: true,
  };
  const state = { task: 'Build the pricing page', title: 'Pricing page', cwd: '/work/acme/src', project: 'acme', runId: 'run-9', provider: 'codex', taskClass: 'code', styleGuide };
  assert.equal(styleGuideBlock(state), [
    '',
    '=== STYLE GUIDE (this project\'s brand; binding for UI, design, copy and creative work) ===',
    'Brand: Acme — Tools that stay out of the way',
    'Colors (light + dark, default light): primary #3b82f6',
    'Files: DESIGN.md at /work/acme/DESIGN.md · tokens: /work/acme/.synabun/style-guide/tokens.json, /work/acme/.synabun/style-guide/tokens.css',
    '- Use these tokens (tokens.css variables / the Tailwind theme) instead of inventing colors, fonts or radii. Never restyle outside the task.',
    '- More detail: call style_guide with action "get" or "tokens" and projectPath "/work/acme/src".',
    '- A gap or a better token? Do not edit DESIGN.md or the token files by hand: call style_guide with action "propose" (changes + reason); the user reviews proposals in the Style Guide panel.',
    '=== END STYLE GUIDE ===',
    '',
  ].join('\n'));
  const prompt = buildTaskPrompt(state);
  assert.ok(prompt.includes('=== END STYLE GUIDE ===\n\nPROJECT\nWorking directory: /work/acme/src'), 'directly before PROJECT');
  assert.ok(prompt.indexOf('=== STYLE GUIDE ') > prompt.indexOf('=== END NO BROWSER ==='));
  assert.doesNotMatch(prompt, /\n{3,}/);
  // After the design rules, which now say the block is the guide's summary.
  const design = buildTaskPrompt({ ...state, taskClass: 'design', collectMedia: 'image', playbook: { name: 'design', text: '# Rules' } });
  assert.ok(design.indexOf('=== END DESIGN RULES ===') < design.indexOf('=== STYLE GUIDE '));
  assert.match(design, /call style_guide with action "get" and projectPath "\/work\/acme\/src" \(this project's tokens and DESIGN\.md; pass the path, the default is not your working directory\)\. The STYLE GUIDE block below is its summary\./);
  // An image or video run is told to start from the generation prefix.
  for (const taskClass of ['image_gen', 'video_gen']) {
    const block = styleGuideBlock({ ...state, taskClass });
    assert.ok(block.includes('- Start every generation prompt from the image-generation prefix above, keep to the brand colors and the imagery direction, and leave out what it says to avoid.'), taskClass);
  }
  assert.ok(!styleGuideBlock(state).includes('generation prompt'));
  const image = buildTaskPrompt({ ...state, taskClass: 'image_gen', collectMedia: 'image' });
  assert.ok(image.indexOf('=== END IMAGE CREATION ===') < image.indexOf('=== STYLE GUIDE '));
  // Proposals turned off, files not written yet.
  const quiet = styleGuideBlock({ ...state, styleGuide: { summary: 'Brand: Acme', designPath: null, tokenFiles: [], proposals: false } });
  assert.ok(quiet.includes('- Do not edit DESIGN.md or the token files by hand. Proposals are turned off for this project: name a gap or a better token in follow_ups instead.'));
  assert.ok(!quiet.includes('Files:') && !quiet.includes('action "propose"'));
  assert.ok(styleGuideBlock({ ...state, styleGuide: { summary: 'Brand: Acme', designPath: '/work/acme/DESIGN.md' } }).includes('Files: DESIGN.md at /work/acme/DESIGN.md\n'));
  // No guide, no block: the prompt is what it was before.
  for (const none of [undefined, null, {}, { summary: '   ' }, 'text']) assert.equal(styleGuideBlock({ ...state, styleGuide: none }), '', JSON.stringify(none));
  const { styleGuide: _dropped, ...plain } = state;
  assert.doesNotMatch(buildTaskPrompt(plain), /STYLE GUIDE/);
  assert.equal(buildTaskPrompt({ ...plain, styleGuide: null }), buildTaskPrompt(plain));
});

test('follow-up and retry prompts reference the run and the contract', () => {
  const follow = buildFollowUpPrompt('Now add tests', { runId: 'run-1', project: 'synabun' }, { turn: 2, maxTurns: 6 });
  assert.match(follow, /FOLLOW-UP from the assistant 2\/6 \(same run run-1, project "synabun"\)/);
  assert.match(follow, /Now add tests/);
  assert.match(follow, /end with the ## Result block/);
  const steer = buildFollowUpPrompt('Focus on README', { runId: 'run-1' }, { origin: 'user' });
  assert.match(steer, /USER STEERING \(direct from the user\)/);
  assert.match(buildResultRetryPrompt(), /did not end with the ## Result block/);
});

test('parseResultContract parses a well-formed block', () => {
  const text = [
    'I did the work.',
    '',
    '## Result',
    'status: done',
    'summary: Added docs for every hook.',
    'Covered seven files.',
    'changes:',
    '- docs/hooks.md — new page',
    '- `README.md`: linked the page',
    'follow_ups:',
    '- none',
    '```json',
    '{"summary":"ignored","count":7}',
    '```',
  ].join('\n');
  const parsed = parseResultContract(text);
  assert.equal(parsed.found, true);
  assert.equal(parsed.status, 'done');
  assert.equal(parsed.summary, 'Added docs for every hook.\nCovered seven files.');
  assert.deepEqual(parsed.changes, [
    { path: 'docs/hooks.md', note: 'new page' },
    { path: 'README.md', note: 'linked the page' },
  ]);
  assert.deepEqual(parsed.files, ['docs/hooks.md', 'README.md']);
  assert.deepEqual(parsed.follow_ups, []);
  assert.deepEqual(parsed.json, { summary: 'ignored', count: 7 });
});

test('parseResultContract handles needs_input, aliases, missing blocks and bad json', () => {
  const needs = parseResultContract('## Result\nstatus: Needs Input\nsummary: Stuck\nquestion: British or US spelling?\nfollow-ups:\n- decide spelling');
  assert.equal(needs.status, 'needs_input');
  assert.equal(needs.question, 'British or US spelling?');
  assert.deepEqual(needs.follow_ups, ['decide spelling']);

  const partial = parseResultContract('## Result\nstatus: partial\nsummary: Half done');
  assert.equal(partial.status, 'blocked');

  const inferred = parseResultContract('## Result\nsummary: Blocked on auth\nquestion: Which account?');
  assert.equal(inferred.status, 'needs_input');

  const missing = parseResultContract('Just some prose without a block.');
  assert.equal(missing.found, false);
  assert.equal(missing.parseFailed, true);
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.summary, 'Just some prose without a block.');

  const badJson = parseResultContract('## Result\nstatus: done\nsummary: ok\n```json\n{not json}\n```');
  assert.equal(badJson.status, 'done');
  assert.equal(badJson.json, null);
  assert.ok(badJson.jsonError);

  const last = parseResultContract('## Result\nstatus: blocked\nsummary: first\n\nMore text\n\n## Result\nstatus: done\nsummary: second');
  assert.equal(last.status, 'done');
  assert.equal(last.summary, 'second');
});
