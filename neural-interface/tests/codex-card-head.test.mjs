import assert from 'node:assert/strict';
import test from 'node:test';
import { bindExpandableCard, setCardExpanded } from '../public/shared/cdx/cdx-cards.js';

function fixture({ expanded = false, expandable = true } = {}) {
  const classes = new Set(expanded ? [] : ['cxp-collapsed']);
  const attrs = new Map();
  const listeners = new Map();
  const head = {
    tabIndex: -1,
    setAttribute: (key, value) => attrs.set(key, value),
    getAttribute: (key) => attrs.get(key) ?? null,
    querySelector: () => expandable ? {} : null,
    closest: () => head,
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
  };
  const card = {
    dataset: {},
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    querySelector: (selector) => selector.endsWith('.cxp-card-head') ? head : {},
  };
  const fire = (type, options = {}) => {
    const event = { type, target: head, prevented: false, preventDefault() { this.prevented = true; }, ...options };
    for (const handler of listeners.get(type) || []) handler(event);
    return event;
  };
  return { card, head, fire };
}

test('live and restored card heads announce their initial and programmatic state', () => {
  for (const expanded of [false, true]) {
    const { card, head } = fixture({ expanded });
    bindExpandableCard(card);
    assert.equal(head.tabIndex, 0);
    assert.equal(head.getAttribute('role'), 'button');
    assert.equal(head.getAttribute('aria-expanded'), String(expanded));
    setCardExpanded(card, !expanded);
    assert.equal(head.getAttribute('aria-expanded'), String(!expanded));
    assert.equal(card.dataset.expanded, expanded ? '0' : '1');
    assert.equal(card.classList.contains('cxp-collapsed'), expanded);
  }
});

test('Enter, Space and pointer activate once; Space and held keys cannot scroll', () => {
  const { card, head, fire } = fixture();
  const changes = [];
  bindExpandableCard(card, (_, expanded) => changes.push(expanded));
  assert.equal(fire('keydown', { key: 'Tab' }).prevented, false);
  fire('keydown', { key: 'Enter' });
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(fire('keydown', { key: ' ', repeat: true }).prevented, true);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(fire('keydown', { key: ' ' }).prevented, true);
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  fire('click');
  assert.deepEqual(changes, [true, false, true]);
});

test('inner buttons, links, inputs and editable controls retain their own events', () => {
  const { card, head, fire } = fixture();
  bindExpandableCard(card, () => assert.fail('inner control toggled its card'));
  for (const type of ['click', 'keydown']) {
    const control = { closest: () => control };
    const event = fire(type, { target: control, key: ' ' });
    assert.equal(event.prevented, false);
    assert.equal(head.getAttribute('aria-expanded'), 'false');
  }
});

test('rebinding during streaming keeps one listener and uses the current callback', () => {
  const { card, head, fire } = fixture();
  bindExpandableCard(card, () => assert.fail('stale callback'));
  let toggles = 0;
  setCardExpanded(card, true);
  bindExpandableCard(card, () => { toggles += 1; });
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  fire('click');
  assert.equal(toggles, 1);
  assert.equal(head.getAttribute('aria-expanded'), 'false');
});

test('non-expandable heads gain neither keyboard behavior nor button semantics', () => {
  const { card, head, fire } = fixture({ expandable: false });
  bindExpandableCard(card, () => assert.fail('non-expandable head activated'));
  assert.equal(head.tabIndex, -1);
  assert.equal(head.getAttribute('role'), null);
  assert.equal(head.getAttribute('aria-expanded'), null);
  assert.equal(fire('keydown', { key: ' ' }).prevented, false);
});
