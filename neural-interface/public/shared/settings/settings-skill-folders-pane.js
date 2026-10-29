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
import { chipState, installedToast, lastUndoable, readFoldersStatus, readMigrationOutcome, readMigrationPlan, readRevertOutcome, toggledAssistants } from './settings-skill-folders.js';
import { fetchClaudeCodeSkills, fetchSkillsConfig, fetchSkillsMigrations, fetchSkillsStatus, planSkillsBridgeMigration, planSkillsBridgeMigrationConfirmed, revertSkillsMigration, runSkillsBridgeMigration, saveSkillsConfig } from '../api.js';
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
            <div class="cc-skill-row" id="stg-skill-folders-assistants" hidden>
              <div class="cc-skill-info">
                <span class="cc-skill-name">${kit.te('settings.redesign.skills.assistants.title')}</span>
                <span class="cc-skill-desc" id="stg-skill-folders-assistants-help">${kit.te('settings.redesign.skills.assistants.help')}</span>
              </div>
              <div class="cc-skill-targets" role="group" aria-label="${kit.te('settings.redesign.skills.assistants.title')}" id="stg-skill-folders-assistants-chips"></div>
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
  const assistantsRow = $('stg-skill-folders-assistants');
  const assistantChips = $('stg-skill-folders-assistants-chips');
  const assistantsHelp = $('stg-skill-folders-assistants-help');
  let plan = null;
  let undoable = null;
  let working = false;
  let assistants = null;
  const ticked = new Set();   // the offered bridges the owner ticked ("Move it too")

  const busy = (yes) => { working = yes; for (const b of [review, move, cancel, undo, sharedToggle, ...assistantChips.querySelectorAll('button'), ...planList.querySelectorAll('input')]) if (b) b.disabled = yes; };
  const showPlan = (reading) => {
    planList.replaceChildren(...reading.lines.map((line) => {
      const li = document.createElement('li');
      li.dataset.tone = line.tone;
      if (line.offer) {
        // A bridge file of a shipped skill that is not proven SynaBun's: moved only when the owner ticks it here.
        const label = document.createElement('label');
        label.className = 'stg-skill-folders-offer';
        const box = document.createElement('input');
        box.type = 'checkbox'; box.checked = !!line.offer.on; box.dataset.bridge = line.bridgeId; box.dataset.digest = line.offer.digest;
        box.setAttribute('aria-label', kit.tx('settings.redesign.skills.folders.offerTick', { name: line.params.name }));
        const text = document.createElement('span');
        text.textContent = say(line);
        label.append(box, text);
        li.append(label);
      } else li.textContent = say(line);
      return li;
    }));
    planList.hidden = !reading.lines.length;
  };
  // A plan on screen: its lines, Move only when something would move, Cancel to put the block back.
  const present = (next) => {
    plan = next;
    const reading = readMigrationPlan(plan, ticked);
    showPlan(reading);
    if (reading.empty) status.textContent = say(reading.empty);
    move.hidden = reading.movable === 0;
    cancel.hidden = false;
    review.hidden = true;
  };
  // An offer ticked or unticked: the plan is asked again with the confirmations (a confirmed plan is another plan,
  // taken by its own digest), and shown.
  planList.addEventListener('change', async (e) => {
    const box = e.target;
    if (!box?.dataset?.bridge) return;
    if (box.checked) ticked.add(box.dataset.bridge); else ticked.delete(box.dataset.bridge);
    busy(true);
    try {
      const confirm = Object.fromEntries([...planList.querySelectorAll('input[data-bridge]')].filter((b) => ticked.has(b.dataset.bridge)).map((b) => [b.dataset.bridge, b.dataset.digest]));
      present((await planSkillsBridgeMigrationConfirmed(confirm)).plan);
    } catch (err) { toast(kit.tx('settings.redesign.skills.folders.failed', { message: err.message }), 6000); }
    finally { busy(false); }
  });
  const drawAssistants = () => {
    if (!assistants) { assistantsRow.hidden = true; return; }
    assistantsRow.hidden = false;
    assistantChips.replaceChildren(...assistants.chips.map((chip) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cc-skill-target${chip.on ? ' on' : ''}`;
      b.dataset.assistant = chip.id;
      b.setAttribute('aria-pressed', chip.on ? 'true' : 'false');
      b.textContent = kit.tx(chip.key);
      b.title = kit.tx(chip.on ? 'settings.redesign.skills.assistants.chipOn' : 'settings.redesign.skills.assistants.chipOff', { assistant: kit.tx(chip.key) });
      return b;
    }));
    const detected = assistants.detectedWords.map((w) => kit.tx(w.key)).join(', ');
    assistantsHelp.textContent = `${kit.tx('settings.redesign.skills.assistants.help')} ${kit.tx(assistants.auto ? 'settings.redesign.skills.assistants.detected' : 'settings.redesign.skills.assistants.chosen', { detected })}`;
    if (!assistants.auto) {
      const reset = document.createElement('button');
      reset.type = 'button'; reset.className = 'cc-skill-target'; reset.dataset.assistant = 'auto';
      reset.textContent = kit.tx('settings.redesign.skills.assistants.useDetected');
      reset.title = kit.tx('settings.redesign.skills.assistants.detected', { detected });
      assistantChips.append(reset);
    }
  };
  assistantChips.addEventListener('click', async (e) => {
    const chip = e.target.closest?.('button[data-assistant]');
    if (!chip || chip.disabled || !assistants) return;
    const next = chip.dataset.assistant === 'auto' ? null : toggledAssistants(assistants.effective, chip.dataset.assistant);
    busy(true);
    try { await saveSkillsConfig({ assistants: next }); }
    catch (err) { toast(kit.tx('settings.redesign.skills.folders.failed', { message: err.message }), 6000); }
    finally { busy(false); }
    await refresh();
  });
  async function refresh() {
    let answer = null;
    try { answer = await fetchSkillsStatus(); } catch { answer = null; }
    const reading = readFoldersStatus(answer);
    status.textContent = say(reading.message);
    if (!reading.available) { for (const el of [others, planList, review, move, cancel, undo, shared, assistantsRow]) el.hidden = true; return; }
    // The owner's assistants: the status carries them on a server with the preference; GET /config is the fuller read.
    assistants = reading.assistants;
    if (assistants) { try { const cfg = await fetchSkillsConfig(); if (cfg?.assistants) assistants = readFoldersStatus({ ok: true, bridges: {}, assistants: cfg.assistants }).assistants; } catch { /* the status' view */ } }
    drawAssistants();
    ticked.clear();
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
    const reading = readMigrationPlan(plan, ticked);
    if (!reading.planDigest) return;
    busy(true);
    try {
      const out = await runSkillsBridgeMigration(reading.planDigest, reading.confirm);
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
