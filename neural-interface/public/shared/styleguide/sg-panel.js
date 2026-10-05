import { t, el, row, button } from './sg-kit.js';
import { storage } from '../storage.js';
import { fetchStyleGuideProjects } from '../api.js';
import { createGuideState } from './sg-state.js';
import * as brand from './sg-brand.js';
import * as colors from './sg-colors.js';
import * as typography from './sg-typography.js';
import * as layout from './sg-layout.js';
import * as shape from './sg-shape.js';
import * as motion from './sg-motion.js';
import * as iconsLogo from './sg-icons-logo.js';
import * as imagery from './sg-imagery.js';
import * as components from './sg-components.js';
import * as rules from './sg-rules.js';
import * as agents from './sg-agents.js';
import * as preview from './sg-preview.js';
import * as importExport from './sg-import-export.js';
import * as history from './sg-history.js';
export const SECTIONS = [['brand', brand], ['colors', colors], ['typography', typography], ['layout', layout], ['shape', shape], ['motion', motion], ['icons-logo', iconsLogo], ['imagery', imagery], ['components', components], ['rules', rules], ['agents', agents], ['preview', preview], ['import-export', importExport], ['history', history]];
const icons = ['◈', '◉', 'Aa', '▦', '▢', '↝', '◇', '▧', '⊞', '✓', '⌘', '▣', '⇄', '↶'];
export function createPanel({ onClosed, projectPath } = {}) {
    const state = createGuideState(), panel = el('div', 'styleguide-panel glass resizable open');
    panel.id = 'styleguide-panel';
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'sg-panel-title');
    for (const direction of ['t', 'r', 'b', 'l', 'tl', 'tr', 'bl', 'br']) {
        const handle = el('div', `resize-handle resize-handle-${direction}`);
        handle.dataset.resize = direction;
        handle.setAttribute('aria-hidden', 'true');
        panel.append(handle);
    }
    const header = el('header', 'sg-header drag-handle');
    header.dataset.drag = 'styleguide-panel';
    const title = el('h2', '', t('styleguide.title'));
    title.id = 'sg-panel-title';
    const project = el('select', 'sg-project-select');
    project.id = 'sg-project-select';
    project.setAttribute('aria-label', t('styleguide.project'));
    const status = el('span', 'sg-status');
    status.id = 'sg-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const badge = el('span', 'sg-chip'), proposalButton = button(t('styleguide.proposals'), () => show('history', { proposals: true }));
    proposalButton.append(badge);
    const closeBtn = button(t('styleguide.close'), () => close());
    closeBtn.id = 'sg-close';
    header.append(row(title, project, status), row(button(t('styleguide.designMd'), () => show('preview', { source: true })), button(t('styleguide.export'), () => show('import-export')), button(t('styleguide.history'), () => show('history')), proposalButton, closeBtn));
    panel.append(header);
    const shell = el('div', 'sg-shell'), rail = el('nav', 'sg-rail');
    rail.setAttribute('aria-label', t('styleguide.sections'));
    const body = el('main', 'sg-body');
    body.id = 'sg-body';
    body.tabIndex = 0;
    body.setAttribute('aria-label', t('styleguide.title'));
    const error = el('div', 'sg-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const retry = button(t('styleguide.retry'), async () => { if (state.config)
        await state.flush({ force: true });
    else
        await load(project.value); });
    retry.hidden = true;
    let active = 'brand', sectionCleanup = null, renderSeq = 0, closed = false, closing = false;
    const previousFocus = document.activeElement, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    async function show(id, options = {}) {
        if (closed)
            return;
        active = id;
        const seq = ++renderSeq;
        sectionCleanup?.();
        sectionCleanup = null;
        rail.querySelectorAll('button').forEach(n => { n.classList.toggle('active', n.dataset.section === id); n.setAttribute('aria-current', n.dataset.section === id ? 'page' : 'false'); });
        body.replaceChildren(el('h2', 'sg-page-title', t(`styleguide.section.${id}.title`)), el('p', 'sg-purpose sg-page-purpose', t(`styleguide.section.${id}.purpose`)));
        body.scrollTop = 0;
        if (!state.config) {
            body.append(el('p', 'sg-empty', t('styleguide.empty')));
            return;
        }
        const fields = el('fieldset', 'sg-fields');
        fields.disabled = state.busy;
        body.append(fields);
        const content = el('div', 'sg-content');
        fields.append(content);
        try {
            const cleanup = await SECTIONS.find(([key]) => key === id)[1].render(content, state, options);
            if (seq !== renderSeq || closed)
                cleanup?.();
            else
                sectionCleanup = cleanup;
            // A re-render (after restore, accept, import…) removes the focused control: keep focus in the dialog.
            if (seq === renderSeq && !closed && !panel.contains(document.activeElement))
                body.focus({ preventScroll: true });
        }
        catch (e) {
            if (seq === renderSeq) {
                error.hidden = false;
                error.textContent = e.message;
            }
        }
    }
    SECTIONS.forEach(([id], i) => { const n = button('', () => show(id), 'sg-rail-button'); n.dataset.section = id; n.setAttribute('aria-label', t(`styleguide.section.${id}.title`)); n.title = t(`styleguide.section.${id}.title`); const icon = el('span', 'sg-rail-icon', icons[i]); icon.setAttribute('aria-hidden', 'true'); n.append(icon, el('span', 'sg-rail-label', t(`styleguide.section.${id}.title`))); rail.append(n); });
    shell.append(rail, body);
    panel.append(error, retry, shell);
    function update(type) {
        status.dataset.state = state.status;
        status.textContent = ['saved', 'defaults'].includes(state.status) ? t(`styleguide.${state.status}`, { revision: state.meta.revision || 0, files: (state.meta.written || []).filter(f => f.exists !== false).length }) : state.status === 'error' ? t('styleguide.error', { message: state.error?.message || '' }) : t(`styleguide.${state.status}`);
        badge.textContent = state.meta.proposalsPending || 0;
        badge.hidden = !state.meta.proposalsPending;
        proposalButton.setAttribute('aria-label', `${t('styleguide.proposals')} · ${state.meta.proposalsPending || 0}`);
        const fields = body.querySelector('fieldset');
        if (fields)
            fields.disabled = state.busy;
        project.disabled = state.busy || state.status === 'loading';
        if (state.error) {
            error.hidden = false;
            error.textContent = state.error.message;
            retry.hidden = false;
        }
        else {
            error.hidden = true;
            retry.hidden = true;
        }
        if (type === 'saved')
            body.querySelectorAll('[data-sg-path]').forEach(input => { if (document.activeElement === input)
                return; const value = state.get(input.dataset.sgPath); if (value === undefined)
                return; if (input.type === 'checkbox')
                input.checked = !!value;
            else
                input.value = input.type === 'color' ? String(value).slice(0, 7) : (value ?? ''); });
        if (type === 'load')
            show(active);
    }
    const unsubscribe = state.subscribe(update);
    async function load(path) { if (!path)
        return; try {
        await state.load(path);
        storage.setItem('styleguide.lastProject', path);
    }
    catch (e) {
        project.value = state.projectPath || path;
        error.hidden = false;
        error.textContent = e.message;
    } }
    project.addEventListener('change', () => load(project.value));
    const keydown = e => {
        if (closed)
            return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            e.stopImmediatePropagation();
            state.flush().catch(() => { });
            return;
        }
        if (e.key === 'Tab') {
            const targets = [...panel.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(n => !n.disabled && !n.closest('[hidden]') && n.getClientRects().length);
            const first = targets[0], last = targets.at(-1);
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
            }
            else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
            }
        }
    };
    // Window capture runs before every document listener the app registered at boot, so a
    // background feature (map, whiteboard, tutorial) cannot swallow Esc or Cmd/Ctrl+S.
    window.addEventListener('keydown', keydown, true);
    // CSS caps the panel at the viewport; this keeps its position on screen when the window shrinks.
    const fit = () => {
        if (closed)
            return;
        panel.style.maxHeight = '';
        const r = panel.getBoundingClientRect();
        panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
        panel.style.top = Math.max(8, Math.min(r.top, window.innerHeight - r.height - 8)) + 'px';
    };
    window.addEventListener('resize', fit);
    async function close() { if (closed || closing)
        return; closing = true; try {
        await state.flush();
    }
    catch {
        closing = false;
        return;
    } closed = true; renderSeq++; sectionCleanup?.(); unsubscribe(); state.destroy(); window.removeEventListener('keydown', keydown, true); window.removeEventListener('resize', fit); document.body.style.overflow = previousOverflow; panel.remove(); previousFocus?.focus?.(); onClosed?.(); }
    const ready = (async () => {
        try {
            const projects = await fetchStyleGuideProjects();
            if (closed)
                return;
            for (const p of projects) {
                const o = el('option', '', p.label || p.path);
                o.value = p.path;
                project.append(o);
            }
            if (!projects.length) {
                const o = el('option', '', t('styleguide.noProjects'));
                o.value = '';
                project.append(o);
                show('brand');
                return;
            }
            const wanted = projectPath || storage.getItem('styleguide.lastProject'), initial = projects.some(p => p.path === wanted) ? wanted : projects[0].path;
            project.value = initial;
            await load(initial);
        }
        catch (e) {
            error.hidden = false;
            error.textContent = e.message;
            retry.hidden = false;
        }
        finally {
            if (!closed)
                closeBtn.focus();
        }
    })();
    return { panel, state, ready, close, show };
}
