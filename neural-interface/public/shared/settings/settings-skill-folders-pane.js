// ═══════════════════════════════════════════
// SynaBun Neural Interface — Settings → Skills: the skill folders block
// ═══════════════════════════════════════════
//
// Under the skill chips: the move of SynaBun's old Codex prompt / OpenCode command bridges to native skill
// folders (review it, move them, undo the last move) and the switch that lets installs go into the shared
// ~/.agents/skills. Nothing moves when Settings opens: the owner reads the plan and presses Move (the server checks
// the plan's digest, installs the native folder first, keeps each bridge's bytes in the move's journal, and leaves
// every file that is not SynaBun's where it is). Words and states come from settings-skill-folders.js; requests
// carry the X-SynaBun-UI header the owner-only routes ask for (api.js). A change made anywhere else (another window,
// the Studio, an agent's submission, an install) reaches the block and the chips through `skills:changed`, in place,
// never under a plan the owner is reading.

import * as kit from './settings-kit.js';
import { chipState, installedToast, lastUndoable, readFoldersStatus, readMigrationOutcome, readMigrationPlan, readRevertOutcome } from './settings-skill-folders.js';
import { fetchClaudeCodeSkills, fetchSkillsMigrations, fetchSkillsStatus, planSkillsBridgeMigration, revertSkillsMigration, runSkillsBridgeMigration, saveSkillsConfig } from '../api.js';
import { on } from '../state.js';

export { chipState, installedToast };

const params = (p) => Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [k, v && typeof v === 'object' && typeof v.key === 'string' ? kit.tx(v.key) : v]));
const say = (m) => (m ? kit.tx(m.key, params(m.params)) : '');

/** The block's markup (filled in by wireSkillFolders once the server answers). */
export function skillFoldersHTML() {
  return `
          <div class="stg-skill-folders" id="stg-skill-folders">
            ${kit.subhead(kit.te('settings.redesign.skills.folders.title'))}
            <div class="stg-help" id="stg-skill-folders-status" role="status" aria-live="polite" style="margin-top:0">${kit.te('settings.redesign.skills.folders.loading')}</div>
            <div class="stg-help" id="stg-skill-folders-others" hidden></div>
            <ul class="stg-help" id="stg-skill-folders-plan" hidden></ul>
            <div class="cc-skill-targets" role="group" id="stg-skill-folders-actions">
              <button type="button" class="cc-skill-target" id="stg-skill-folders-review" hidden>${kit.te('settings.redesign.skills.folders.review')}</button>
              <button type="button" class="cc-skill-target" id="stg-skill-folders-move" hidden>${kit.te('settings.redesign.skills.folders.move')}</button>
              <button type="button" class="cc-skill-target" id="stg-skill-folders-cancel" hidden>${kit.te('settings.redesign.skills.folders.cancel')}</button>
              <button type="button" class="cc-skill-target" id="stg-skill-folders-undo" hidden>${kit.te('settings.redesign.skills.folders.undo')}</button>
            </div>
            <div class="cc-skill-row" id="stg-skill-folders-shared" hidden>
              <div class="cc-skill-info">
                <span class="cc-skill-name">${kit.te('settings.redesign.skills.folders.sharedLabel')}</span>
                <span class="cc-skill-desc">${kit.te('settings.redesign.skills.folders.sharedHelp')}</span>
              </div>
              <div class="cc-skill-targets"><button type="button" class="cc-skill-target" id="stg-skill-folders-shared-toggle" aria-pressed="false">${kit.te('settings.redesign.skills.folders.sharedOff')}</button></div>
            </div>
          </div>`;
}

/**
 * Read the skills again and redraw each runtime chip in place (its state, pressed, title). A chip that is being
 * clicked is left to its own request.
 * @param {HTMLElement} root the Settings overlay
 */
export async function refreshSkillChips(root) {
  let skills;
  try { skills = (await fetchClaudeCodeSkills())?.skills; } catch { return; }
  if (!Array.isArray(skills)) return;
  const byDir = new Map(skills.map((skill) => [skill.dirName, skill]));
  for (const chip of root.querySelectorAll('.cc-skill-target[data-cc-skill][data-cc-target]')) {
    const skill = byDir.get(chip.dataset.ccSkill);
    if (!skill || chip.style.pointerEvents === 'none') continue;
    const target = chip.dataset.ccTarget;
    const installed = skill.installedTargets || { claude: !!skill.installed, codex: false, opencode: false };
    const now = chipState(skill.targetStates?.[target], !!installed[target]);
    chip.classList.toggle('on', now.on);
    chip.dataset.state = now.on ? 'on' : 'off';
    chip.dataset.installState = now.state;
    chip.setAttribute('aria-pressed', now.on ? 'true' : 'false');
    chip.title = kit.tx(now.key, { skill: skill.name || skill.dirName, assistant: chip.textContent.trim() });
    const row = chip.closest('.cc-skill-row');
    if (row) row.classList.toggle('installed', !!row.querySelector('.cc-skill-target.on'));
  }
}

/**
 * Fill the block in and wire its buttons.
 * @param {HTMLElement} root the Settings overlay
 * @param {{ toast?: (msg: string, ms?: number) => void, onChanged?: () => void, signal?: AbortSignal }} [o]
 *   `onChanged`: something here (or elsewhere) changed the skills; `signal`: the panel's life (its listeners end with it)
 */
export async function wireSkillFolders(root, { toast = () => {}, onChanged = () => {}, signal = null } = {}) {
  const box = root.querySelector('#stg-skill-folders');
  if (!box) return;
  const $ = (id) => box.querySelector(`#${id}`);
  const status = $('stg-skill-folders-status');
  const others = $('stg-skill-folders-others');
  const planList = $('stg-skill-folders-plan');
  const review = $('stg-skill-folders-review');
  const move = $('stg-skill-folders-move');
  const cancel = $('stg-skill-folders-cancel');
  const undo = $('stg-skill-folders-undo');
  const shared = $('stg-skill-folders-shared');
  const sharedToggle = $('stg-skill-folders-shared-toggle');
  let plan = null;
  let undoable = null;
  let working = false;

  const busy = (yes) => { working = yes; for (const b of [review, move, cancel, undo, sharedToggle]) if (b) b.disabled = yes; };
  const showPlan = (reading) => {
    planList.replaceChildren(...reading.lines.map((line) => { const li = document.createElement('li'); li.textContent = say(line); li.dataset.tone = line.tone; return li; }));
    planList.hidden = !reading.lines.length;
  };
  // A plan on screen: its lines, Move only when something would move, Cancel to put the block back.
  const present = (next) => {
    plan = next;
    const reading = readMigrationPlan(plan);
    showPlan(reading);
    if (reading.empty) status.textContent = say(reading.empty);
    move.hidden = reading.movable === 0;
    cancel.hidden = false;
    review.hidden = true;
  };
  async function refresh() {
    let answer = null;
    try { answer = await fetchSkillsStatus(); } catch { answer = null; }
    const reading = readFoldersStatus(answer);
    status.textContent = say(reading.message);
    if (!reading.available) { for (const el of [others, planList, review, move, cancel, undo, shared]) el.hidden = true; return; }
    others.hidden = !reading.others;
    others.textContent = say(reading.others);
    review.hidden = !reading.canReview;
    move.hidden = true; cancel.hidden = true; planList.hidden = true; plan = null;
    shared.hidden = false;
    sharedToggle.classList.toggle('on', reading.sharedAgentsRoot);
    sharedToggle.setAttribute('aria-pressed', reading.sharedAgentsRoot ? 'true' : 'false');
    sharedToggle.textContent = kit.tx(reading.sharedAgentsRoot ? 'settings.redesign.skills.folders.sharedOn' : 'settings.redesign.skills.folders.sharedOff');
    try { undoable = lastUndoable((await fetchSkillsMigrations()).migrations); } catch { undoable = null; }
    undo.hidden = !undoable;
  }

  review.addEventListener('click', async () => {
    busy(true);
    try {
      present((await planSkillsBridgeMigration()).plan);
    } catch (err) { toast(kit.tx('settings.redesign.skills.folders.failed', { message: err.message }), 6000); }
    finally { busy(false); }
  });
  cancel.addEventListener('click', () => refresh());
  move.addEventListener('click', async () => {
    const reading = readMigrationPlan(plan);
    if (!reading.planDigest) return;
    busy(true);
    try {
      const out = await runSkillsBridgeMigration(reading.planDigest);
      toast(say(readMigrationOutcome(out)), 8000);
      onChanged();
    } catch (err) {
      // The bridges or their destinations changed since the plan was shown: nothing moved, the new plan is shown.
      if (err.code === 'plan_changed' && err.body?.plan) { present(err.body.plan); toast(kit.tx('settings.redesign.skills.folders.planChanged'), 8000); return; }
      toast(kit.tx('settings.redesign.skills.folders.failed', { message: err.message }), 6000);
    } finally { busy(false); }
    await refresh();
  });
  undo.addEventListener('click', async () => {
    if (!undoable) return;
    busy(true);
    try {
      const out = await revertSkillsMigration(undoable.journalId);
      toast(say(readRevertOutcome(out)), 8000);
      onChanged();
    } catch (err) { toast(kit.tx('settings.redesign.skills.folders.failed', { message: err.message }), 6000); }
    finally { busy(false); }
    await refresh();
  });
  sharedToggle.addEventListener('click', async () => {
    const next = sharedToggle.getAttribute('aria-pressed') !== 'true';
    busy(true);
    try { await saveSkillsConfig({ sharedAgentsRoot: next }); }
    catch (err) { toast(kit.tx('settings.redesign.skills.folders.failed', { message: err.message }), 6000); }
    finally { busy(false); }
    await refresh();
  });
  // Changes from anywhere else: the chips follow at once; the block follows unless a plan is on screen or a request
  // of its own is under way (a move is taken only by the digest of the plan shown, so a stale plan moves nothing).
  let soon = 0;
  const stop = on('sync:skills:changed', () => {
    clearTimeout(soon);
    soon = setTimeout(() => {
      if (!box.isConnected) { stop(); return; }
      onChanged();
      if (!plan && !working) refresh();
    }, 300);
  });
  signal?.addEventListener('abort', () => { stop(); clearTimeout(soon); }, { once: true });
  if (signal?.aborted) { stop(); return; }
  await refresh();
}
