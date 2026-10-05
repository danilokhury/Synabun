import test from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniElement } from './fixtures/mini-dom.mjs';
import { renderDiffView, renderReadableOutput, cleanOutputBlocks, restoreDiffViews, updateOverflowNote } from '../public/shared/cdx/cdx-output.js';
import { parseUnifiedDiff, fileChangeDiffs } from '../public/shared/cdx/cdx-output-model.js';

// Local stand-in additions used by these presentation tests only.
MiniElement.prototype.replaceChildren = function (...nodes) { this.textContent = ''; this.append(...nodes); };
MiniElement.prototype.contains = function (node) { return this === node || this.all.includes(node); };
const priorStorage = globalThis.sessionStorage;
globalThis.sessionStorage = { getItem: () => 'output-test' };
const render = await import('../public/shared/cdx/cdx-render.js');
if (priorStorage === undefined) delete globalThis.sessionStorage;
else globalThis.sessionStorage = priorStorage;
const dom = installMiniDom();
test.after(() => dom.restore());
const patch = '@@ -1,2 +1,2 @@\n-old\n+new <script>unsafe</script>\n context';

test('diff deltas reuse files and line nodes, retain a user collapse, and render text without HTML', () => {
  const view = document.createElement('div');
  const files = fileChangeDiffs({changes:[{path:'app.js',kind:'update',diff:patch}]});
  renderDiffView(view, files);
  const details = view.querySelector('.cxp-diff-file');
  const row = view.querySelector('.cxp-diff-line');
  assert.equal(details.open, true);
  assert.equal(view.querySelectorAll('script').length, 0);
  assert.match(view.textContent, /<script>unsafe<\/script>/);
  details.open = false;
  renderDiffView(view, fileChangeDiffs({changes:[{path:'app.js',kind:'update',diff:patch.replace('+new', '+updated')}]}));
  assert.equal(view.querySelector('.cxp-diff-file'), details);
  assert.equal(view.querySelector('.cxp-diff-line'), row);
  assert.equal(details.open, false);
  assert.match(view.textContent, /updated/);
});

test('many files default to five open; long diffs have a preview and explicit full control', () => {
  const view = document.createElement('div');
  renderDiffView(view, fileChangeDiffs({changes:Array.from({length:7}, (_, i) => ({path:'file-' + i,kind:'update',diff:i ? patch : '@@ -0,0 +1,100 @@\n' + '+line\n'.repeat(100)}))}));
  assert.deepEqual(view.querySelectorAll('.cxp-diff-file').map(el => el.open), [true,true,true,true,true,false,false]);
  const first = view.querySelector('.cxp-diff-file');
  assert.equal(first.querySelectorAll('.cxp-diff-line').length, 60);
  const more = first.querySelector('button');
  assert.match(more.textContent, /Show full diff \(101 lines\)/);
  more.click();
  assert.equal(first.querySelectorAll('.cxp-diff-line').length, 101);
});

test('restored normalized diff source produces one file, keeping collapse and safe rows', () => {
  const parent = document.createElement('div'); const view = document.createElement('div'); parent.append(view);
  renderDiffView(view, parseUnifiedDiff('diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n' + patch));
  view.querySelector('.cxp-diff-file').open = false;
  restoreDiffViews(parent);
  assert.equal(view.querySelectorAll('.cxp-diff-file').length, 1);
  assert.equal(view.querySelector('.cxp-diff-file').open, false);
});

test('terminal cleanup never ingests Copy button labels on repeated observation passes', () => {
  const container = document.createElement('div'); const pre = document.createElement('pre'); const code = document.createElement('code');
  pre.className = 'cxp-card-pre'; code.textContent = '\u001b[32mready\u001b[0m'; pre.append(code); container.append(pre);
  cleanOutputBlocks(container);
  const button = document.createElement('button'); button.className = 'cxp-copy-btn'; button.textContent = 'Copy'; pre.append(button);
  for (let i = 0; i < 100; i++) cleanOutputBlocks(container);
  assert.equal(code.textContent, 'ready');
  assert.equal(pre.textContent, 'readyCopy');
});

test('streaming JSON remains preformatted, then becomes structured with original source retained', () => {
  const container = document.createElement('div');
  assert.equal(renderReadableOutput(container, '{\n  "ok":', {streaming:true}), true);
  assert.equal(container.querySelector('.cxp-readable'), null);
  assert.equal(container.querySelector('code').textContent, '{\n  "ok":');
  const original = '{"ok":true,"empty":"","none":null,"list":[1,2]}';
  renderReadableOutput(container, original);
  assert.equal(container.querySelector('.cxp-readable').dataset.original, original);
  assert.match(container.textContent, /true/);
  assert.match(container.textContent, /null/);
  assert.match(container.textContent, /""/);
  const root = container.firstElementChild;
  renderReadableOutput(container, original);
  assert.equal(container.firstElementChild, root, 'unchanged output is not rebuilt');
});

test('turn diffs omit matching item patches, retain shell edits, and reuse a restored turn card', () => {
  const messagesEl = document.createElement('div');
  const items = new Map();
  const tab = { id: 'tab', messagesEl, latestTurnDiff: null };
  render.setRenderContext({
    items, messagesEl, boundTab: tab, threadId: 'thread', activeTurnId: 'turn-a',
    hideEmpty() {}, pruneTranscriptDom() {}, repositionThinking() {}, setTranscriptSourceMeta() {},
    scheduleThreadSnapshotSave() {}, saveTabs() {}, scrollEnd() {},
    itemOwnershipBelongsToBoundThread: () => true, formatStatus: status => status,
    itemHeadline: item => ({detail:item.type}),
  });
  render.updateItemFromData({id:'edit',type:'fileChange',status:'completed',changes:[{path:'app.js',kind:'update',diff:patch}]});
  const diff = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n' + patch + '\ndiff --git a/shell.js b/shell.js\n--- a/shell.js\n+++ b/shell.js\n@@ -1 +1 @@\n-before\n+after';
  render.renderTurnDiff('turn-a', diff);
  const aggregate = items.get('turn-diff:turn-a');
  assert.equal(aggregate.diffFiles.length, 1);
  assert.equal(aggregate.diffFiles[0].path, 'shell.js');
  const card = aggregate.el;
  items.clear();
  render.renderTurnDiff('turn-a', diff);
  assert.equal(items.get('turn-diff:turn-a').el, card);
  assert.equal(messagesEl.querySelectorAll('[data-turn-diff]').length, 1);
  render.renderTurnDiff('turn-b', diff);
  assert.equal(items.get('turn-diff:turn-b').diffFiles.length, 2, 'same file in a different turn remains visible');
});

test('message adoption keeps one latest action, removes it on installation, and repairs snapshots', () => {
  const messagesEl = document.createElement('div'); const items = new Map();
  const tab = {threadId:'thread',accountId:'default',messagesEl,items,planTurnHistory:[{threadId:'thread',turnId:'plan-turn'}]};
  let adopted = 0;
  render.setRenderContext({boundTab:tab,items,running:false,createRequestButton(label) { const button = document.createElement('button'); button.textContent = label; return button; },
    adoptMessageAsPlan() { adopted++; }});
  const add = (id, text, phase = '') => {
    const el = document.createElement('div'); el.className = 'cxp-msg cxp-msg-assistant';
    Object.assign(el.dataset,{itemId:id,codexThreadId:'thread',codexTurnId:'plan-turn',planMessageCandidate:'1',planTurn:'1',messageCompleted:'1',planSourceText:text,phase});
    const bodyEl = document.createElement('div'); bodyEl.className = 'cxp-msg-body'; el.append(bodyEl); messagesEl.append(el);
    items.set(id,{type:'agentMessage',el,bodyEl,buffer:text,phase,completed:true}); return el;
  };
  const older = add('older','# Older steps');
  render.syncMessagePlanActions(tab);
  const oldButton = older.querySelector('.cxp-use-as-plan');
  assert.ok(oldButton);
  const latest = add('latest','# Latest steps');
  render.syncMessagePlanActions(tab);
  assert.equal(older.querySelector('.cxp-use-as-plan'),null);
  assert.equal(messagesEl.querySelectorAll('.cxp-use-as-plan').length,1);
  oldButton.click(); assert.equal(adopted,0,'a detached stale action cannot adopt an older message');
  tab.planEditor = {dirty:true}; render.syncPlanEditorActions(tab);
  assert.equal(latest.querySelector('.cxp-use-as-plan').disabled,true);
  tab.planEditor = null;
  items.clear();
  render.sanitizeStoredTranscriptDom(messagesEl);
  assert.equal(messagesEl.querySelectorAll('.cxp-use-as-plan').length,0);
  render.syncMessagePlanActions(tab);
  assert.equal(messagesEl.querySelectorAll('.cxp-use-as-plan').length,1,'saved source/turn metadata re-applies the rule');
  tab.planDocument = {threadId:'thread',accountId:'default',turnId:'plan-turn',itemId:'native'};
  render.syncMessagePlanActions(tab);
  assert.equal(messagesEl.querySelectorAll('.cxp-use-as-plan').length,0);
  tab.planDocument = null; tab.running = true; render.syncMessagePlanActions(tab);
  assert.equal(messagesEl.querySelectorAll('.cxp-use-as-plan').length,0);
});


test('overflow notes follow measured sizes and retain unrelated accessible descriptions', () => {
  const block = document.createElement('pre'), note = document.createElement('div');
  note.id = 'cap'; block.setAttribute('aria-describedby', 'existing');
  block.scrollHeight = 100; block.clientHeight = 100;
  assert.equal(updateOverflowNote(block, note), false); assert.equal(note.hidden, true);
  assert.equal(block.getAttribute('aria-describedby'), 'existing');
  block.scrollHeight = 900; block.clientHeight = 320;
  assert.equal(updateOverflowNote(block, note), true); assert.equal(note.hidden, false);
  assert.equal(block.getAttribute('aria-describedby'), 'existing cap');
  updateOverflowNote(block, note);
  assert.equal(block.getAttribute('aria-describedby'), 'existing cap');
  block.clientHeight = 900; updateOverflowNote(block, note);
  assert.equal(note.hidden, true); assert.equal(block.getAttribute('aria-describedby'), 'existing');
  block.clientHeight = 0; updateOverflowNote(block, note); assert.equal(note.hidden, true);
  block.clientHeight = 320; block.checkVisibility = () => false;
  updateOverflowNote(block, note); assert.equal(note.hidden, true, 'closed details may retain layout dimensions');
  assert.equal(block.getAttribute('aria-describedby'), 'existing');
  block.checkVisibility = () => true; updateOverflowNote(block, note); assert.equal(note.hidden, false);
});

test('fenced JSON stays pretty code through repeated cleanup, while tool JSON remains structured', () => {
  for (const tagged of [true, false]) {
    const container = document.createElement('div'), pre = document.createElement('pre'), code = document.createElement('code');
    if (tagged) code.className = 'language-json';
    code.textContent = '{"ok":true,"items":[1,2]}'; pre.append(code); container.append(pre);
    cleanOutputBlocks(container); cleanOutputBlocks(container);
    assert.equal(container.querySelector('.cxp-readable'), null);
    assert.match(code.textContent, /"ok": true/);
    assert.equal(pre.querySelector('code'), code);
  }
  const container = document.createElement('div'), pre = document.createElement('pre');
  pre.className = 'cxp-card-pre'; pre.textContent = '{"ok":true}'; container.append(pre);
  cleanOutputBlocks(container); assert.ok(pre.querySelector('.cxp-readable'));
});

test('overlong tokens use capped raw blocks, leaving prose and markdown fences to markdown', () => {
  const container = document.createElement('div');
  assert.equal(renderReadableOutput(container, 'Token: ' + 'x'.repeat(12000)), true);
  assert.ok(container.querySelector('.cxp-output-raw'));
  assert.equal(renderReadableOutput(document.createElement('div'), 'Ordinary words. '.repeat(3000)), false);
  assert.equal(renderReadableOutput(document.createElement('div'), 'Before\n\n```json\n{"token":"' + 'x'.repeat(12000) + '"}\n```'), false);
});

test('diff and approval previews share relative paths, complete rename titles and summary controls', () => {
  const full = '/project/' + 'directory/'.repeat(10) + 'README.md';
  for (const approval of [false, true]) {
    const view = document.createElement('div'); if (approval) view.dataset.approvalDiffItem = 'pending';
    const files = fileChangeDiffs({changes:[{path:full.replace('README.md','BEFORE.md'),kind:{type:'update',move_path:full},diff:patch}]});
    renderDiffView(view, files, {cwd:'/project'});
    const path = view.querySelector('.cxp-diff-path');
    assert.equal(path.title, full.replace('README.md','BEFORE.md') + ' → ' + full);
    assert.match(path.textContent, /….*BEFORE\.md → .*….*README\.md$/);
    assert.ok(!path.textContent.includes('/project/'));
    const controls = view.querySelector('.cxp-output-controls');
    assert.match(controls.textContent, /1 file changeCopy patch/);
    assert.equal(view.querySelector('.cxp-card-meta').parentElement, controls);
    const parent = document.createElement('div'); parent.append(view);
    restoreDiffViews(parent);
    assert.equal(view.dataset.cwd, '/project');
    assert.equal(view.querySelector('.cxp-diff-path').title, path.title);
  }
});


test('legacy structured JSON inside a saved fence restores as pretty standard code', () => {
  const container = document.createElement('div'), pre = document.createElement('pre'), code = document.createElement('code');
  code.className = 'language-json cxp-pre-structured';
  pre.append(code); container.append(pre);
  renderReadableOutput(code, '{"ok":true}');
  assert.ok(code.querySelector('.cxp-readable'));
  cleanOutputBlocks(container);
  assert.equal(code.querySelector('.cxp-readable'), null);
  assert.equal(code.classList.contains('language-json'), true);
  assert.match(code.textContent, /"ok": true/);
});


test('restored old diff views without a saved cwd use the current tab workspace', () => {
  const container = document.createElement('div'), view = document.createElement('div'); container.append(view);
  renderDiffView(view, fileChangeDiffs({changes:[{path:'/project/src/app.js',kind:'update',diff:patch}]}));
  delete view.dataset.cwd;
  restoreDiffViews(container, {cwd:'/project'});
  assert.equal(view.querySelector('.cxp-diff-path').textContent, 'src/app.js');
  assert.equal(view.querySelector('.cxp-diff-path').title, '/project/src/app.js');
});
