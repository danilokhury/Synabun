// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — the todo widget (above the compose box): the model's todo
// list while there is work left on it. The visibility rules are in
// ocp-v2-tools-logic.js. (The session's cost is a row of the Context settings
// popover: ocp-v2-context-menu.js.)
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { todoView, todoWidgetVisible } from './ocp-v2-tools-logic.js';

const TODO_MARKS = { completed: '✓', in_progress: '▸', pending: '○', cancelled: '✕' };

export function mountTodoWidget(rootEl, store = getDefaultStore()) {
  if (!rootEl) return { element: null, destroy() {} };
  const wrap = document.createElement('div');
  wrap.className = 'ocpv2-todo-widget';
  wrap.hidden = true;
  rootEl.appendChild(wrap);
  let expanded = false;

  function sync() {
    const view = todoView(store.getState().todos);
    wrap.hidden = !todoWidgetVisible(view);
    wrap.innerHTML = '';
    if (wrap.hidden) return;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ocpv2-todo-head';
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const count = document.createElement('span');
    count.className = 'ocpv2-todo-count';
    count.textContent = `Todos ${view.done}/${view.total}`;
    const active = document.createElement('span');
    active.className = 'ocpv2-todo-active';
    active.textContent = view.active || '';
    head.append(count, active);
    head.addEventListener('click', () => { expanded = !expanded; sync(); });
    wrap.appendChild(head);

    if (!expanded) return;
    const list = document.createElement('div');
    list.className = 'ocpv2-todo-list';
    for (const item of view.items) {
      const row = document.createElement('div');
      row.className = `ocpv2-todo-item ocpv2-todo-${item.status}`;
      const mark = document.createElement('span');
      mark.className = 'ocpv2-todo-mark';
      mark.textContent = TODO_MARKS[item.status] || '○';
      const text = document.createElement('span');
      text.className = 'ocpv2-todo-text';
      text.textContent = item.content;
      row.append(mark, text);
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  const unsubscribe = store.subscribe((event) => {
    if (event?.type === 'todos:set' || event?.type === 'messages:clear' || event?.type === 'session:set') sync();
  });
  sync();
  return { element: wrap, destroy() { try { unsubscribe(); } catch {} wrap.remove(); } };
}
