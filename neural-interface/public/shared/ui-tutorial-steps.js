// ═══════════════════════════════════════════
// TUTORIAL STEP DEFINITIONS
// ═══════════════════════════════════════════
//
// Each step describes what to show and how.
// Steps with whiteboardMode: true render directly on the whiteboard
// using a render() function. Others use the legacy overlay+card mode.

import {
  handwrittenLabel,
  createDoodle,
  createHandDrawnUnderline,
  createAnimatedArrow,
  createWobblyCircle,
} from './ui-tutorial-draw.js';
import { emit } from './state.js';
import { storage, flushStorage } from './storage.js';
import { KEYS } from './constants.js';
import { createTerminalSession } from './api.js';
import { openSettingsModal } from './ui-settings.js';


// ── Settings hint (shown when user declines explore) ──────────
function _showSettingsHint(svg, dom, cx, cy, goToStep) {
  svg.innerHTML = '';
  dom.innerHTML = '';

  handwrittenLabel(svg, 'You can do this at any time from Project Settings', {
    x: cx,
    y: cy,
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 28,
    textAnchor: 'middle',
    duration: 400,
  });

  createDoodle(svg, 'star', {
    x: cx + 280,
    y: cy - 30,
    scale: 0.9,
    color: 'rgba(255, 255, 255, 0.25)',
    duration: 400,
  });

  createDoodle(svg, 'sparkle', {
    x: cx - 290,
    y: cy - 20,
    scale: 0.8,
    color: 'rgba(255, 255, 255, 0.2)',
    duration: 350,
  });

  // Continue button — user clicks to advance (no auto-timer)
  const contEl = document.createElement('div');
  contEl.className = 'wb-tutorial-btn';
  contEl.textContent = 'Continue';
  contEl.style.cssText = `
    position: absolute; left: ${cx}px; top: ${cy + 60}px;
    transform: translate(-50%, 0);
    font-family: 'Caveat', cursive; font-size: 22px;
    color: rgba(255, 255, 255, 0.35);
    pointer-events: auto; opacity: 0;
    transition: opacity 0.4s ease 0.8s;
  `;
  dom.appendChild(contEl);
  requestAnimationFrame(() => { contEl.style.opacity = '1'; });
  contEl.addEventListener('mouseenter', () => {
    contEl.style.color = 'rgba(255, 255, 255, 0.7)';
    contEl.style.transform = 'translate(-50%, 0) scale(1.08)';
  });
  contEl.addEventListener('mouseleave', () => {
    contEl.style.color = 'rgba(255, 255, 255, 0.35)';
    contEl.style.transform = 'translate(-50%, 0) scale(1)';
  });
  contEl.addEventListener('click', () => {
    goToStep(6);
  });
}


// ── Exploration prompt (injected into CLI on launch) ────────
// This prompt MUST be forceful and explicit — weaker models (Haiku, Flash, o4-mini)
// will only follow instructions that are direct and structured as mandatory steps.
export function buildExplorePrompt(projectSlug) {
  const cat = projectSlug || 'project';
  const catProject = `${cat}-project`;
  const catArch = `${cat}-architecture`;
  const catConfig = `${cat}-config`;

  // PTY sends raw bytes — newlines would trigger early submission in CLI prompts.
  // Join as single line with ' | ' separating phases for readability by the model.
  return [
    `EXPLORATION MODE — FULL CODEBASE ANALYSIS.`,
    `You are a codebase analyst. Your ONLY job is to deeply explore this project and create detailed persistent memories using SynaBun MCP tools. Do NOT ask for confirmation. Do NOT summarize what you will do. Execute each phase immediately.`,

    `PHASE 0 — SETUP CATEGORIES (do this FIRST):`,
    `Call the \`category\` tool 4 times with action "create":`,
    `(1) name: "${cat}", description: "Knowledge and context for the ${cat} project", is_parent: true.`,
    `(2) name: "${catProject}", description: "General project knowledge, decisions, and milestones", parent: "${cat}".`,
    `(3) name: "${catArch}", description: "System design, tech stack, data flow, and component architecture", parent: "${cat}".`,
    `(4) name: "${catConfig}", description: "Configuration, deployment, environment, and infrastructure", parent: "${cat}".`,
    `If a category already exists, skip it and continue.`,

    `PHASE 1 — PROJECT IDENTITY (create 2-3 memories in "${catProject}"):`,
    `Read README.md, package.json (or Cargo.toml/go.mod/pyproject.toml), and any CONTRIBUTING or ARCHITECTURE docs. Create memories covering: project purpose, what it does, who it's for, main scripts/commands, key dependencies and their roles.`,

    `PHASE 2 — DIRECTORY MAP (create 1-2 memories in "${catArch}"):`,
    `List the top-level directory structure, then list contents of each major source directory (src/, lib/, app/, components/, etc.). Create a memory with the full directory tree and a brief note on what each directory contains.`,

    `PHASE 3 — ARCHITECTURE DEEP DIVE (create 4-8 memories in "${catArch}"):`,
    `Read and analyze these areas ONE BY ONE. For EACH area, read the actual source files, then create a SEPARATE memory:`,
    `(a) Entry points and routing — how the app starts, route definitions, middleware.`,
    `(b) Core modules — main business logic files, what each does, how they interact.`,
    `(c) Data layer — database schemas, ORMs, migrations, API clients, data models and types.`,
    `(d) State management — stores, contexts, reducers, reactive patterns.`,
    `(e) Component architecture — UI component hierarchy, shared components, layouts.`,
    `(f) API surface — endpoints, handlers, request/response shapes, authentication flow.`,
    `(g) Key patterns — singletons, dependency injection, event systems, error handling conventions.`,
    `(h) External integrations — third-party APIs, SDKs, webhooks.`,
    `Skip areas that do not apply. But for each that DOES exist, you MUST read the files and create a memory.`,

    `PHASE 4 — CONFIGURATION (create 2-4 memories in "${catConfig}"):`,
    `(a) Build config — bundler, compiler settings, output targets.`,
    `(b) Environment — .env structure, required env vars, feature flags.`,
    `(c) CI/CD — deployment scripts, Docker configs, hosting setup.`,
    `(d) Dev tooling — linting, formatting, testing framework, pre-commit hooks.`,

    `PHASE 5 — CODE STYLE (create 1 memory in "${catProject}"):`,
    `Read 3-4 representative source files. Note: file naming, variable naming, import style, module pattern, indentation, comment style.`,

    `PHASE 6 — FINAL SUMMARY (create 1 memory in "${catProject}", importance: 8):`,
    `Create one comprehensive summary a developer needs to understand this project from scratch: what it is, how it is built, how to work on it, what to watch out for.`,

    `RULES:`,
    `Every \`remember\` call MUST include: related_files (array of file paths you read), importance (6-7 for details, 8 for summaries), project: "${cat}", and 3-5 tags.`,
    `You MUST create at minimum 12 memories total. If you finish with fewer, go back and explore deeper.`,
    `Read actual file contents — do NOT guess from file names alone.`,
    `Do NOT batch everything into one giant memory — each memory covers ONE specific topic.`,
    `Do NOT ask the user anything. Do NOT explain what you are about to do. Just execute.`,
    `After all phases, say "Exploration complete" and list memories created per category.`,
    `Begin PHASE 0 now.`,
  ].join(' ');
}

// ── Launch exploration CLI session ──────────────────────────
async function _launchExploration(goToStep) {
  console.log('[SynaBun] _launchExploration: starting');
  const cli = storage.getItem(KEYS.ONBOARDING_CLI) || 'claude-code';
  const model = storage.getItem(KEYS.ONBOARDING_MODEL) || null;

  // Use the project chosen in the onboarding project picker (step 4)
  let cwd = null;
  let projectSlug = null;
  try {
    const stored = JSON.parse(storage.getItem(KEYS.ONBOARDING_PROJECT) || 'null');
    if (stored?.path) {
      cwd = stored.path;
      const folderName = stored.label || cwd.split(/[\\/]/).filter(Boolean).pop() || 'project';
      projectSlug = folderName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    }
  } catch { /* fallback to null (home dir) */ }

  const prompt = buildExplorePrompt(projectSlug);

  try {
    const result = await createTerminalSession(cli, 120, 30, cwd, model ? { model } : {});
    console.log('[SynaBun] _launchExploration: session created, id =', result?.sessionId);
    if (result?.sessionId) {
      emit('terminal:attach-floating', {
        terminalSessionId: result.sessionId,
        profile: cli,
        initialMessage: prompt,
        autoSubmit: true,
      });
    }
  } catch (err) {
    console.error('[SynaBun] Exploration launch failed:', err);
  }

  // Advance to tutorial welcome regardless of launch success
  goToStep(6);
}


export const TUTORIAL_STEPS = [
  // ── Step 0: Explore Your Project? (onboarding pre-step) ───
  {
    id: 'onboarding-explore',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, goToStep, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 40;

      // 1. Hand-drawn question text
      seq.add(() => handwrittenLabel(svg, 'Explore your project and create memories?', {
        x: cx,
        y: cy,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 34,
        textAnchor: 'middle',
        duration: 400,
      }), 200);

      // 2. Decorative sparkle doodles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 260,
        y: cy - 55,
        scale: 1.1,
        color: 'rgba(255, 255, 255, 0.3)',
        duration: 350,
      }), 200);

      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx + 230,
        y: cy + 15,
        scale: 0.85,
        color: 'rgba(255, 255, 255, 0.3)',
        duration: 350,
      }), 200);

      // 3. Yes / No buttons
      seq.add(() => {
        const btnY = cy + 50;
        const gap = 80;

        const yesEl = createButton(dom, 'Yes', {
          x: cx - gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 28,
          onClick: () => {
            storage.setItem(KEYS.ONBOARDING_EXPLORE, 'yes');
            flushStorage();
            nextStep();
          },
        });

        const noEl = createButton(dom, 'No', {
          x: cx + gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 28,
          onClick: () => {
            storage.setItem(KEYS.ONBOARDING_EXPLORE, 'no');
            flushStorage();
            _showSettingsHint(svg, dom, cx, cy, goToStep);
          },
        });

        // Hand-drawn underlines beneath buttons
        setTimeout(() => {
          const yesRect = yesEl.getBoundingClientRect();
          const noRect = noEl.getBoundingClientRect();
          createHandDrawnUnderline(svg, yesRect, {
            color: 'rgba(255, 255, 255, 0.22)',
            wobbleSeed: 'explore-yes-ul', duration: 250, offset: 2,
          });
          createHandDrawnUnderline(svg, noRect, {
            color: 'rgba(255, 255, 255, 0.22)',
            wobbleSeed: 'explore-no-ul', duration: 250, offset: 2,
          });
        }, 100);

        return {
          destroy() { yesEl.remove(); noEl.remove(); },
        };
      }, 200);
    },
  },

  // ── Step 1: Token Warning (Red Alert) ─────────────────────
  {
    id: 'onboarding-token-warning',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, goToStep, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 40;

      // 1. Red-tinted alert heading
      seq.add(() => handwrittenLabel(svg, 'Heads up!', {
        x: cx,
        y: cy - 30,
        color: 'rgba(239, 83, 80, 0.65)',
        fontSize: 38,
        textAnchor: 'middle',
        duration: 400,
      }), 200);

      // 2. Warning message body (white, not red)
      seq.add(() => handwrittenLabel(svg, 'Exploring your project can burn tokens.', {
        x: cx,
        y: cy + 20,
        color: 'rgba(255, 255, 255, 0.45)',
        fontSize: 26,
        textAnchor: 'middle',
        duration: 350,
      }), 300);

      seq.add(() => handwrittenLabel(svg, 'Choose your model and provider with caution.', {
        x: cx,
        y: cy + 55,
        color: 'rgba(255, 255, 255, 0.35)',
        fontSize: 24,
        textAnchor: 'middle',
        duration: 350,
      }), 200);

      // 3. Alert triangle doodles
      seq.add(() => createDoodle(svg, 'alert', {
        x: cx - 250,
        y: cy - 50,
        scale: 1.0,
        color: 'rgba(239, 83, 80, 0.3)',
        duration: 350,
      }), 200);

      seq.add(() => createDoodle(svg, 'alert', {
        x: cx + 230,
        y: cy + 10,
        scale: 0.8,
        color: 'rgba(239, 83, 80, 0.25)',
        duration: 350,
      }), 200);

      // 4. Continue / Back buttons
      seq.add(() => {
        const btnY = cy + 110;
        const gap = 90;

        const backEl = createButton(dom, 'Back', {
          x: cx - gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 24,
          onClick: () => prevStep(),
        });

        const contEl = createButton(dom, 'Continue', {
          x: cx + gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.45)',
          fontSize: 24,
          onClick: () => nextStep(),
        });

        // Subtle underlines
        setTimeout(() => {
          const backRect = backEl.getBoundingClientRect();
          const contRect = contEl.getBoundingClientRect();
          createHandDrawnUnderline(svg, backRect, {
            color: 'rgba(255, 255, 255, 0.15)',
            wobbleSeed: 'warn-back-ul', duration: 250, offset: 2,
          });
          createHandDrawnUnderline(svg, contRect, {
            color: 'rgba(255, 255, 255, 0.15)',
            wobbleSeed: 'warn-cont-ul', duration: 250, offset: 2,
          });
        }, 100);

        return {
          destroy() { backEl.remove(); contEl.remove(); },
        };
      }, 200);
    },
  },

  // ── Step 2: CLI Picker ─────────────────────────────────────
  {
    id: 'onboarding-cli-picker',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, goToStep, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 50;

      // SVG logo paths (same as tic-tac-toe opponent picker)
      const ICON_CLAUDE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
      const ICON_OPENAI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>';
      const ICON_GEMINI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>';

      const CLIS = [
        { id: 'claude-code', icon: ICON_CLAUDE, label: 'Claude Code', desc: 'Anthropic' },
        { id: 'codex',       icon: ICON_OPENAI, label: 'Codex CLI',   desc: 'OpenAI' },
        { id: 'gemini',      icon: ICON_GEMINI, label: 'Gemini CLI',  desc: 'Google' },
      ];

      // 1. Title
      seq.add(() => handwrittenLabel(svg, 'Pick your CLI', {
        x: cx, y: cy - 20,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 34, textAnchor: 'middle', duration: 400,
      }), 200);

      // 2. CLI cards (DOM elements, same style as ttt-picker)
      seq.add(() => {
        const cardY = cy + 40;
        const gap = 130;
        const els = [];

        CLIS.forEach((cli, i) => {
          const x = cx + (i - 1) * gap;
          const card = document.createElement('div');
          card.style.cssText = `
            position: absolute; left: ${x}px; top: ${cardY}px;
            transform: translate(-50%, 0);
            display: flex; flex-direction: column; align-items: center; gap: 8px;
            padding: 16px 22px; border: 1px solid rgba(255,255,255,0.06);
            border-radius: 12px; background: rgba(255,255,255,0.02);
            cursor: pointer; pointer-events: auto;
            transition: all 0.2s ease; opacity: 0;
          `;
          card.innerHTML = `
            <div style="width:36px;height:36px;color:rgba(255,255,255,0.4);transition:color 0.2s">${cli.icon}</div>
            <div style="font-family:'Caveat',cursive;font-size:18px;color:rgba(255,255,255,0.45);user-select:none;transition:color 0.2s">${cli.label}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.25);user-select:none">${cli.desc}</div>
          `;
          dom.appendChild(card);
          requestAnimationFrame(() => { card.style.opacity = '1'; });

          card.addEventListener('mouseenter', () => {
            card.style.background = 'rgba(255,255,255,0.06)';
            card.style.borderColor = 'rgba(255,255,255,0.15)';
            card.style.transform = 'translate(-50%, 0) translateY(-2px)';
            card.querySelector('div').style.color = 'rgba(255,255,255,0.7)';
          });
          card.addEventListener('mouseleave', () => {
            card.style.background = 'rgba(255,255,255,0.02)';
            card.style.borderColor = 'rgba(255,255,255,0.06)';
            card.style.transform = 'translate(-50%, 0)';
            card.querySelector('div').style.color = 'rgba(255,255,255,0.4)';
          });
          card.addEventListener('click', () => {
            storage.setItem(KEYS.ONBOARDING_CLI, cli.id);
            flushStorage();
            nextStep();
          });
          els.push(card);
        });

        return { destroy() { els.forEach(e => e.remove()); } };
      }, 300);

      // 3. Sparkle doodles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 240, y: cy - 50, scale: 0.9,
        color: 'rgba(255, 255, 255, 0.25)', duration: 350,
      }), 200);
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx + 230, y: cy - 30, scale: 0.7,
        color: 'rgba(255, 255, 255, 0.2)', duration: 350,
      }), 200);

      // 4. Back button
      seq.add(() => {
        const backEl = createButton(dom, 'Back', {
          x: cx, y: cy + 180, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.35)',
          onClick: () => prevStep(),
        });
        return { destroy() { backEl.remove(); } };
      }, 200);
    },
  },

  // ── Step 3: Model Picker ──────────────────────────────────
  {
    id: 'onboarding-model-picker',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 50;

      const CLI_MODELS = {
        'claude-code': [
          { id: 'claude-opus-4-6',   label: 'Opus 4.6',   desc: 'Most capable',  tier: 'top' },
          { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6',  desc: 'Balanced',      tier: 'default' },
          { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',   desc: 'Fastest',       tier: 'light' },
        ],
        'codex': [
          { id: 'o3',      label: 'o3',      desc: 'Deep reasoning',  tier: 'top' },
          { id: 'o4-mini', label: 'o4-mini', desc: 'Fast reasoning',  tier: 'default' },
        ],
        'gemini': [
          { id: 'gemini-2.5-pro',   label: '2.5 Pro',   desc: 'Most capable',  tier: 'default' },
          { id: 'gemini-2.5-flash', label: '2.5 Flash', desc: 'Lightweight',   tier: 'light' },
        ],
      };

      const CLI_LABELS = {
        'claude-code': 'Claude Code',
        'codex': 'Codex CLI',
        'gemini': 'Gemini CLI',
      };

      const chosenCli = storage.getItem(KEYS.ONBOARDING_CLI) || 'claude-code';
      const models = CLI_MODELS[chosenCli] || CLI_MODELS['claude-code'];
      const cliLabel = CLI_LABELS[chosenCli] || 'Claude Code';

      // 1. Title with CLI name
      seq.add(() => handwrittenLabel(svg, `Choose a model for ${cliLabel}`, {
        x: cx, y: cy - 20,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 32, textAnchor: 'middle', duration: 400,
      }), 200);

      // 2. Model cards
      seq.add(() => {
        const cardY = cy + 40;
        const gap = 150;
        const startX = cx - ((models.length - 1) / 2) * gap;
        const els = [];

        models.forEach((model, i) => {
          const x = startX + i * gap;
          const tierColor = model.tier === 'top'
            ? 'rgba(255, 180, 80, 0.5)'
            : model.tier === 'light'
              ? 'rgba(130, 200, 255, 0.5)'
              : 'rgba(255, 255, 255, 0.45)';

          const card = document.createElement('div');
          card.style.cssText = `
            position: absolute; left: ${x}px; top: ${cardY}px;
            transform: translate(-50%, 0);
            display: flex; flex-direction: column; align-items: center; gap: 6px;
            padding: 18px 26px; border: 1px solid rgba(255,255,255,0.06);
            border-radius: 12px; background: rgba(255,255,255,0.02);
            cursor: pointer; pointer-events: auto;
            transition: all 0.2s ease; opacity: 0;
          `;
          card.innerHTML = `
            <div style="font-family:'Caveat',cursive;font-size:22px;color:${tierColor};user-select:none;transition:color 0.2s">${model.label}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);user-select:none">${model.desc}</div>
          `;
          dom.appendChild(card);
          requestAnimationFrame(() => { card.style.opacity = '1'; });

          card.addEventListener('mouseenter', () => {
            card.style.background = 'rgba(255,255,255,0.06)';
            card.style.borderColor = 'rgba(255,255,255,0.15)';
            card.style.transform = 'translate(-50%, 0) translateY(-2px)';
          });
          card.addEventListener('mouseleave', () => {
            card.style.background = 'rgba(255,255,255,0.02)';
            card.style.borderColor = 'rgba(255,255,255,0.06)';
            card.style.transform = 'translate(-50%, 0)';
          });
          card.addEventListener('click', () => {
            storage.setItem(KEYS.ONBOARDING_MODEL, model.id);
            flushStorage();
            nextStep();
          });
          els.push(card);
        });

        return { destroy() { els.forEach(e => e.remove()); } };
      }, 300);

      // 3. Back button
      seq.add(() => {
        const backEl = createButton(dom, 'Back', {
          x: cx, y: cy + 180, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.35)',
          onClick: () => prevStep(),
        });
        return { destroy() { backEl.remove(); } };
      }, 200);
    },
  },

  // ── Step 4: Project Picker ───────────────────────────────────
  {
    id: 'onboarding-project-picker',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, goToStep, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 60;

      // 1. Title
      seq.add(() => handwrittenLabel(svg, 'Which project should we explore?', {
        x: cx, y: cy - 30,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 32, textAnchor: 'middle', duration: 400,
      }), 200);

      // 2. Fetch projects and build cards
      seq.add(async () => {
        let projects = [];
        try {
          const res = await fetch('/api/terminal/profiles');
          const data = await res.json();
          projects = data.projects || [];
        } catch { /* empty list fallback */ }

        const els = [];
        const cardY = cy + 30;
        const maxVisible = 4;
        const visible = projects.slice(0, maxVisible);
        // +1 for the "Add Project" card
        const totalCards = visible.length + 1;
        const gap = Math.min(170, (vw - 160) / totalCards);
        const startX = cx - ((totalCards - 1) * gap) / 2;

        // Folder icon for project cards
        const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:28px;height:28px"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
        const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:28px;height:28px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

        function makeCard(x, icon, label, sublabel, color, onClick) {
          const card = document.createElement('div');
          card.style.cssText = `
            position: absolute; left: ${x}px; top: ${cardY}px;
            transform: translate(-50%, 0);
            display: flex; flex-direction: column; align-items: center; gap: 8px;
            padding: 18px 22px; border: 1px solid rgba(255,255,255,0.06);
            border-radius: 12px; background: rgba(255,255,255,0.02);
            cursor: pointer; pointer-events: auto;
            transition: all 0.2s ease; opacity: 0;
            min-width: 120px; max-width: 150px;
          `;
          card.innerHTML = `
            <div style="color:${color};opacity:0.7;transition:opacity 0.2s">${icon}</div>
            <div style="font-family:'Caveat',cursive;font-size:20px;color:${color};user-select:none;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px" title="${label}">${label}</div>
            ${sublabel ? `<div style="font-size:10px;color:rgba(255,255,255,0.25);user-select:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'JetBrains Mono',monospace" title="${sublabel}">${sublabel}</div>` : ''}
          `;
          dom.appendChild(card);
          requestAnimationFrame(() => { card.style.opacity = '1'; });

          card.addEventListener('mouseenter', () => {
            card.style.background = 'rgba(255,255,255,0.06)';
            card.style.borderColor = 'rgba(255,255,255,0.15)';
            card.style.transform = 'translate(-50%, 0) translateY(-2px)';
          });
          card.addEventListener('mouseleave', () => {
            card.style.background = 'rgba(255,255,255,0.02)';
            card.style.borderColor = 'rgba(255,255,255,0.06)';
            card.style.transform = 'translate(-50%, 0)';
          });
          card.addEventListener('click', onClick);
          els.push(card);
        }

        // Project cards
        visible.forEach((proj, i) => {
          const x = startX + i * gap;
          const folder = proj.label || proj.path.split(/[\\/]/).filter(Boolean).pop();
          makeCard(x, ICON_FOLDER, folder, proj.path.replace(/\\/g, '/'), 'rgba(255, 255, 255, 0.45)', () => {
            storage.setItem(KEYS.ONBOARDING_PROJECT, JSON.stringify({ path: proj.path, label: proj.label || folder }));
            flushStorage();
            nextStep();
          });
        });

        // "Add Project" card (always last)
        const addX = startX + visible.length * gap;
        makeCard(addX, ICON_PLUS, 'Add Project', null, 'rgba(79, 195, 247, 0.5)', async () => {
          // Open Settings on the Projects tab
          const { openSettingsModal } = await import('./ui-settings.js');
          await openSettingsModal();
          const panel = document.getElementById('settings-panel');
          if (panel) {
            panel.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
            panel.querySelectorAll('.settings-tab-body').forEach(b => b.classList.remove('active'));
            const nav = panel.querySelector('.settings-nav-item[data-tab="projects"]');
            const tab = panel.querySelector('.settings-tab-body[data-tab="projects"]');
            if (nav) nav.classList.add('active');
            if (tab) tab.classList.add('active');
          }
        });

        // If no projects exist, show hint
        if (projects.length === 0) {
          handwrittenLabel(svg, 'No projects registered yet — add one to get started', {
            x: cx, y: cardY + 140,
            color: 'rgba(255, 255, 255, 0.3)',
            fontSize: 19, textAnchor: 'middle', duration: 300,
          });
        }

        return { destroy() { els.forEach(e => e.remove()); } };
      }, 300);

      // 3. Back button
      seq.add(() => {
        const backEl = createButton(dom, 'Back', {
          x: cx, y: cy + 210, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.35)',
          onClick: () => prevStep(),
        });
        return { destroy() { backEl.remove(); } };
      }, 200);
    },
  },

  // ── Step 5: Memory Explanation ─────────────────────────────
  {
    id: 'onboarding-memory-explain',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, goToStep, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 70;

      // 1. Title
      seq.add(() => handwrittenLabel(svg, 'Memories are regenerative', {
        x: cx, y: cy,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 34, textAnchor: 'middle', duration: 400,
      }), 200);

      // 2. Explanation lines
      seq.add(() => handwrittenLabel(svg, 'A cheaper model can lay the groundwork.', {
        x: cx, y: cy + 50,
        color: 'rgba(255, 255, 255, 0.4)',
        fontSize: 24, textAnchor: 'middle', duration: 350,
      }), 300);

      seq.add(() => handwrittenLabel(svg, 'When a stronger model uses those memories later,', {
        x: cx, y: cy + 85,
        color: 'rgba(255, 255, 255, 0.4)',
        fontSize: 24, textAnchor: 'middle', duration: 350,
      }), 200);

      seq.add(() => handwrittenLabel(svg, 'it will refine and update them automatically.', {
        x: cx, y: cy + 120,
        color: 'rgba(255, 255, 255, 0.4)',
        fontSize: 24, textAnchor: 'middle', duration: 350,
      }), 200);

      // 3. Key takeaway
      seq.add(() => handwrittenLabel(svg, 'Starting small is not a compromise -- it is a strategy.', {
        x: cx, y: cy + 175,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, textAnchor: 'middle', duration: 400,
      }), 400);

      // 4. Sparkle doodles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 300, y: cy + 40, scale: 0.9,
        color: 'rgba(255, 255, 255, 0.2)', duration: 350,
      }), 200);
      seq.add(() => createDoodle(svg, 'star', {
        x: cx + 280, y: cy + 100, scale: 0.8,
        color: 'rgba(255, 255, 255, 0.2)', duration: 350,
      }), 200);

      // 5. Navigation
      seq.add(() => {
        const navY = cy + 235;
        const backEl = createButton(dom, 'Back', {
          x: cx - 80, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.35)',
          onClick: () => prevStep(),
        });
        const contEl = createButton(dom, 'Begin Exploration', {
          x: cx + 100, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.45)',
          onClick: () => _launchExploration(goToStep),
        });
        return { destroy() { backEl.remove(); contEl.remove(); } };
      }, 200);
    },
  },

  // ── Step 6: Welcome (whiteboard mode) ─────────────────────
  {
    id: 'welcome',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, onSkipWithArrow, createButton }) {
      const cx = vw / 2;
      const cy = vh / 2 - 40;

      // 1. Hand-drawn question text (centered, Caveat, large)
      seq.add(() => handwrittenLabel(svg, 'Do you want to see the tutorial?', {
        x: cx,
        y: cy,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 36,
        textAnchor: 'middle',
        duration: 400,
      }), 200);

      // 2. Decorative sparkle doodles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 240,
        y: cy - 60,
        scale: 1.2,
        color: 'rgba(255, 255, 255, 0.3)',
        duration: 350,
      }), 200);

      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx + 210,
        y: cy + 20,
        scale: 0.9,
        color: 'rgba(255, 255, 255, 0.3)',
        duration: 350,
      }), 200);

      // 3. Interactive Yes / No buttons
      seq.add(() => {
        const btnY = cy + 50;
        const gap = 80;

        const yesEl = createButton(dom, 'Yes', {
          x: cx - gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 28,
          onClick: () => nextStep(),
        });

        const noEl = createButton(dom, 'No', {
          x: cx + gap,
          y: btnY,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 28,
          onClick: () => onSkipWithArrow(),
        });

        // Draw hand-drawn underlines after buttons paint
        setTimeout(() => {
          const yesRect = yesEl.getBoundingClientRect();
          const noRect = noEl.getBoundingClientRect();

          createHandDrawnUnderline(svg, yesRect, {
            color: 'rgba(255, 255, 255, 0.22)',
            wobbleSeed: 'yes-underline',
            duration: 250,
            offset: 2,
          });
          createHandDrawnUnderline(svg, noRect, {
            color: 'rgba(255, 255, 255, 0.22)',
            wobbleSeed: 'no-underline',
            duration: 250,
            offset: 2,
          });
        }, 100);

        return {
          destroy() { yesEl.remove(); noEl.remove(); },
        };
      }, 200);
    },
  },

  // ── Step 7: Focus Mode ──────────────────────────────────
  {
    id: 'explain-focus',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('titlebar-viz-toggle');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      // Everything near the button — arrow tip below navbar, text below arrow
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 100;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'focus-circle', duration: 300,
      }), 100);

      // Short ~80px arrow from above text to below button
      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'focus-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Switch between the graph and this whiteboard', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 8: Fullscreen ─────────────────────────────────
  {
    id: 'explain-fullscreen',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('titlebar-fullscreen-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 100;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'fs-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'fs-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Go fullscreen for a clean, distraction-free experience', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 9: Help / Tutorial Button ─────────────────────
  {
    id: 'explain-help',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('titlebar-tutorial-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 100;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'help-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'help-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Click here anytime to restart this tour', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 10: Clock ────────────────────────────────────
  {
    id: 'explain-clock',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Hide toolbar if coming back from step 5
      const topControls = document.getElementById('topright-controls');
      if (topControls) topControls.classList.add('tutorial-hidden');

      const clock = document.getElementById('titlebar-clock');
      const rect = clock?.getBoundingClientRect();
      if (!rect) return;

      const clockCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(clockCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 8, wobbleSeed: 'clock-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: clockCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'clock-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Whoa... a clock', {
        x: textX, y: textY,
        textAnchor: 'middle',
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 11: Reveal toolbar + explain workspace ────────
  {
    id: 'explain-toolbar',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Slide in the top controls toolbar
      const topControls = document.getElementById('topright-controls');
      if (topControls) {
        topControls.classList.remove('tutorial-hidden');
        topControls.style.transform = 'translateY(-20px)';
        topControls.style.opacity = '0';
        topControls.style.transition = 'transform 0.35s ease, opacity 0.35s ease';
        requestAnimationFrame(() => {
          topControls.style.transform = 'translateY(0)';
          topControls.style.opacity = '1';
        });
      }

      // Point to the workspace indicator
      const wsEl = document.getElementById('ws-indicator');
      const rect = wsEl?.getBoundingClientRect();
      if (!rect) return;

      const wsCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(wsCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 8, wobbleSeed: 'ws-circle', duration: 300,
      }), 300);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: wsCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'ws-arrow', duration: 300,
      }), 200);

      seq.add(() => handwrittenLabel(svg, 'Save and load your whiteboard layouts', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 110;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 200);
    },
  },

  // ── Step 12: Grid snap ────────────────────────────────
  {
    id: 'explain-grid',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('ws-grid-toggle');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'grid-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'grid-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Snap cards to a grid for that tidy look', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => skipTutorial(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); endEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 13: Trash ────────────────────────────────────
  {
    id: 'explain-trash',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('topright-trash-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'trash-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'trash-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Deleted cards end up here', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 14: Keybinds ──────────────────────────────────
  {
    id: 'explain-keybinds',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('topright-keybinds-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'kb-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'kb-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Rebind every shortcut to your liking', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 15: Share / Invite ───────────────────────────
  {
    id: 'explain-share',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const btn = document.getElementById('invite-btn');
      const rect = btn?.getBoundingClientRect();
      if (!rect) return;

      const btnCx = rect.left + rect.width / 2;
      const arrowTipY = rect.bottom + 50;
      const textX = Math.max(180, Math.min(btnCx, vw - 180));
      const textY = arrowTipY + 80;

      seq.add(() => createWobblyCircle(svg, rect, {
        color: 'rgba(255, 255, 255, 0.25)',
        padding: 6, wobbleSeed: 'share-circle', duration: 300,
      }), 100);

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: btnCx, y: arrowTipY },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'share-arrow', duration: 300,
      }), 150);

      seq.add(() => handwrittenLabel(svg, 'Invite friends to your whiteboard in real-time', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 26, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 90;
        const backEl = createButton(dom, 'Back', {
          x: textX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); nextEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 16: Apps menu ────────────────────────────────
  {
    id: 'explain-apps',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Programmatically open the Apps dropdown
      const menuItem = document.querySelector('.menubar-item[data-menu="apps"]');
      if (menuItem) menuItem.classList.add('open');

      // Force layout so getBoundingClientRect is accurate
      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight; // force reflow
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      // Text below the dropdown, centered on it — clear of navbar and dropdown
      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'apps-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Tools streamed through a virtual terminal from your machine', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 17: View menu ────────────────────────────────
  {
    id: 'explain-view',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Close apps dropdown if still open
      const appsMenu = document.querySelector('.menubar-item[data-menu="apps"]');
      if (appsMenu) appsMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="view"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'view-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Toggle sidebars and panels to customize your layout', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 18: Graph menu ──────────────────────────────
  {
    id: 'explain-graph',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="view"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="graph"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'graph-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Control how memory connections are displayed on the graph', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 19: Skills menu ─────────────────────────────
  {
    id: 'explain-skills',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="graph"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="skills"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'skills-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Create reusable AI skills your assistant can execute on demand', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 20: Automations menu ────────────────────────
  {
    id: 'explain-automations',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="skills"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="automations"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'auto-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Set up automated workflows triggered by events or schedules', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 21: Games menu ──────────────────────────────
  {
    id: 'explain-games',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="automations"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="games"]');
      if (menuItem) menuItem.classList.add('open');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');
      if (dropdown) dropdown.offsetHeight;
      const ddRect = dropdown?.getBoundingClientRect();
      if (!ddRect || ddRect.width === 0) return;

      const ddCx = ddRect.left + ddRect.width / 2;
      const textX = Math.max(180, Math.min(ddCx, vw - 180));
      const textY = ddRect.bottom + 60;

      seq.add(() => createAnimatedArrow(svg, {
        from: { x: textX, y: textY - 15 },
        to: { x: ddCx, y: ddRect.bottom + 12 },
        color: 'rgba(255, 255, 255, 0.3)',
        wobbleSeed: 'games-arrow', duration: 300,
      }), 100);

      seq.add(() => handwrittenLabel(svg, 'Take a break... you earned it', {
        x: textX, y: textY,
        textAnchor: 'middle', maxWidth: 500,
        color: 'rgba(255, 255, 255, 0.5)',
        fontSize: 25, duration: 300,
      }), 200);

      seq.add(() => {
        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 150);
    },
  },

  // ── Step 22: Bookmarks menu ──────────────────────────
  {
    id: 'explain-bookmarks',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      const prevMenu = document.querySelector('.menubar-item[data-menu="games"]');
      if (prevMenu) prevMenu.classList.remove('open');

      const menuItem = document.querySelector('.menubar-item[data-menu="bookmarks"]');
      if (menuItem) menuItem.classList.add('open');
      emit('bookmarks:render');

      const dropdown = menuItem?.querySelector('.menubar-dropdown');

      seq.add(() => {
        if (dropdown) dropdown.offsetHeight;
        const ddRect = dropdown?.getBoundingClientRect();
        if (!ddRect || ddRect.height === 0) return;

        const ddCx = ddRect.left + ddRect.width / 2;
        const textX = Math.max(180, Math.min(ddCx, vw - 180));
        const textY = ddRect.bottom + 60;

        createAnimatedArrow(svg, {
          from: { x: textX, y: textY - 15 },
          to: { x: ddCx, y: ddRect.bottom + 12 },
          color: 'rgba(255, 255, 255, 0.3)',
          wobbleSeed: 'bm-arrow', duration: 300,
        });

        handwrittenLabel(svg, 'Pin important memories for quick access from anywhere', {
          x: textX, y: textY,
          textAnchor: 'middle', maxWidth: 500,
          color: 'rgba(255, 255, 255, 0.5)',
          fontSize: 25, duration: 300,
        });

        const navY = textY + 100;
        const backEl = createButton(dom, 'Back', {
          x: textX - 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            prevStep();
          },
        });
        const endEl = createButton(dom, 'End', {
          x: textX, y: navY, fontSize: 18,
          color: 'rgba(255, 255, 255, 0.3)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            skipTutorial();
          },
        });
        const nextEl = createButton(dom, 'Next', {
          x: textX + 90, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => {
            if (menuItem) menuItem.classList.remove('open');
            nextStep();
          },
        });
        return { destroy() {
          backEl.remove(); endEl.remove(); nextEl.remove();
          if (menuItem) menuItem.classList.remove('open');
        } };
      }, 300);
    },
  },

  // ── Step 23: Settings — open modal, highlight Automations & Permissions ──
  {
    id: 'explain-settings',
    whiteboardMode: true,

    onExit() {
      const p = document.getElementById('settings-panel');
      if (p) { p.remove(); document.querySelector('.settings-panel-backdrop')?.remove(); }
    },

    render({ svg, dom, seq, vw, vh, prevStep, skipTutorial, createButton }) {
      // Close bookmarks dropdown
      const prevMenu = document.querySelector('.menubar-item[data-menu="bookmarks"]');
      if (prevMenu) prevMenu.classList.remove('open');

      // Open Settings modal, switch to Connections tab, expand key sections
      seq.add(async () => {
        await openSettingsModal();
        const panel = document.getElementById('settings-panel');
        if (!panel) return;

        // Override panel sizing for the tutorial — wider, not full height, centered
        panel.style.width = '820px';
        panel.style.maxHeight = '70vh';
        panel.style.left = '50%';
        panel.style.top = '50%';
        panel.style.transform = 'translate(-50%, -50%) scale(var(--ui-scale, 1))';
        panel.style.transformOrigin = 'center center';

        // Hide the backdrop so only the panel floats over the whiteboard
        const backdrop = document.querySelector('.settings-panel-backdrop');
        if (backdrop) backdrop.style.background = 'transparent';

        // Switch to Connections tab (data-tab="hooks")
        panel.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
        panel.querySelectorAll('.settings-tab-body').forEach(b => b.classList.remove('active'));
        const nav = panel.querySelector('.settings-nav-item[data-tab="hooks"]');
        const tab = panel.querySelector('.settings-tab-body[data-tab="hooks"]');
        if (nav) nav.classList.add('active');
        if (tab) tab.classList.add('active');

        // Expand Automations and Permissions sections
        const autoSection = panel.querySelector('.iface-section[data-cc-target="global"]');
        const permSection = panel.querySelector('#cc-tool-permissions');
        if (autoSection) autoSection.classList.remove('collapsed');
        if (permSection) permSection.classList.remove('collapsed');
      }, 100);

      // Wait for modal to render, then draw arrows
      seq.add(() => {
        const panel = document.getElementById('settings-panel');
        if (!panel) return;

        const autoSection = panel.querySelector('.iface-section[data-cc-target="global"]');
        const permSection = panel.querySelector('#cc-tool-permissions');
        const autoRect = autoSection?.getBoundingClientRect();
        const permRect = permSection?.getBoundingClientRect();

        // Position arrows to the right of the settings panel
        const panelRect = panel.getBoundingClientRect();
        const arrowX = panelRect.right + 30;

        // Arrow pointing at Automations section
        if (autoRect) {
          const autoY = autoRect.top + autoRect.height / 2;
          createAnimatedArrow(svg, {
            from: { x: arrowX + 60, y: autoY },
            to: { x: arrowX - 20, y: autoY },
            color: 'rgba(255, 255, 255, 0.35)',
            wobbleSeed: 'auto-arrow', duration: 300,
          });
        }

        // Arrow pointing at Permissions section
        if (permRect) {
          const permY = permRect.top + permRect.height / 2;
          createAnimatedArrow(svg, {
            from: { x: arrowX + 60, y: permY },
            to: { x: arrowX - 20, y: permY },
            color: 'rgba(255, 255, 255, 0.35)',
            wobbleSeed: 'perm-arrow', duration: 300,
          });
        }
      }, 400);

      // Label for Automations
      seq.add(() => {
        const panel = document.getElementById('settings-panel');
        const autoSection = panel?.querySelector('.iface-section[data-cc-target="global"]');
        const autoRect = autoSection?.getBoundingClientRect();
        if (!autoRect || !panel) return;
        const panelRect = panel.getBoundingClientRect();
        const textX = panelRect.right + 100;
        const autoY = autoRect.top + autoRect.height / 2;

        handwrittenLabel(svg, 'Automations', {
          x: textX, y: autoY - 25,
          color: 'rgba(255, 255, 255, 0.55)',
          fontSize: 23, textAnchor: 'start', duration: 300,
        });
        handwrittenLabel(svg, 'Hooks that run before and after each prompt.', {
          x: textX, y: autoY + 2,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 17, textAnchor: 'start', duration: 250,
        });
        handwrittenLabel(svg, 'They handle memory loading, context saving,', {
          x: textX, y: autoY + 24,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 17, textAnchor: 'start', duration: 250,
        });
        handwrittenLabel(svg, 'and rule enforcement automatically.', {
          x: textX, y: autoY + 46,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 17, textAnchor: 'start', duration: 250,
        });
      }, 200);

      // Label for Permissions
      seq.add(() => {
        const panel = document.getElementById('settings-panel');
        const permSection = panel?.querySelector('#cc-tool-permissions');
        const permRect = permSection?.getBoundingClientRect();
        if (!permRect || !panel) return;
        const panelRect = panel.getBoundingClientRect();
        const textX = panelRect.right + 100;
        const permY = permRect.top + permRect.height / 2;

        handwrittenLabel(svg, 'Permissions', {
          x: textX, y: permY - 25,
          color: 'rgba(255, 255, 255, 0.55)',
          fontSize: 23, textAnchor: 'start', duration: 300,
        });
        handwrittenLabel(svg, 'Controls which tools can run without asking.', {
          x: textX, y: permY + 2,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 17, textAnchor: 'start', duration: 250,
        });
        handwrittenLabel(svg, 'All OFF by default. Enable them for a seamless', {
          x: textX, y: permY + 24,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 17, textAnchor: 'start', duration: 250,
        });
        handwrittenLabel(svg, 'memory and automation experience.', {
          x: textX, y: permY + 46,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: 17, textAnchor: 'start', duration: 250,
        });
      }, 200);

      // Hint text
      seq.add(() => {
        const panel = document.getElementById('settings-panel');
        if (!panel) return;
        const panelRect = panel.getBoundingClientRect();
        const textX = panelRect.right + 100;
        const hintY = panelRect.bottom - 10;

        handwrittenLabel(svg, 'No restart needed — changes take effect immediately', {
          x: textX, y: hintY,
          color: 'rgba(255, 255, 255, 0.25)',
          fontSize: 16, textAnchor: 'start', duration: 300,
        });
      }, 300);

      // Navigation buttons
      seq.add(() => {
        const panel = document.getElementById('settings-panel');
        const panelRect = panel?.getBoundingClientRect();
        const navX = panelRect ? panelRect.right + 180 : vw / 2;
        const navY = (panelRect ? panelRect.bottom : vh) + 30;

        const backEl = createButton(dom, 'Back', {
          x: navX - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const doneEl = createButton(dom, 'Done', {
          x: navX + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.5)', onClick: () => skipTutorial(),
        });
        return { destroy() { backEl.remove(); doneEl.remove(); } };
      }, 150);
    },
  },

  // ── Step 24: Feedback / Social links ──────────────────
  {
    id: 'feedback',
    whiteboardMode: true,

    render({ svg, dom, seq, vw, vh, nextStep, prevStep, skipTutorial, createButton }) {
      // Close any previously open dropdowns
      document.querySelectorAll('.menubar-item.open').forEach(m => m.classList.remove('open'));

      const cx = vw / 2;
      const cy = vh / 2 - 60;

      // 1. "Feedback is always welcome" handwritten text
      seq.add(() => handwrittenLabel(svg, 'Feedback is always welcome', {
        x: cx,
        y: cy,
        color: 'rgba(255, 255, 255, 0.55)',
        fontSize: 34,
        textAnchor: 'middle',
        duration: 400,
      }), 200);

      // 2. Decorative sparkles
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx - 220, y: cy - 50,
        scale: 1, color: 'rgba(255, 255, 255, 0.25)', duration: 300,
      }), 300);
      seq.add(() => createDoodle(svg, 'sparkle', {
        x: cx + 200, y: cy + 10,
        scale: 0.8, color: 'rgba(255, 255, 255, 0.25)', duration: 300,
      }), 400);

      // 3. Social icons row
      seq.add(() => {
        const iconY = cy + 60;
        const gap = 90;

        const socials = [
          {
            label: 'Discord',
            url: 'https://discord.gg/x6yWqE9GZP',
            svg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',
          },
          {
            label: 'GitHub',
            url: 'https://github.com/danilokhury/Synabun',
            svg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
          },
          {
            label: 'X',
            url: 'https://x.com/SynabunAI',
            svg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
          },
        ];

        const els = [];
        socials.forEach((s, i) => {
          const x = cx + (i - 1) * gap;
          const el = document.createElement('a');
          el.href = s.url;
          el.target = '_blank';
          el.rel = 'noopener';
          el.title = s.label;
          el.style.cssText = `
            position: absolute;
            left: ${x}px; top: ${iconY}px;
            transform: translate(-50%, 0);
            display: flex; flex-direction: column; align-items: center; gap: 8px;
            color: rgba(255, 255, 255, 0.4);
            text-decoration: none;
            pointer-events: auto;
            transition: color 0.2s, transform 0.2s;
            opacity: 0;
            font-family: 'Caveat', cursive;
            font-size: 18px;
            cursor: pointer;
          `;
          el.innerHTML = `${s.svg}<span>${s.label}</span>`;
          dom.appendChild(el);
          requestAnimationFrame(() => { el.style.opacity = '1'; });

          el.addEventListener('mouseenter', () => {
            el.style.color = 'rgba(255, 255, 255, 0.8)';
            el.style.transform = 'translate(-50%, 0) scale(1.1)';
          });
          el.addEventListener('mouseleave', () => {
            el.style.color = 'rgba(255, 255, 255, 0.4)';
            el.style.transform = 'translate(-50%, 0) scale(1)';
          });
          els.push(el);
        });

        return { destroy() { els.forEach(e => e.remove()); } };
      }, 300);

      // 4. Navigation buttons
      seq.add(() => {
        const navY = cy + 170;
        const backEl = createButton(dom, 'Back', {
          x: cx - 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => prevStep(),
        });
        const doneEl = createButton(dom, 'Done', {
          x: cx + 70, y: navY, fontSize: 22,
          color: 'rgba(255, 255, 255, 0.4)', onClick: () => nextStep(),
        });
        return { destroy() { backEl.remove(); doneEl.remove(); } };
      }, 200);
    },
  },
];
