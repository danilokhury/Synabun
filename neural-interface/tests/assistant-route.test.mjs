import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRouteCancel,
  buildRouteResponse,
  normalizeRouteRequest,
  routeLineParts,
  routeLineText,
  routeModeDescription,
  routeModeLabel,
  routeOptions,
  routeReasonLabels,
  sameRouteTarget,
} from '../public/shared/assistant/asst-route.js';
import { fmtConfidence } from '../public/shared/assistant/asst-state.js';

// A route card exactly as the router emits it (control_request subtype 'route').
function routePacket(overrides = {}) {
  return {
    type: 'control_request',
    request_id: 'route-ab12cd',
    request: {
      subtype: 'route',
      kind: 'route',
      provider: 'synabun',
      routeId: 'route-ab12cd',
      origin: 'agent_route',
      runIds: [],
      workflowId: null,
      sessionId: 'assistant-1',
      mode: 'ask-unsure',
      reasons: ['low_confidence'],
      taskClass: 'code',
      taskClassLabel: 'Code',
      summary: 'Refactor the hooks loader',
      confidence: 0.62,
      needsVision: false,
      brain: { provider: 'claude-code', model: 'claude-sonnet-5', label: 'Sonnet 5', vision: true },
      options: [
        { id: 's1', kind: 'dispatch', provider: 'codex', model: 'gpt-5.5', effort: 'high', label: 'GPT-5.5', badge: 'suggested', tier: 'large', vision: false, price: { input: 1.25, output: 10, unit: 'usd_per_mtok' }, reason: 'heavy coding' },
        { id: 'here', kind: 'direct', provider: 'claude-code', model: 'claude-sonnet-5', effort: null, label: 'Sonnet 5', badge: 'current' },
        { id: 'c1', kind: 'dispatch', provider: 'codex', model: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', badge: 'cheaper' },
        { id: 'x1', kind: 'dispatch', provider: 'claude-code', model: 'claude-opus-5', label: 'Opus 5', badge: 'stronger', disabled: true, disabledReason: 'Budget cap' },
      ],
      defaultOptionId: 's1',
      other: { allowed: true, providers: ['claude-code', 'codex', 'opencode'], catalogPath: '/api/assistant/catalog' },
      remember: { available: true, taskClass: 'code', label: 'Code', current: null },
      decline: { allowed: true, label: 'Cancel' },
      createdAt: '2026-09-23T10:00:00.000Z',
      expiresAt: '2026-09-23T10:05:00.000Z',
      ...overrides,
    },
  };
}

test('normalizeRouteRequest reads the router packet', () => {
  const n = normalizeRouteRequest(routePacket());
  assert.equal(n.requestId, 'route-ab12cd');
  assert.equal(n.routeId, 'route-ab12cd');
  assert.equal(n.origin, 'agent_route');
  assert.equal(n.mode, 'ask-unsure');
  assert.deepEqual(n.reasons, ['low_confidence']);
  assert.equal(n.taskClassLabel, 'Code');
  assert.equal(n.confidence, 0.62);
  assert.deepEqual(n.brain, { provider: 'claude-code', model: 'claude-sonnet-5', label: 'Sonnet 5', vision: true });
  assert.equal(n.options.length, 4);
  assert.deepEqual(n.options[0].price, { input: 1.25, output: 10, unit: 'usd_per_mtok' });
  assert.equal(n.options[3].disabled, true);
  assert.equal(n.defaultOptionId, 's1');
  assert.equal(n.remember.available, true);
  assert.equal(n.decline.allowed, true);
  assert.equal(n.expiresAt, '2026-09-23T10:05:00.000Z');
  // Tolerant: bare request object, missing optional blocks, bogus options.
  const bare = normalizeRouteRequest({ routeId: 'route-x', options: [null, { label: 'no id' }, { id: 'here', provider: 'claude' }] });
  assert.equal(bare.requestId, 'route-x');
  assert.equal(bare.taskClass, 'general');
  assert.equal(bare.options.length, 1);
  assert.equal(bare.options[0].provider, 'claude-code');
  assert.equal(bare.other.allowed, true);
  assert.equal(bare.remember.available, false);
  assert.equal(normalizeRouteRequest(null), null);
  assert.equal(normalizeRouteRequest({ request: {} }), null);
});

test('routeOptions: suggested first and preselected, then here, remembered, cheaper, stronger', () => {
  const n = normalizeRouteRequest(routePacket({
    options: [
      { id: 'x1', kind: 'dispatch', provider: 'claude-code', model: 'claude-opus-5', badge: 'stronger' },
      { id: 'c1', kind: 'dispatch', provider: 'codex', model: 'gpt-5.4-mini', badge: 'cheaper' },
      { id: 'r1', kind: 'dispatch', provider: 'opencode', model: 'anthropic/claude-haiku-5', badge: 'remembered' },
      { id: 'here', kind: 'direct', provider: 'claude-code', model: 'claude-sonnet-5', badge: 'current' },
      { id: 's1', kind: 'dispatch', provider: 'codex', model: 'gpt-5.5', effort: 'high', label: 'GPT-5.5', badge: 'suggested' },
    ],
  }));
  const opts = routeOptions(n, { brainLabel: 'Sonnet 5' });
  assert.deepEqual(opts.map(o => o.id), ['s1', 'here', 'r1', 'c1', 'x1']);
  assert.deepEqual(opts.map(o => o.number), [1, 2, 3, 4, 5]);
  assert.equal(opts[0].selected, true);
  assert.equal(opts.filter(o => o.selected).length, 1);
  assert.equal(opts[0].badgeText, 'Suggested · 62%');
  assert.equal(opts[1].title, 'Do it here with Sonnet 5');
  assert.equal(opts[1].here, true);
  assert.equal(opts[2].badgeText, 'Remembered');
  assert.equal(opts[2].title, 'claude-haiku-5');
});

test('routeOptions de-dupes the "here" option and identical targets', () => {
  // A suggestion that targets the brain's own model replaces the "here" row.
  const n = normalizeRouteRequest(routePacket({
    options: [
      { id: 'here', kind: 'direct', provider: 'claude-code', model: 'claude-sonnet-5', badge: 'current' },
      { id: 's1', kind: 'direct', provider: 'claude-code', model: 'claude-sonnet-5', badge: 'suggested' },
      { id: 's2', kind: 'dispatch', provider: 'codex', model: 'gpt-5.5', badge: 'suggested' },
      { id: 's3', kind: 'dispatch', provider: 'codex', model: 'gpt-5.5', badge: 'cheaper' },
    ],
    defaultOptionId: 'here',
  }));
  const opts = routeOptions(n, { brainLabel: 'Sonnet 5' });
  assert.deepEqual(opts.map(o => o.id), ['s1', 's2']);
  assert.equal(opts[0].selected, true, 'default follows the surviving twin of "here"');
  assert.equal(opts[0].here, true);
  assert.equal(opts[0].title, 'Do it here with Sonnet 5');
  assert.equal(opts[0].badgeText, 'Suggested · 62%');

  // Without a separate "here" option, a direct option on the brain model still reads as "here".
  const implicit = routeOptions(normalizeRouteRequest(routePacket({
    options: [{ id: 's1', kind: 'direct', provider: 'claude-code', model: 'claude-sonnet-5', effort: 'high', badge: 'suggested' }],
  })), { brainLabel: 'Sonnet 5' });
  assert.equal(implicit[0].here, true);

  // A disabled default falls back to the first enabled option.
  const disabled = routeOptions(normalizeRouteRequest(routePacket({
    options: [{ id: 's1', provider: 'codex', model: 'a', badge: 'suggested', disabled: true }, { id: 'c1', provider: 'codex', model: 'b', badge: 'cheaper' }],
  })));
  assert.equal(disabled.find(o => o.selected).id, 'c1');

  assert.equal(sameRouteTarget({ kind: 'direct', provider: 'codex', model: 'gpt-5.5' }, { provider: 'codex', model: 'GPT-5.5' }), true);
  assert.equal(sameRouteTarget({ provider: 'codex', model: 'gpt-5.5', effort: 'high' }, { provider: 'codex', model: 'gpt-5.5' }), false);
  assert.deepEqual(routeOptions(null), []);
});

test('buildRouteResponse: option, other + target, remember, decline (cancel)', () => {
  const n = normalizeRouteRequest(routePacket());
  assert.deepEqual(buildRouteResponse(n, { optionId: 's1' }), { kind: 'route', optionId: 's1', remember: false });
  assert.deepEqual(buildRouteResponse(n, { optionId: 'here', remember: true }), { kind: 'route', optionId: 'here', remember: true });
  assert.deepEqual(buildRouteResponse(n, {}), { kind: 'route', optionId: 's1', remember: false }, 'defaults to defaultOptionId');
  assert.deepEqual(
    buildRouteResponse(n, { optionId: 'other', target: { kind: 'dispatch', provider: 'oc', model: 'openai/gpt-5.5', effort: '' }, remember: true }),
    { kind: 'route', optionId: 'other', remember: true, target: { kind: 'dispatch', provider: 'opencode', model: 'openai/gpt-5.5', effort: null } },
  );
  // Remember is only sent when the card offers it.
  const noRemember = normalizeRouteRequest(routePacket({ remember: { available: false } }));
  assert.equal(buildRouteResponse(noRemember, { optionId: 's1', remember: true }).remember, false);
  // Cancel = decline answer; a server-side cancel packet exists for cards that refuse declines.
  assert.deepEqual(buildRouteResponse(n, { decline: true, optionId: 's1', remember: true }), { kind: 'route', optionId: null, remember: false, decline: true });
  assert.deepEqual(buildRouteCancel(n), { type: 'control_cancelled', request_id: 'route-ab12cd', reason: 'user' });
  assert.deepEqual(buildRouteCancel(n, 'timeout'), { type: 'control_cancelled', request_id: 'route-ab12cd', reason: 'timeout' });
});

test('route line text and states', () => {
  const route = {
    routeId: 'route-ab12cd', taskClass: 'code', taskClassLabel: 'code', confidence: 0.86, reason: 'refactor across files',
    target: { kind: 'direct', provider: 'claude-code', model: 'claude-sonnet-5', effort: 'high', label: 'Sonnet 5' },
    alternatives: [{ provider: 'codex', model: 'gpt-5.5', effort: 'high', label: 'GPT-5.5' }],
    decidedBy: 'brain',
  };
  assert.equal(routeLineText(route, 'decided'), '⇄ code → Sonnet 5 · high · 86%');
  assert.equal(routeLineText({ ...route, target: { ...route.target, kind: 'dispatch', provider: 'codex', label: 'GPT-5.5' } }, 'auto'), '⇄ code → dispatch · GPT-5.5 · high · 86%');
  assert.equal(routeLineText({ ...route, target: { ...route.target, kind: 'computer' } }, 'auto'), '⇄ code → computer · Sonnet 5 · high · 86%');
  const parts = routeLineParts(route, 'decided', { brainLabel: 'Sonnet 5' });
  assert.equal(parts.decidedText, 'decided by Sonnet 5');
  assert.deepEqual(parts.alternatives, ['GPT-5.5 · high']);
  assert.equal(parts.reason, 'refactor across files');
  assert.equal(routeLineParts({ ...route, decidedBy: 'user' }).decidedText, 'you chose');
  assert.equal(routeLineParts({ ...route, decidedBy: 'remembered' }).decidedText, 'remembered');
  assert.equal(routeLineParts({ ...route, decidedBy: 'timeout' }).decidedText, 'default after timeout');
  assert.equal(routeLineText(route, 'pending'), '⇄ code · waiting for your choice');
  const expired = routeLineParts(route, 'expired');
  assert.equal(expired.muted, true);
  assert.equal(expired.targetLabel, '');
  assert.equal(routeLineText(route, 'declined'), '⇄ code · declined');
  assert.equal(routeLineText(route, 'cancelled'), '⇄ code · cancelled');
});

test('mode labels, descriptions and reasons', () => {
  assert.equal(routeModeLabel('always-ask'), 'Always ask');
  assert.equal(routeModeLabel('unsure'), 'Ask when unsure');
  assert.equal(routeModeLabel('autonomous'), 'Never ask');
  assert.equal(routeModeLabel(null), 'Ask when unsure', 'default mode');
  assert.equal(routeModeDescription('always-ask', 'Sonnet 5'), 'Show the route card before every task.');
  assert.equal(routeModeDescription('ask-unsure', 'Sonnet 5'), 'Sonnet 5 routes on its own when confident, asks otherwise.');
  assert.equal(routeModeDescription('never', 'Sonnet 5'), 'Sonnet 5 sorts each request; your task routes apply without asking.');
  const n = normalizeRouteRequest(routePacket({ reasons: ['always-ask', 'low_confidence', 'model_missing', 'model_unknown', 'needs_vision'] }));
  assert.deepEqual(routeReasonLabels(n), ['you asked to confirm routes', 'low confidence', 'model unavailable', 'unknown model', 'needs vision']);
});

test('fmtConfidence accepts 0..1 and 0..100', () => {
  assert.equal(fmtConfidence(0.86), '86%');
  assert.equal(fmtConfidence(86), '86%');
  assert.equal(fmtConfidence('0.5'), '50%');
  assert.equal(fmtConfidence(1), '100%');
  assert.equal(fmtConfidence(0), '0%');
  assert.equal(fmtConfidence(140), '100%');
  assert.equal(fmtConfidence(null), '');
  assert.equal(fmtConfidence(''), '');
  assert.equal(fmtConfidence(-0.2), '');
  assert.equal(fmtConfidence('n/a'), '');
  assert.equal(fmtConfidence(true), '');
});

test('route line corrections: a saved route that bound the pick reads as such', () => {
  const p = routeLineParts({ taskClass: 'code', target: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }, decidedBy: 'remembered', corrections: [
    { field: 'route', from: 'here on mimo-flash', to: 'codex/gpt-5.6-luna', reason: 'remembered_route', text: 'saved Coding route codex/gpt-5.6-luna replaced here on mimo-flash' },
    { field: 'route', from: 'codex/gpt-x', to: null, reason: 'remembered_disabled' },
    { field: 'effort', from: 'max', to: 'high', reason: 'effort_unsupported' },
  ] }, 'auto');
  assert.deepEqual(p.corrections, ['your saved route codex/gpt-5.6-luna replaced here on mimo-flash', 'saved route codex/gpt-x is disabled, kept the pick', 'effort: max → high']);
  assert.equal(p.decidedText, 'remembered');
});
