// ═══════════════════════════════════════════
// Dev gallery — the cards the mascot presents, every style and state
// ═══════════════════════════════════════════
// Not linked from the product. Each tile is one panel: the real renderer
// (asst-render.js), the panel's mascot director (asst-mascot.js) and the rig
// (synabun-mascot.js), fed the events a session would send. What a click sends
// is written under its tile: the next message for a follow-up, the answer
// payload (buildControlResponse) for a question card. ?freeze=1 stops the
// shared ticker 1.6 s after load (body.ui-interacting, as a drag does), for
// captures; ?reduced=1 is prefers-reduced-motion as the panel reads it.

import { initI18n, t } from '/shared/i18n.js';
import { injectAssistantStyles } from '/shared/assistant/asst-styles.js';
import { createRenderer } from '/shared/assistant/asst-render.js';
import { createMascotDirector } from '/shared/assistant/asst-mascot.js';
import { buildControlResponse, normalizeControlRequest, renderControlCard } from '/shared/assistant/asst-control.js';
import { getProviderMeta } from '/shared/provider-icons.js';
import { paintMascot, poseFrame, reactionFrame } from '/shared/synabun-mascot.js';

const params = new URLSearchParams(location.search);
const LANG = params.get('lang') === 'pt-BR' ? 'pt-BR' : 'en';
const FREEZE = params.has('freeze');
const REDUCED = params.has('reduced');
const FREEZE_AFTER_MS = 1600;
// ?only=next,question,cards…: just those sections (next, decisions, confirm, question, older, cards, live, narrow, wide).
const ONLY = new Set(String(params.get('only') || '').split(',').map((s) => s.trim()).filter(Boolean));
const want = (key) => !ONLY.size || ONLY.has(key);

await initI18n(LANG);
injectAssistantStyles();

const flags = document.getElementById('g-flags');
for (const [label, on] of [[`lang ${LANG}`, true], ['freeze', FREEZE], ['reduced motion', REDUCED]]) {
  const flag = document.createElement('span');
  flag.className = 'g-flag';
  flag.dataset.on = on ? '1' : '0';
  flag.textContent = label;
  flags.appendChild(flag);
}

const main = document.getElementById('gallery');
const later = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function section(title, note) {
  const box = document.createElement('section');
  box.className = 'g-section';
  box.innerHTML = '<h2></h2><p></p><div class="g-grid"></div>';
  box.querySelector('h2').textContent = title;
  box.querySelector('p').textContent = note;
  main.appendChild(box);
  return box.querySelector('.g-grid');
}

let msgSeq = 0;

/** One panel: a renderer, its director, and a log line for what it sends. */
function tile(grid, { title, state, note = '', width = 0 }) {
  const box = document.createElement('section');
  box.className = 'g-tile';
  if (width) box.style.width = `${width}px`;
  box.innerHTML = '<header><h3></h3><span class="g-state"></span><p class="g-note"></p></header>'
    + '<div class="asst-root g-panel"><div class="asst-transcript" role="log" aria-live="off"></div></div>'
    + '<output class="g-log"></output>';
  box.querySelector('h3').textContent = title;
  box.querySelector('.g-state').textContent = state;
  box.querySelector('.g-note').textContent = note;
  box.dataset.state = state;
  grid.appendChild(box);
  const log = box.querySelector('.g-log');
  const say = (line) => { log.textContent = log.textContent ? `${log.textContent}\n${line}` : line; };
  let director = null;
  const renderer = createRenderer(box.querySelector('.asst-transcript'), {
    t,
    providerIcon: (p) => getProviderMeta(p).icon,
    providerColor: (p) => getProviderMeta(p).color,
    onMascotChange: () => director?.retarget(),
    // What the panel does with a click: the text goes out as the user's next message, and a turn starts.
    onFollowup: (text) => {
      say(`next message: ${JSON.stringify(text)}`);
      renderer.appendUser(text);
      director?.sent();
      renderer.showWorking();
    },
    onFollowupOther: () => say('→ composer'),
  });
  director = createMascotDirector({ getTarget: () => renderer.mascot() });
  return { box, renderer, director, say };
}

const fence = (data) => `\n\n\`\`\`synabun-followups\n${JSON.stringify(data)}\n\`\`\``;
const assistantEvent = (text) => ({ type: 'assistant', message: { id: `msg_g${(msgSeq += 1)}`, role: 'assistant', content: [{ type: 'text', text }] } });

/** A turn: the prompt, the working row, the reply (its block becomes the card), the turn's end. */
function turn(p, prompt, reply) {
  p.renderer.appendUser(prompt);
  p.renderer.showWorking();
  p.renderer.handleEvent(assistantEvent(reply));
  p.renderer.handleEvent({ type: 'result', subtype: 'success', is_error: false, result: reply });
  p.renderer.finishTurn();
}

/** The same conversation drawn from the journal (a reload): the renderer's own replay path. */
function restore(p, entries) {
  p.renderer.renderTranscript(entries.map(([kind, text]) => (kind === 'user'
    ? { type: 'event', event: { type: 'synabun.user_prompt', text } }
    : { type: 'event', event: assistantEvent(text) })));
}

/** A question card as the panel shows one (showControl): normalized, drawn, appended, its wait on the director. */
function ask(p, packet, origin = null) {
  const n = normalizeControlRequest({ ...packet, provider: packet.provider || origin?.provider || 'claude-code' }, { origin });
  const entry = renderControlCard(null, n, {
    t,
    md: p.renderer.md,
    providerIcon: (x) => getProviderMeta(x).icon,
    scrollEnd: () => {},
    focusComposer: () => p.say('→ composer'),
    onRespond: (normalized, decision) => {
      p.say(`answer payload: ${JSON.stringify(buildControlResponse(normalized, decision))}`);
      p.director.setBlocked(null);
    },
  });
  p.renderer.hideWorking();
  p.renderer.appendNode(entry.el);
  p.director.setBlocked(() => entry.el.getBoundingClientRect());
  return entry;
}

const cardOf = (p) => [...p.box.querySelectorAll('.asst-followups')].pop();
const optionsOf = (node) => [...node.querySelectorAll('[data-ask-option]')];
/** The mascot's eyes on an option, as a pointer over it puts them (the CSS :hover itself needs a real pointer). */
const pointAt = (node) => node?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));

/**
 * Hold a sent card in its sending beat, the face at the top of its hop (the rig's own reactionFrame), for a
 * still capture: applied once the card's own beat (340 ms) is over, which would otherwise fold it.
 */
function holdSending(p, pose, opts = {}) {
  later.push(() => setTimeout(() => {
    const card = cardOf(p);
    if (!card) return;
    card.dataset.phase = 'sending';
    const svg = card.querySelector('.asst-ask-face svg');
    if (svg) paintMascot(svg, reactionFrame(poseFrame(pose, 0, opts), 'hop', 0.3));
  }, 420));
}

// ── Content: what a session would say ──
const NEXT = {
  prompt: 'Bump the version and get 1.4.0 ready to ship.',
  lead: 'Version 1.4.0 is staged: package.json, the changelog and the shrinkwrap are updated, and the release tests pass.',
  block: { items: [
    { label: 'Publish to npm', send: 'Publish 1.4.0 to npm now', description: 'Tags v1.4.0, then runs npm publish' },
    { label: 'Draft release notes', send: 'Draft the GitHub release notes for 1.4.0' },
    { label: 'Run the browser tests', send: 'Run the assistant browser tests before publishing' },
  ] },
};
const DECISIONS = {
  prompt: 'Run an accessibility pass on the Assistant panel.',
  lead: 'The pass found four independent fixes, each a small diff. Pick the ones to apply now; the rest stay in the report.',
  block: { style: 'decisions', title: 'Pick the fixes to apply now', items: [
    { label: 'Focus ring on chips', send: 'Fix the missing focus ring on the toolbar chips' },
    { label: 'Muted text contrast', send: 'Raise the muted text in the run cards to AA contrast', description: '4.1:1 today, 4.5:1 needed' },
    { label: 'Icon button labels', send: 'Add accessible names to the icon-only buttons' },
    { label: 'Reduced-motion stills', send: 'Give the scenes a still frame under reduced motion' },
  ] },
};
const CONFIRM = {
  prompt: 'Clean up the session index.',
  lead: 'The cleanup found 1,284 session chunks older than 90 days that no memory points to.',
  block: { style: 'confirm', title: 'Delete 1,284 old session chunks?', items: [
    { label: 'Delete them', send: 'Delete the 1,284 session chunks older than 90 days', description: 'Frees about 210 MB. They skip the trash.' },
  ] },
};
const QUESTION = {
  prompt: 'Start the new usage API.',
  lead: 'Both stores fit the new API; the choice changes the migration and how backups work.',
  block: { style: 'question', question: 'Which database should the new API use?', items: [
    { label: 'Postgres', send: 'Use Postgres for the new API', description: 'The other services already run on it', recommended: true },
    { label: 'SQLite', send: 'Use SQLite for the new API', description: 'One file, one writer at a time' },
    { label: 'DuckDB', send: 'Use DuckDB for the new API', description: 'Fast analytics, younger tooling' },
  ] },
};
const STYLES = [['Next steps', NEXT, 'present'], ['Decisions', DECISIONS, 'pick'], ['Confirm', CONFIRM, 'present'], ['Question', QUESTION, 'ask']];

const CLARIFY = {
  type: 'control_request', request_id: 'g-clarify',
  request: {
    subtype: 'clarify', kind: 'clarify', provider: 'synabun', briefId: 'brief-g1', summary: 'Add dark mode to the dashboard',
    questions: [
      { id: 'scope', header: 'Scope', question: 'Where should dark mode apply?', options: [{ label: 'Whole app', description: 'Every page and panel' }, { label: 'Dashboard only' }] },
      { id: 'q2', header: 'Theme source', question: 'What decides the theme?', options: [{ label: 'Follow the OS' }, { label: 'A manual toggle' }, { label: 'Both' }] },
    ],
    assumptions: ['Use the existing CSS variables', 'No new dependencies'],
  },
};
const ASK_USER = {
  type: 'control_request', request_id: 'g-askuser',
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
    { question: 'Which part of the release should I check first?', header: 'Release check', multiSelect: false, options: [{ label: 'The changelog (Recommended)', description: 'It ships to npm as written' }, { label: 'The version bump' }, { label: 'The shrinkwrap' }] },
    { question: 'Which test suites should run before the tag?', header: 'Suites', multiSelect: true, options: [{ label: 'Assistant unit tests' }, { label: 'Browser tests' }, { label: 'MCP server tests' }] },
  ] } },
};
const CHOICE = {
  request_id: 'g-choice', provider: 'codex',
  request: { method: 'mcpServer/elicitation/request', params: {
    serverName: 'SynaBun',
    message: `[SYNABUN_CHOICE_V1]${JSON.stringify({ questions: [{ id: 'deploy', header: 'Preview', question: 'Where should the preview deploy go?', options: [{ label: 'Staging', description: 'Shared with the team' }, { label: 'My sandbox', description: 'Only you see it' }] }] })}`,
    requestedSchema: { type: 'object', properties: { deploy: { type: 'string', enum: ['Staging', 'My sandbox', '__synabun_other__'] }, deploy__other: { type: 'string' } } },
  } },
};
const OPENCODE = {
  request_id: 'g-opencode', provider: 'opencode',
  request: { kind: 'question', questions: [{ question: 'Which test runner should the new package use?', header: 'Tests', options: [{ label: 'node --test', description: 'Built in, like the rest of the repo' }, { label: 'vitest' }] }] },
};

// ── Follow-ups: every style × state ──
for (const [name, spec, pose] of STYLES) {
  if (!want(name.toLowerCase().replace(/\s+steps$/, ''))) continue;
  const grid = section(`${name}`, {
    'Next steps': '1-4 quick actions the mascot presents (pose present): one click, Enter or its number sends one.',
    Decisions: 'Independent picks (pose pick: the clipboard ticks a box per pick, with a pop): one Send, or ⌘/Ctrl+Enter.',
    Confirm: 'One proposed action (pose present, eyes on the primary): Enter takes it; Not now is a message too.',
    Question: 'The mascot asks (pose ask, the question mark): radios, the recommended one badged, or a typed answer; Enter sends.',
  }[name]);
  const text = spec.lead + fence(spec.block);

  const live = tile(grid, { title: name, state: 'live', note: 'The newest open card: its face is the panel\'s live rig.' });
  turn(live, spec.prompt, text);

  const looking = tile(grid, { title: name, state: 'hover / focus', note: name === 'Question' ? 'Option 2 has keyboard focus: the ring, the keys line, the eyes on it.' : 'A pointer over the second answer: the eyes follow it.' });
  turn(looking, spec.prompt, text);
  later.push(() => {
    const target = optionsOf(cardOf(looking))[1];
    if (name === 'Question') target?.focus();
    else pointAt(target);
  });

  if (name === 'Decisions' || name === 'Question') {
    const picking = tile(grid, { title: name, state: 'selected', note: name === 'Decisions' ? 'Two ticked: gold rows, ✓ keys, two ticks on the clipboard, Send 2 selected.' : 'SQLite picked (a nod); Send is armed, nothing sent yet.' });
    turn(picking, spec.prompt, text);
    const opts = optionsOf(cardOf(picking));
    if (name === 'Decisions') { opts[0]?.click(); opts[2]?.click(); } else opts[1]?.click();
  }

  const sending = tile(grid, { title: name, state: 'sending', note: REDUCED
    ? 'Under reduced motion there is no beat: the card folds at once and the "Thinking" row takes over.'
    : 'Right after the click: the pick in gold, the mascot at the top of its hop; then the "Thinking" row takes over.' });
  turn(sending, spec.prompt, text);
  later.push(() => {
    const card = cardOf(sending);
    const opts = optionsOf(card);
    if (name === 'Decisions') { opts[0]?.click(); opts[1]?.click(); card.querySelector('.asst-ask-send')?.click(); }
    else if (name === 'Question') { opts[0]?.click(); card.querySelector('.asst-ask-send')?.click(); }
    else opts[0]?.click();
  });
  if (!REDUCED) holdSending(sending, pose, pose === 'pick' ? { ticks: 2, look: { x: 0.5, y: 0.25 } } : { look: { x: 0.5, y: 0.35 } });

  const answered = tile(grid, { title: name, state: 'answered', note: 'Folded into one line: the "got it" face and what was chosen.' });
  turn(answered, spec.prompt, text);
  {
    const card = cardOf(answered);
    const opts = optionsOf(card);
    if (name === 'Decisions') { opts[1]?.click(); opts[3]?.click(); card.querySelector('.asst-ask-send')?.click(); }
    else if (name === 'Question') {
      const field = card.querySelector('.asst-ask-input');
      field.value = 'Postgres, on the shared cluster';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else if (name === 'Confirm') card.querySelector('.asst-ask-hold')?.click();
    else opts[1]?.click();
  }

  const stale = tile(grid, { title: name, state: 'stale', note: name === 'Question'
    ? 'A new turn began before an answer (a worker reported back): a dim still, nothing clicks. (Anything the user types next answers a question.)'
    : 'A new turn began (here a worker reported back); a prompt that is none of its items does the same: a dim still, nothing clicks.' });
  turn(stale, spec.prompt, text);
  stale.renderer.showWorking();
  stale.renderer.handleEvent(assistantEvent('Run #2 finished: the CI run is green, 412 tests passed.'));
  stale.renderer.finishTurn();

  const restored = tile(grid, { title: name, state: 'restored', note: 'Drawn from the journal after a reload: the same states, read from the next prompt.' });
  const reply = name === 'Decisions' ? '- Fix the missing focus ring on the toolbar chips\n- Add accessible names to the icon-only buttons'
    : name === 'Question' ? 'SQLite for now, we can move later'
      : name === 'Confirm' ? 'Delete the 1,284 session chunks older than 90 days'
        : 'Draft the GitHub release notes for 1.4.0';
  restore(restored, [['user', spec.prompt], ['assistant', text], ['user', reply]]);
}

// ── Older blocks and prose ──
if (want('older')) {
  const grid = section('Older blocks and prose', 'A block without "style" draws as it always did: multi → decisions, else next steps. A reply with no block but an offer in its last sentence gets a guessed card (a confirm for "Want me to …?").');
  const multi = tile(grid, { title: 'Old block, multi: true', state: 'live → decisions' });
  turn(multi, 'What is left before the release?', `Three things are independent of each other.${fence({ multi: true, title: 'Pick any to run next', items: [{ label: 'Commit the fix', send: 'Commit the parser fix on its own' }, { label: 'Update the changelog', send: 'Add the parser fix to CHANGELOG.md' }, { label: 'Run the tests', send: 'Run the assistant test files' }] })}`);
  const single = tile(grid, { title: 'Old block, multi: false', state: 'live → next steps' });
  turn(single, 'Research hit the Codex limit, right?', `It did: Codex is limited until 06:01.${fence({ multi: false, items: [{ label: 'Re-run on Claude', send: 'Re-run the research task on Claude now', description: 'Codex is limited until 06:01' }, { label: 'Wait for the reset', send: 'Re-run the research task on Codex after its limit resets' }] })}`);
  const guessed = tile(grid, { title: 'Prose offer (guessed)', state: 'live → confirm', note: 'Read from the reply\'s last sentence; the card says so in its tooltip.' });
  turn(guessed, 'Why does the retry test flake?', 'Fixed the flaky retry test: its timer now uses the fake clock, and 50 runs in a row pass. Want me to open a PR for it?');
}

// ── Question cards ──
if (want('cards')) {
  const grid = section('Question cards (agent_clarify, AskUserQuestion, Codex choice, OpenCode question)', 'The same mascot asks: its face beside its first bubble (pose ask), the questions in its bubbles, numbered rows. The protocols are untouched: the payload each sends is logged under its tile.');
  const clarify = tile(grid, { title: 'agent_clarify', state: 'live' });
  clarify.renderer.appendUser('Add dark mode.');
  ask(clarify, CLARIFY);

  const clarifyPicked = tile(grid, { title: 'agent_clarify', state: 'selected', note: 'Both questions answered: Submit is armed.' });
  clarifyPicked.renderer.appendUser('Add dark mode.');
  const picked = ask(clarifyPicked, CLARIFY);
  later.push(() => { const rows = optionsOf(picked.el); rows[0]?.click(); rows[4]?.click(); pointAt(rows[4]); });

  const clarifyDone = tile(grid, { title: 'agent_clarify', state: 'answered', note: 'Submit: the picks stay, the rest folds; the "got it" face.' });
  clarifyDone.renderer.appendUser('Add dark mode.');
  const done = ask(clarifyDone, CLARIFY);
  { const rows = optionsOf(done.el); rows[1]?.click(); rows[2]?.click(); done.el.querySelector('[data-action="submit"]')?.click(); }

  const clarifySkipped = tile(grid, { title: 'agent_clarify', state: 'skipped', note: 'Skip: the brain goes on its assumptions; a dim still.' });
  clarifySkipped.renderer.appendUser('Add dark mode.');
  const skipped = ask(clarifySkipped, CLARIFY);
  skipped.el.querySelector('[data-action="skip"]')?.click();

  const askUser = tile(grid, { title: 'AskUserQuestion (Claude)', state: 'live', note: 'Two questions, a "(Recommended)" label shown as a badge (the answer keeps the label as written).' });
  askUser.renderer.appendUser('Get 1.4.0 ready.');
  ask(askUser, ASK_USER);

  const askUserDone = tile(grid, { title: 'AskUserQuestion (Claude)', state: 'answered' });
  askUserDone.renderer.appendUser('Get 1.4.0 ready.');
  const answeredAsk = ask(askUserDone, ASK_USER);
  { const rows = optionsOf(answeredAsk.el); rows[0]?.click(); rows[3]?.click(); rows[4]?.click(); answeredAsk.el.querySelector('[data-action="submit"]')?.click(); }

  const choice = tile(grid, { title: 'choice (Codex elicitation)', state: 'live' });
  choice.renderer.appendUser('Deploy the preview.');
  ask(choice, CHOICE);

  const choiceDone = tile(grid, { title: 'choice (Codex elicitation)', state: 'answered', note: 'A typed answer: the schema\'s "other" field carries it.' });
  choiceDone.renderer.appendUser('Deploy the preview.');
  const typedChoice = ask(choiceDone, CHOICE);
  {
    const field = typedChoice.el.querySelector('.asst-ask-input');
    field.value = 'The demo box';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    typedChoice.el.querySelector('[data-action="submit"]')?.click();
  }

  const opencode = tile(grid, { title: 'question (OpenCode)', state: 'live' });
  opencode.renderer.appendUser('Scaffold the package.');
  ask(opencode, OPENCODE);

  const declined = tile(grid, { title: 'question (OpenCode)', state: 'declined' });
  declined.renderer.appendUser('Scaffold the package.');
  ask(declined, OPENCODE).el.querySelector('[data-action="decline"]')?.click();

  const relayed = tile(grid, { title: 'A worker\'s question, relayed', state: 'live', note: 'needs_input from a dispatched run reaches the panel as its card, with where it came from.' });
  relayed.renderer.appendUser('Ship the docs site.');
  ask(relayed, { ...ASK_USER, request_id: 'g-relayed', request: { ...ASK_USER.request, input: { questions: [ASK_USER.request.input.questions[0]] } } }, { runId: 'r7f3a9c21e04', provider: 'claude-code' });

  const cancelled = tile(grid, { title: 'AskUserQuestion (Claude)', state: 'cancelled', note: 'Closed by the server (a newer message): a dim still, nothing to press.' });
  cancelled.renderer.appendUser('Get 1.4.0 ready.');
  ask(cancelled, { ...ASK_USER, request_id: 'g-cancelled' }).lock(t('assistant.control.state.cancelled', 'Cancelled'));
}

// ── One live card per panel ──
if (want('live')) {
  const grid = section('One live card per panel', 'Two open cards in one transcript: only the newest is a rig; the older one keeps a painted still until it is the newest again.');
  const both = tile(grid, { title: 'Follow-ups, then a question card', state: 'two open' });
  turn(both, NEXT.prompt, NEXT.lead + fence(NEXT.block));
  ask(both, OPENCODE);
}

// ── Narrow panels ──
if (want('narrow')) {
  const grid = section('Narrow panels', 'The sidepanel at 320 and 360 px: a smaller mascot in a narrower column (≤400 px), smaller still at ≤320 px.');
  grid.classList.add('fixed');
  for (const width of [320, 360]) {
    const q = tile(grid, { title: 'Question', state: `${width} px`, width });
    turn(q, QUESTION.prompt, QUESTION.lead + fence(QUESTION.block));
    const c = tile(grid, { title: 'agent_clarify', state: `${width} px`, width });
    c.renderer.appendUser('Add dark mode.');
    ask(c, CLARIFY);
  }
}

// ── The terminal tab ──
if (want('wide')) {
  const grid = section('The terminal tab', 'One panel the width of the page, as the terminal-tab host gives it (the transcript column is at most 860 px; a follow-ups card at most 560 px).');
  grid.classList.add('single');
  const q = tile(grid, { title: 'Question', state: 'live, full width' });
  turn(q, QUESTION.prompt, QUESTION.lead + fence(QUESTION.block));
  const d = tile(grid, { title: 'Decisions', state: 'selected, full width' });
  turn(d, DECISIONS.prompt, DECISIONS.lead + fence(DECISIONS.block));
  { const rows = optionsOf(cardOf(d)); rows[0]?.click(); rows[3]?.click(); }
  const c = tile(grid, { title: 'AskUserQuestion (Claude)', state: 'live, full width' });
  c.renderer.appendUser('Get 1.4.0 ready.');
  ask(c, { ...ASK_USER, request_id: 'g-wide' });
}

// Interactions that need the page laid out, then (for captures) the ticker stops, as a drag stops it.
await wait(450);
for (const fn of later) { try { fn(); } catch (err) { console.warn('[gallery]', err); } }
if (FREEZE) {
  await wait(FREEZE_AFTER_MS);
  document.body.classList.add('ui-interacting');
  const note = document.createElement('div');
  note.className = 'g-frozen';
  note.setAttribute('aria-hidden', 'true');
  note.textContent = 'frozen for capture';
  document.body.appendChild(note);
}
window.galleryReady = true;
