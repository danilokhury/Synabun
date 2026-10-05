import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginPlanTurn, capturePlanItem, finishPlanTurn, extractProposedPlan, getPlanMarkdown,
  acceptPlanEdit, approvePlan, migrateLegacyPlan, recoverPlanFromHistory, useMessageAsPlan,
  recordPlanTurn, isRecordedPlanTurn, selectPlanAdoptionMessage,
} from '../public/shared/cdx/cdx-plan.js';

const tab = () => ({ threadId: 'thread-a', accountId: 'account-a', items: new Map() });
function complete(target, text = '# Complete plan\n\n1. Build\n2. Test', turnId = 'turn-a') {
  beginPlanTurn(target, turnId);
  capturePlanItem(target, { id: `item-${turnId}`, type: 'plan', text }, { turnId, completed: true });
  return finishPlanTurn(target, { turnId });
}

test('native completed plan survives a later assistant summary and accepts shorter final text', () => {
  const target = tab();
  beginPlanTurn(target, 'turn-a');
  capturePlanItem(target, { id: 'plan', type: 'plan', text: 'Long streaming provisional version '.repeat(20) }, { turnId: 'turn-a' });
  capturePlanItem(target, { id: 'plan', type: 'plan', text: '# Short valid plan' }, { turnId: 'turn-a', completed: true });
  capturePlanItem(target, { id: 'summary', type: 'agentMessage', text: 'Summary paragraph '.repeat(20) }, { turnId: 'turn-a', completed: true });
  finishPlanTurn(target, { turnId: 'turn-a' });
  assert.equal(getPlanMarkdown(target), '# Short valid plan');
  assert.equal(target.showPostPlanActions, true);
  assert.equal(target.planMode, true);
});

test('only complete wrappers qualify and native plan wins regardless of order', () => {
  assert.equal(extractProposedPlan('<proposed_plan>\npartial'), '');
  assert.equal(extractProposedPlan('Intro\n<proposed_plan>\n# Body\n</proposed_plan>\nSummary'), '# Body');
  const target = tab();
  beginPlanTurn(target, 'turn-a');
  capturePlanItem(target, { id: 'native', type: 'plan', text: 'Native' }, { completed: true });
  capturePlanItem(target, { id: 'wrapped', type: 'agentMessage', text: '<proposed_plan>Other</proposed_plan>' }, { completed: true });
  finishPlanTurn(target, {});
  assert.equal(getPlanMarkdown(target), 'Native');
});

test('clarification and interruption do not create approvable plans', () => {
  const target = tab();
  beginPlanTurn(target, 'turn-a');
  capturePlanItem(target, { id: 'commentary', type: 'agentMessage', text: 'A very long question '.repeat(30) }, { completed: true });
  finishPlanTurn(target, {});
  assert.equal(target.showPostPlanActions, false);
  assert.equal(target.planMode, true);
  beginPlanTurn(target, 'turn-b');
  capturePlanItem(target, { id: 'draft', type: 'plan', text: 'Partial plan' }, {});
  finishPlanTurn(target, { status: 'interrupted' });
  assert.equal(target.planDraft.markdown, 'Partial plan');
  assert.equal(approvePlan(target).ok, false);
});

test('failed replacement preserves the prior revision; stale turn events are ignored', () => {
  const target = tab();
  const original = complete(target);
  beginPlanTurn(target, 'turn-b');
  target.planRequestId = 'failed-request';
  assert.equal(capturePlanItem(target, { id: 'old', type: 'plan', text: 'Stale' }, { turnId: 'turn-a', completed: true }), null);
  capturePlanItem(target, { id: 'replacement', type: 'plan', text: 'New draft' }, { turnId: 'turn-b' });
  finishPlanTurn(target, { turnId: 'turn-b', status: 'failed' });
  assert.deepEqual(target.planDocument, original);
  assert.equal(target.showPostPlanActions, true);
  assert.equal(target.lastPlanTurnId, '');
  assert.equal(target.planRequestId, '');
});

test('editor preserves Markdown and detects stale revisions, wrong accounts, and pending operations', () => {
  const target = tab();
  const document = complete(target);
  const edit = { planId: document.id, revision: document.revision, accountId: target.accountId, threadId: target.threadId,
    content: '# Plano ✓\n\n| a | b |\n|---|---|\n| x | y |\n\n```js\nconst a = 1;\n```\n' };
  assert.equal(acceptPlanEdit(target, { ...edit, accountId: 'foreign' }).ok, false);
  assert.equal(acceptPlanEdit({ ...target, closed: true }, edit).ok, false);
  assert.equal(acceptPlanEdit(target, edit).ok, true);
  assert.equal(getPlanMarkdown(target), edit.content);
  assert.equal(acceptPlanEdit(target, edit).ok, false);
  target.planEditor = { dirty: true };
  assert.equal(approvePlan(target).ok, false);
  target.planEditor = null;
  assert.ok(approvePlan(target).prompt.includes(edit.content));
  assert.equal(target.planDocument.approvedRevision, null);
});

test('legacy paragraphs remain drafts; saved edits and authoritative history recover separately', () => {
  const target = { ...tab(), planContent: 'Ambiguous legacy paragraph', showPostPlanActions: true };
  migrateLegacyPlan(target);
  assert.equal(target.planDraft.markdown, 'Ambiguous legacy paragraph');
  assert.equal(target.showPostPlanActions, false);
  recoverPlanFromHistory(target, [{ id: 'old', status: 'completed', items: [{ id: 'p', type: 'plan', text: '# Historic plan' }] }]);
  assert.equal(getPlanMarkdown(target), '# Historic plan');
  assert.equal(target.showPostPlanActions, true);
  assert.equal(target.planMode, true);
  const edited = { ...tab(), editedPlanContent: '# User saved edits' };
  migrateLegacyPlan(edited);
  recoverPlanFromHistory(edited, [{ id: 'old', items: [{ id: 'p', type: 'plan', text: 'Older generated plan' }] }]);
  assert.equal(getPlanMarkdown(edited), '# User saved edits');
});

test('history recovery restores the latest full plan for review without treating later conversation as approval', () => {
  const target = tab();
  recoverPlanFromHistory(target, [
    { id: 'old', status: 'completed', items: [{ id: 'old-plan', type: 'plan', text: 'Old plan' }] },
    { id: 'new', status: 'completed', items: [
      { id: 'plan', type: 'plan', text: '# Complete latest plan\n\n1. Prepare\n2. Implement\n3. Verify' },
      { id: 'summary', type: 'agentMessage', text: '<proposed_plan>Short summary</proposed_plan>' },
    ] },
    { id: 'question', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'What happens after implementation?' }] }] },
  ]);
  assert.equal(target.planDocument.itemId, 'plan');
  assert.equal(target.planDocument.approvedRevision, null);
  assert.equal(target.planApprovalPending, true);
  assert.equal(target.showPostPlanActions, true);
  assert.match(approvePlan(target).prompt, /3\. Verify/);
});

test('authoritative terminal history repairs an orphan request id and keeps interrupted output a draft', () => {
  const target = tab();
  beginPlanTurn(target, 'client-request-uuid');
  target.planRequestId = 'client-request-uuid';
  const history = [{ id: 'native-turn-id', status: 'completed', items: [{ id: 'wrapped-plan', type: 'agentMessage', text: '<proposed_plan>\n# Ready to implement\n</proposed_plan>' }] }];
  assert.equal(recoverPlanFromHistory(target, history), null);
  const document = recoverPlanFromHistory(target, history, { authoritative: true });
  assert.equal(document.markdown, '# Ready to implement');
  assert.equal(document.turnId, 'native-turn-id');
  assert.equal(target.planTurnActive, false);
  assert.equal(target.lastPlanTurnId, '');
  assert.equal(target.planRequestId, '');
  assert.equal(target.showPostPlanActions, true);

  const interrupted = tab();
  beginPlanTurn(interrupted, 'interrupted');
  capturePlanItem(interrupted, { id: 'draft', type: 'plan', text: '# Unfinished' });
  recoverPlanFromHistory(interrupted, [{ id: 'interrupted', status: 'interrupted', items: [{ id: 'draft', type: 'plan', text: '# Unfinished' }] }], { authoritative: true });
  assert.equal(interrupted.planDraft.markdown, '# Unfinished');
  assert.equal(interrupted.planTurnActive, false);
  assert.equal(interrupted.showPostPlanActions, false);
});

test('history never finalizes a live turn or turns stale flags into a reviewable plan', () => {
  const target = tab();
  beginPlanTurn(target, 'live');
  const history = [{ id: 'live', status: 'inProgress', items: [{ id: 'draft', type: 'plan', text: '# Still streaming' }] }];
  assert.equal(recoverPlanFromHistory(target, history, { authoritative: true }), null);
  assert.equal(target.planTurnActive, true);
  assert.equal(target.showPostPlanActions, false);

  const stale = { ...tab(), planTurnActive: true, lastPlanTurnId: 'orphan', planApprovalPending: true, showPostPlanActions: true };
  recoverPlanFromHistory(stale, [{ id: 'clarification', status: 'completed', items: [{ id: 'question', type: 'agentMessage', text: 'Which database should be migrated?' }] }], { authoritative: true });
  assert.equal(stale.planTurnActive, false);
  assert.equal(stale.planApprovalPending, false);
  assert.equal(stale.showPostPlanActions, false);
  assert.equal(approvePlan(stale).ok, false);
});

test('history preserves saved edits and explicit approvals but recovers a demonstrably newer revision', () => {
  const target = tab();
  const original = complete(target, '# First plan', 'first');
  const edited = acceptPlanEdit(target, { planId: original.id, revision: original.revision, accountId: target.accountId, threadId: target.threadId, content: '# Saved exact edits' }).document;
  edited.approvedRevision = edited.revision;
  const oldHistory = [{ id: 'first', status: 'completed', items: [{ id: 'item-first', type: 'plan', text: '# First plan' }] }];
  assert.equal(recoverPlanFromHistory(target, oldHistory), edited);
  assert.equal(target.planDocument.markdown, '# Saved exact edits');
  assert.equal(target.showPostPlanActions, false);

  beginPlanTurn(target, 'orphan-request');
  const next = recoverPlanFromHistory(target, [...oldHistory, { id: 'second', status: 'completed', items: [{ id: 'new-plan', type: 'plan', text: '# Newer complete revision' }] }], { authoritative: true });
  assert.equal(next.id, original.id);
  assert.equal(next.revision, edited.revision + 1);
  assert.equal(next.markdown, '# Newer complete revision');
  assert.equal(next.approvedRevision, null);
  assert.equal(target.showPostPlanActions, true);
  assert.equal(target.planRevisions.at(-1), edited);
});

test('history recognizes only an explicit recorded approval of the exact recovered plan', () => {
  const original = tab();
  complete(original, '# Full plan\n\n1. Run migration\n2. Verify\n');
  const approvedPrompt = approvePlan(original).prompt;
  const history = [
    { id: 'plan-turn', status: 'completed', items: [{ id: 'plan', type: 'plan', text: original.planDocument.markdown }] },
    { id: 'implementation', status: 'completed', items: [{ id: 'approval', type: 'userMessage', content: [{ type: 'text', text: approvedPrompt }] }] },
  ];
  const restored = tab();
  const recovered = recoverPlanFromHistory(restored, history);
  assert.equal(recovered.approvedRevision, recovered.revision);
  assert.equal(restored.planApprovalPending, false);
  assert.equal(restored.showPostPlanActions, false);

  const revised = tab();
  history[0].items[0].text += '\n3. Added after approval';
  recoverPlanFromHistory(revised, history);
  assert.equal(revised.planDocument.approvedRevision, null);
  assert.equal(revised.showPostPlanActions, true);
});

test('explicit selection supports unstructured output but never a running conversation', () => {
  const target = tab();
  target.running = true;
  assert.equal(useMessageAsPlan(target, { markdown: 'A selected message' }), null);
  target.running = false;
  target.planTurnActive = true;
  target.lastPlanTurnId = 'orphan-turn';
  target.planRequestId = 'orphan-request';
  target.planCandidate = { markdown: 'Old candidate' };
  assert.ok(useMessageAsPlan(target, { itemId: 'selected', markdown: 'A selected message' }));
  assert.equal(approvePlan(target).ok, true);
  assert.equal(target.planTurnActive, false);
  assert.equal(target.lastPlanTurnId, '');
  assert.equal(target.planRequestId, '');
  assert.equal(target.planCandidate, null);
});

const message = (id, turnId = 'plan-turn', extras = {}) => ({id, turnId, type:'agentMessage', text:'# Proposed steps\n1. Build\n2. Test', completed:true, ...extras});

test('only the latest candidate of a recorded plan turn gets message adoption', () => {
  const target = tab(); recordPlanTurn(target, 'plan-turn');
  const messages = [message('older'), message('latest')];
  assert.equal(selectPlanAdoptionMessage(target, messages), 'latest');
  assert.equal(isRecordedPlanTurn(target, 'plan-turn'), true);
  target.planMode = false;
  assert.equal(selectPlanAdoptionMessage(target, messages), 'latest', 'toolbar changes do not rewrite a submitted turn');
  assert.equal(selectPlanAdoptionMessage(target, [message('normal', 'non-plan-turn')]), null);
  target.planMode = true;
  assert.equal(selectPlanAdoptionMessage(target, [message('normal', 'non-plan-turn')]), null, 'current plan mode alone is insufficient');
});

test('explicit proposed_plan outside plan mode is a candidate, prose and commentary are not', () => {
  const target = tab();
  const proposed = message('proposed', 'normal-turn', {text:'<proposed_plan>\n# Plan\n</proposed_plan>'});
  assert.equal(selectPlanAdoptionMessage(target, [proposed]), 'proposed');
  assert.equal(selectPlanAdoptionMessage(target, [{...proposed,phase:'commentary'}]), null);
  assert.equal(selectPlanAdoptionMessage(target, [{...proposed,text:'An ordinary answer.'}]), null);
  assert.equal(selectPlanAdoptionMessage(target, [{...proposed,text:'<proposed_plan>not complete'}]), null);
});

test('a plan document, draft, candidate or native plan from that turn suppresses adoption', () => {
  const target = tab(); recordPlanTurn(target, 'plan-turn');
  const messages = [message('older'), message('latest')];
  target.planDocument = {threadId:target.threadId,accountId:target.accountId,turnId:'plan-turn',itemId:'native'};
  assert.equal(selectPlanAdoptionMessage(target, messages), null);
  target.planDocument = null;
  for (const field of ['planDraft','planCandidate']) {
    target[field] = {turnId:'plan-turn',itemId:'other',markdown:'# Already captured'};
    assert.equal(selectPlanAdoptionMessage(target, messages), null);
    target[field] = null;
  }
  assert.equal(selectPlanAdoptionMessage(target, messages, [{turnId:'plan-turn',itemId:'native'}]), null);
  target.planDocument = {threadId:target.threadId,accountId:target.accountId,turnId:'other-turn',itemId:'other'};
  assert.equal(selectPlanAdoptionMessage(target, messages), 'latest');
});

test('a newer installed candidate never resurrects an older candidate button', () => {
  const target = tab(); recordPlanTurn(target, 'old-turn'); recordPlanTurn(target, 'new-turn');
  target.planDraft = {turnId:'new-turn',itemId:'draft',markdown:'# Draft'};
  assert.equal(selectPlanAdoptionMessage(target, [message('old','old-turn'),message('new','new-turn')]), null);
});

test('running, pending, compacting and incomplete turns do not expose message adoption', () => {
  const target = tab(); recordPlanTurn(target, 'plan-turn');
  for (const field of ['running','startingThread','compacting','planTurnActive']) {
    target[field] = true;
    assert.equal(selectPlanAdoptionMessage(target, [message('latest')]), null);
    target[field] = false;
  }
  assert.equal(selectPlanAdoptionMessage(target, [message('old'), message('streaming','plan-turn',{completed:false})]), null);
});

test('plan turn records survive completion, stay thread-scoped and are bounded', () => {
  const target = tab(); beginPlanTurn(target,'plain-plan-turn'); finishPlanTurn(target,{turnId:'plain-plan-turn'});
  assert.equal(target.lastPlanTurnId,'');
  assert.equal(selectPlanAdoptionMessage(target,[message('latest','plain-plan-turn')]),'latest');
  target.threadId = 'different-thread';
  assert.equal(isRecordedPlanTurn(target,'plain-plan-turn'),false);
  assert.equal(selectPlanAdoptionMessage(target,[message('latest','plain-plan-turn')]),null);
  for (let i=0;i<110;i++) recordPlanTurn(target,'turn-'+i);
  assert.equal(target.planTurnHistory.length,100);
  recordPlanTurn(target,'turn-109');
  assert.equal(target.planTurnHistory.length,100);
});
