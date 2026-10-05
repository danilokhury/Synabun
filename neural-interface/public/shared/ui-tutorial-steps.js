// The storyboard is shared by 2D and 3D. Copy lives in the `tutorial` namespace
// of i18n/<locale>.json; this file only says what each step points at.
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

export const ONBOARDING_STEPS = [
  { id: 'onboarding-explore', kind: 'explore' },
  { id: 'onboarding-token-warning', kind: 'warning' },
  { id: 'onboarding-cli-picker', kind: 'cli' },
  { id: 'onboarding-model-picker', kind: 'model' },
  { id: 'onboarding-project-picker', kind: 'project' },
  { id: 'onboarding-memory-explain', kind: 'launch' },
];

// A feature step:
//   targets  ordered alternatives, [selector, copyKey = 'body', lastSelector?]. The first one on
//            screen is annotated and its copy shown; `lastSelector` widens the outline to a run
//            of controls. None on screen: the note stays, with the navigation.
//   menu     a menubar dropdown opened while the step shows (closed again after).
//   panel    'assistant' shows the Assistant panel for the step when that starts nothing
//            (see assistantPanelPeekable); otherwise the last target, its button, is used.
//   copy     per-variant copy key for the first target ({ '2d': 'body2d' }).
const ASSISTANT_BUTTON = ['#topright-assistant-panel-btn', 'closed'];
const ACTIVE_TAB = '#assistant-panel.open .asp-viewport.active';
const ACTIVE_BAR = '#assistant-panel.open .asp-tab-bar.active';

export const FEATURE_STEPS = [
  { id: 'explain-memory-explorer', chapter: 'memory', targets: [['#topright-memory-explorer-btn']] },
  { id: 'explain-graph', chapter: 'memory', copy: { '2d': 'body2d' }, targets: [['[data-menu="graph"] > .menubar-label']] },
  { id: 'explain-focus', chapter: 'workspace', targets: [['#wb-toolbar'], ['#titlebar-viz-toggle', 'graph']] },
  { id: 'explain-workspaces', chapter: 'workspace', targets: [['#ws-indicator']] },
  { id: 'explain-terminals', chapter: 'tools', menu: 'apps', targets: [['#menu-terminal-claude', 'body', '#menu-terminal-opencode']] },
  { id: 'explain-browser', chapter: 'tools', menu: 'apps', targets: [['#menu-terminal-browser']] },
  { id: 'explain-side-panel', chapter: 'tools', targets: [['#topright-claude-panel-btn', 'body', '#topright-opencode-panel-btn']] },
  { id: 'explain-automations', chapter: 'automation', menu: 'automations', targets: [['#menu-open-automation-studio']] },
  { id: 'explain-schedules', chapter: 'automation', menu: 'automations', targets: [['#menu-automations-schedules']] },
  { id: 'assistant-start', chapter: 'assistant', panel: 'assistant', targets: [[`${ACTIVE_TAB} .asst-input`], ASSISTANT_BUTTON] },
  { id: 'assistant-tools', chapter: 'assistant', panel: 'assistant', targets: [[`${ACTIVE_BAR} .asst-computer-toggle`], ASSISTANT_BUTTON] },
  { id: 'assistant-route', chapter: 'assistant', panel: 'assistant', targets: [[`${ACTIVE_BAR} .asst-route-chip`], ASSISTANT_BUTTON] },
  { id: 'assistant-track', chapter: 'assistant', panel: 'assistant',
    targets: [[`${ACTIVE_TAB} .asst-usage-strip`], [`${ACTIVE_BAR} .asst-act-more`, 'more'], ASSISTANT_BUTTON] },
  { id: 'explain-help', chapter: 'help', targets: [['#titlebar-tutorial-btn']] },
];

export const SKIP_HINT = { id: 'skip-hint', chapter: 'help', targets: [['#titlebar-tutorial-btn']] };

export const CHAPTERS = [...new Set(FEATURE_STEPS.map(s => s.chapter))];

export const TUTORIAL_STEPS = [...ONBOARDING_STEPS, { id: 'welcome', kind: 'welcome' }, ...FEATURE_STEPS];

const WELCOME = TUTORIAL_STEPS.findIndex(s => s.id === 'welcome');

// Existing numeric cursors migrate to retained step ids. The old onboarding
// indices never make a returning user repeat CLI/model/project choices.
export function resumeIndex(value, includeOnboarding = false) {
  const direct = TUTORIAL_STEPS.findIndex(s => s.id === value);
  if (direct >= 0) return includeOnboarding ? direct : Math.max(WELCOME, direct);
  const legacy = ['onboarding-explore', 'onboarding-token-warning', 'onboarding-cli-picker', 'onboarding-model-picker',
    'onboarding-project-picker', 'onboarding-memory-explain', 'welcome', 'explain-sessions', 'explain-gallery',
    'explain-cost', 'explain-help', 'explain-focus', 'explain-fullscreen', 'explain-clock', 'explain-trash', 'explain-grid',
    'explain-tile', 'explain-keybinds', 'explain-memory-explorer', 'explain-file-explorer', 'explain-bookmarks',
    'explain-share', 'explain-workspaces', 'explain-side-panel', 'explain-menubar', 'explain-whiteboard-toolbar', 'feedback'];
  if (value != null && /^\d+$/.test(value)) {
    const mapped = TUTORIAL_STEPS.findIndex(s => s.id === legacy[Number(value)]);
    return mapped >= WELCOME ? mapped : WELCOME;
  }
  return includeOnboarding ? 0 : WELCOME;
}
