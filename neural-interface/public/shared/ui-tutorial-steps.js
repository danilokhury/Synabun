// The project-exploration setup (ui-tutorial.js openSetup) and the exploration
// prompt Settings → Projects shares. The Workspace tour's storyboard is
// public/shared/tour/tour-beats.js.
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
