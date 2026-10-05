import { t } from '../i18n.js';
import { label } from './sg-labels.js';
import { cssColorToHex, resolveColor } from './sg-color-client.js';
export { t, label };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function el(tag, cls = '', text) { const n = document.createElement(tag); if (cls)
    n.className = cls; if (text != null)
    n.textContent = text; return n; }
export const row = (...children) => { const n = el('div', 'sg-row'); n.append(...children); return n; };
export const grid = (...children) => { const n = el('div', 'sg-grid'); n.append(...children); return n; };
export function card(key, ...children) {
    const n = el('section', 'sg-card');
    n.dataset.card = key;
    n.append(el('h3', '', t(`styleguide.cards.${key}.title`)), el('p', 'sg-purpose', t(`styleguide.cards.${key}.purpose`)), ...children);
    return n;
}
export function button(text, handler, cls = '') {
    const n = el('button', `sg-btn ${cls}`, text);
    n.type = 'button';
    n.addEventListener('click', async () => {
        if (n.disabled)
            return;
        // Disabling a focused button drops focus to <body>; give it back when the work is done.
        const hadFocus = document.activeElement === n;
        n.disabled = true;
        try {
            await handler?.();
        }
        catch (e) {
            const host = n.closest('.styleguide-panel');
            const out = host?.querySelector('.sg-error');
            if (out) {
                out.hidden = false;
                out.textContent = e.message;
            }
        }
        finally {
            n.disabled = false;
            if (hadFocus && n.isConnected && (!document.activeElement || document.activeElement === document.body))
                n.focus({ preventScroll: true });
        }
    });
    return n;
}
let serial = 0;
export function field(name, value, onChange, { type = 'text', unit = '', min, max, step, options, list, help } = {}) {
    // A checkbox sits inside its <label>; every other control gets <label for>, so a wrapped
    // select or textarea never adds its own value to the accessible name.
    const box = type === 'checkbox', wrap = el(box ? 'label' : 'div', 'sg-field'), id = `sg-field-${++serial}`;
    const caption = el(box ? 'span' : 'label', 'sg-label', name + (unit ? ` (${unit})` : ''));
    if (!box)
        caption.htmlFor = id;
    wrap.append(caption);
    const input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', 'sg-input');
    input.id = id;
    if (box)
        wrap.prepend(input);
    if (type === 'select')
        for (const option of options || []) {
            const [v, text] = Array.isArray(option) ? option : [option, label(option)];
            const n = el('option', '', text);
            n.value = v;
            input.append(n);
        }
    else if (type !== 'textarea')
        input.type = type;
    if (type === 'checkbox') {
        input.checked = !!value;
        wrap.classList.add('sg-toggle');
    }
    else
        input.value = value ?? '';
    for (const [key, val] of Object.entries({ min, max, step, list }))
        if (val != null)
            input.setAttribute(key, val);
    if (help) {
        const h = el('small', 'sg-hint', help);
        h.id = id + '-help';
        wrap.append(input, h);
        input.setAttribute('aria-describedby', h.id);
    }
    else if (!box)
        wrap.append(input);
    const err = el('small', 'sg-validation');
    err.hidden = true;
    wrap.append(err);
    const update = () => {
        if (type === 'number' || type === 'range') {
            if (!input.value.trim() || !input.checkValidity() || !Number.isFinite(Number(input.value))) {
                input.setAttribute('aria-invalid', 'true');
                err.hidden = false;
                err.textContent = t('styleguide.invalidNumber');
                return;
            }
        }
        input.removeAttribute('aria-invalid');
        err.hidden = true;
        onChange(type === 'checkbox' ? input.checked : type === 'number' || type === 'range' ? Number(input.value) : input.value, input);
    };
    input.addEventListener(type === 'select' || type === 'checkbox' ? 'change' : 'input', update);
    return wrap;
}
export const text = (s, path, name = label(path.split('.').at(-1)), options = {}) => { const host = field(name, s.get(path), v => s.set(path, v), options); host.querySelector('input,select,textarea').dataset.sgPath = path; return host; };
export const number = (s, path, unit = '', options = {}) => text(s, path, options.name || label(path.split('.').at(-1)), { type: 'number', unit, step: 'any', ...options });
export const select = (s, path, options, name) => text(s, path, name || label(path.split('.').at(-1)), { type: 'select', options });
export const toggle = (s, path, name) => text(s, path, name || label(path.split('.').at(-1)), { type: 'checkbox' });
export const textarea = (s, path, name) => text(s, path, name || label(path.split('.').at(-1)), { type: 'textarea' });
export function listEditor(s, path, name = label(path.split('.').at(-1)), { numeric = false, max = 40, chips = false } = {}) {
    const host = el('div', 'sg-list' + (chips ? ' sg-chips' : ''));
    const draw = () => {
        host.replaceChildren(el('h4', '', name));
        const values = s.get(path) || [], items = el('div', chips ? 'sg-chip-row' : 'sg-stack sg-list-items');
        values.forEach((v, i) => {
            const item = field(t('styleguide.listItem', { label: name, index: i + 1 }), v, val => { const next = [...s.get(path)]; next[i] = val; s.set(path, next); }, { type: numeric ? 'number' : 'text', step: 'any' });
            item.classList.add('sg-hide-label');
            const r = row(item);
            r.classList.add(chips ? 'sg-chip-item' : 'sg-list-item');
            const remove = button(chips ? '×' : t('styleguide.remove'), () => { s.set(path, s.get(path).filter((_, j) => j !== i)); draw(); }, chips ? 'sg-icon-btn' : '');
            remove.setAttribute('aria-label', `${t('styleguide.remove')} · ${t('styleguide.listItem', { label: name, index: i + 1 })}`);
            if (!chips) {
                const move = dir => { const next = [...s.get(path)]; [next[i], next[i + dir]] = [next[i + dir], next[i]]; s.set(path, next); draw(); };
                const up = button(t('styleguide.up'), () => move(-1));
                up.disabled = i === 0;
                const down = button(t('styleguide.down'), () => move(1));
                down.disabled = i === values.length - 1;
                r.append(up, down);
            }
            r.append(remove);
            items.append(r);
        });
        const add = button(t('styleguide.add'), () => { s.set(path, [...(s.get(path) || []), numeric ? 24 : '']); draw(); host.querySelectorAll('input').item((s.get(path) || []).length - 1)?.focus(); }, 'sg-add-btn');
        add.setAttribute('aria-label', `${t('styleguide.add')} · ${name}`);
        add.disabled = values.length >= max;
        if (chips)
            items.append(add);
        host.append(items);
        if (!chips)
            host.append(add);
    };
    draw();
    return host;
}
export function aliasOptions(c, { colorsOnly = false } = {}) {
    const groups = { ...Object.fromEntries(Object.entries(c.colors.palettes).map(([k, p]) => [k, p.steps])), status: c.colors.status, semantic: c.colors.semantic.light };
    if (!colorsOnly)
        Object.assign(groups, { typography: c.typography.styles, spacing: c.layout.spacing.scale, radius: c.shape.radius, radiusRoles: c.shape.radiusRoles, elevation: c.shape.elevation, duration: c.motion.durations, easing: c.motion.easings });
    return Object.entries(groups).flatMap(([group, map]) => Object.keys(map).map(key => `{${group}.${key}}`));
}
export function aliasPicker(s, path, name, colorsOnly = false) {
    const id = `sg-alias-${++serial}`, host = text(s, path, name || label(path.split('.').at(-1)), { list: id });
    host.classList.add('sg-alias');
    const list = el('datalist');
    list.id = id;
    for (const ref of aliasOptions(s.config, { colorsOnly })) {
        const o = el('option');
        o.value = ref;
        list.append(o);
    }
    host.append(list);
    if (colorsOnly) {
        // What the alias resolves to, so a typo or a wrong step is visible at once.
        const swatch = el('span', 'sg-alias-swatch');
        swatch.dataset.sgSwatch = path;
        swatch.setAttribute('aria-hidden', 'true');
        const input = host.querySelector('input'), line = el('span', 'sg-input-line');
        input.before(line);
        line.append(swatch, input);
    }
    return host;
}
// Repaint every alias swatch under root (called by the sections on edit and save).
export function refreshSwatches(root, s, theme) {
    for (const n of root.querySelectorAll('[data-sg-swatch]')) {
        const path = n.dataset.sgSwatch, hex = resolveColor(s.config, s.get(path), theme || (path.includes('.dark.') ? 'dark' : 'light'));
        n.style.background = hex || 'transparent';
        n.classList.toggle('sg-unresolved', !hex);
        n.title = hex || t('styleguide.contrastUnavailable');
    }
}
export function colorField(s, path, name, onValue, { eyedropper = true } = {}) {
    const host = el('div', 'sg-color-field');
    const value = s.get(path);
    const picker = el('input', 'sg-swatch');
    picker.type = 'color';
    picker.value = (resolveColor(s.config, value) || '#000000').slice(0, 7);
    picker.setAttribute('aria-label', name || label(path.split('.').at(-1)));
    const hex = field(name || label(path.split('.').at(-1)), value, () => { }, {}), input = hex.querySelector('input');
    picker.dataset.sgPath = path;
    input.dataset.sgPath = path;
    const update = raw => {
        const value = cssColorToHex(raw);
        if (!value) {
            input.setAttribute('aria-invalid', 'true');
            hex.querySelector('.sg-validation').hidden = false;
            hex.querySelector('.sg-validation').textContent = t('styleguide.invalidColor');
            return;
        }
        input.removeAttribute('aria-invalid');
        hex.querySelector('.sg-validation').hidden = true;
        picker.value = value.slice(0, 7);
        s.set(path, value);
        onValue?.(value);
    };
    input.addEventListener('change', () => update(input.value));
    picker.addEventListener('input', () => { input.value = picker.value; update(picker.value); });
    host.append(picker, hex);
    if (eyedropper && window.EyeDropper) {
        const pick = button('◉', async () => { try {
            const { sRGBHex } = await new window.EyeDropper().open();
            input.value = sRGBHex;
            update(sRGBHex);
        }
        catch (e) {
            if (e.name !== 'AbortError')
                throw e;
        } }, 'sg-eyedropper');
        pick.setAttribute('aria-label', t('styleguide.eyedropper'));
        pick.title = t('styleguide.eyedropper');
        host.append(pick);
    }
    return host;
}
export function diffView(diff = []) {
    const host = el('div', 'sg-table-wrap');
    host.tabIndex = 0;
    host.setAttribute('aria-label', t('styleguide.previewDiff'));
    if (!diff.length) {
        host.append(el('p', 'sg-hint', t('styleguide.noDiff')));
        return host;
    }
    const table = el('table', 'sg-table'), head = el('tr');
    for (const key of ['path', 'before', 'after'])
        head.append(el('th', '', t(`styleguide.${key}`)));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    for (const d of diff) {
        const tr = el('tr');
        tr.append(el('th', '', d.path), el('td', '', JSON.stringify(d.from)), el('td', '', JSON.stringify(d.to)));
        body.append(tr);
    }
    table.append(body);
    host.append(table);
    return host;
}
export function mapEditor(s, path, { unit = '', numeric = true, max = 30, render } = {}) {
    const host = el('div', render ? 'sg-map sg-map-wide' : 'sg-map');
    const draw = () => {
        host.replaceChildren();
        const map = s.get(path);
        for (const [key, value] of Object.entries(map)) {
            const r = row(numeric ? number(s, `${path}.${key}`, unit, { name: key, min: 0 }) : text(s, `${path}.${key}`, key));
            if (render)
                r.append(render(key, value));
            r.append(button(t('styleguide.remove'), () => { const next = { ...s.get(path) }; delete next[key]; s.set(path, next); draw(); }));
            host.append(r);
        }
        const name = field(t('styleguide.tokenName'), ' ', () => { });
        name.querySelector('input').value = '';
        const add = button(t('styleguide.addToken'), () => { const key = name.querySelector('input').value.trim().replace(/[{}.\s]+/g, '-'); if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || key in s.get(path))
            return; if (Object.keys(s.get(path)).length >= max)
            throw new Error(t('styleguide.limit')); s.set(path, { ...s.get(path), [key]: numeric ? 0 : '' }); draw(); });
        host.append(row(name, add));
    };
    draw();
    return host;
}
// Safe Markdown subset: text is always escaped; no raw HTML or executable links.
export function markdownPreview(markdown) {
    const host = el('div', 'sg-markdown');
    for (const line of String(markdown || '').split('\n')) {
        const h = /^(#{1,6})\s+(.+)$/.exec(line);
        const n = el(h ? 'h' + h[1].length : /^[-*] /.test(line) ? 'li' : 'p');
        n.innerHTML = esc(h ? h[2] : line.replace(/^[-*] /, '')).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
        host.append(n);
    }
    return host;
}
export function watch(s, fn) { return s.subscribe(type => { if (type === 'edit' || type === 'saved')
    fn(); }); }
