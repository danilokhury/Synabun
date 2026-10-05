// style_guide v2 (src/tools/style-guide-tools.ts): every action against a mocked Neural Interface client.
// The tool reads the guide and can only ever propose a change: no action here writes the store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

vi.mock('../src/services/neural-interface.js', () => ({
  getStyleGuide: vi.fn(),
  getStyleGuideSummary: vi.fn(),
  getStyleGuideExport: vi.fn(),
  writeStyleGuideExports: vi.fn(),
  styleGuideContrast: vi.fn(),
  proposeStyleGuideChange: vi.fn(),
  listStyleGuideProposals: vi.fn(),
  listStyleGuideProjects: vi.fn(),
}));

import * as ni from '../src/services/neural-interface.js';
import { handleStyleGuide, markdownSection, styleGuideDescription, styleGuideSchema } from '../src/tools/style-guide-tools.js';
import { buildServerInstructionsText } from '../src/services/server-instructions.js';

const mock = vi.mocked(ni);
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? '';
const run = async (args: Record<string, unknown>) => textOf(await handleStyleGuide(args as never));

const PROJECT = '/work/acme';
const DESIGN = '---\nversion: 2\nname: "Acme"\n---\n\n# Acme — Design System\n\n## Overview\n\nQuiet and exact.\n\n## Colors\n\n### Palettes\n\n**Primary** `#3b82f6`\n\n```\n## not a heading\n```\n\n## Typography\n\nInter.\n\n## Do\'s and Don\'ts\n\n- Use real copy\n';
const SUMMARY = 'Brand: Acme — Tools that stay out of the way\nColors (light + dark, default light): primary #3b82f6';
const GUIDE = {
  ok: true, projectPath: PROJECT, saved: true, revision: 7, summary: SUMMARY, designMd: DESIGN, hasDesignFile: true, proposalsPending: 2,
  written: [
    { format: 'design-md', path: `${PROJECT}/DESIGN.md`, exists: true },
    { format: 'css', path: `${PROJECT}/.synabun/style-guide/tokens.css`, exists: true },
    { format: 'dtcg', path: `${PROJECT}/.synabun/style-guide/tokens.json`, exists: false },
  ],
};
const NOT_REGISTERED = { ok: false, error: 'Project not registered', code: 'PROJECT_NOT_REGISTERED' };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it('forwards known proposal run/provider/model metadata', async () => {
  mock.proposeStyleGuideChange.mockResolvedValue({ ok: true, id: 'prop-meta', pending: 1 });
  await run({ action: 'propose', projectPath: PROJECT, changes: { brand: { name: 'Next' } }, reason: 'Name', runId: 'run-c1', provider: 'codex', model: 'gpt-6' });
  expect(mock.proposeStyleGuideChange).toHaveBeenCalledWith({ projectPath: PROJECT, changes: { brand: { name: 'Next' } }, reason: 'Name', runId: 'run-c1', provider: 'codex', model: 'gpt-6' });
});

it('does not read an escaping or oversized hand-written DESIGN.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-sg-tool-safe-'));
  try {
    writeFileSync(join(dir, 'private.md'), 'PRIVATE CONTENT');
    symlinkSync(join(dir, 'private.md'), join(dir, 'DESIGN.md'));
    mock.getStyleGuide.mockResolvedValue({ ...GUIDE, projectPath: dir, saved: false, hasDesignFile: true });
    expect(await run({ action: 'get', projectPath: dir })).not.toContain('PRIVATE CONTENT');
    rmSync(join(dir, 'DESIGN.md'));
    writeFileSync(join(dir, 'DESIGN.md'), 'PRIVATE CONTENT' + ' '.repeat(2 * 1024 * 1024));
    expect(await run({ action: 'get', projectPath: dir })).not.toContain('PRIVATE CONTENT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['get', 'getStyleGuide'], ['summary', 'getStyleGuideSummary'], ['tokens', 'getStyleGuideExport'],
  ['contrast', 'styleGuideContrast'], ['propose', 'proposeStyleGuideChange'], ['proposals', 'listStyleGuideProposals'],
  ['export', 'writeStyleGuideExports'], ['list', 'listStyleGuideProjects'],
] as const)('%s reports thrown Neural Interface errors cleanly', async (action, method) => {
  mock[method].mockRejectedValue(new Error('NI unavailable'));
  const out = await run({ action, projectPath: PROJECT, fg: '#000', bg: '#fff', changes: { brand: { name: 'Next' } }, reason: 'Name' });
  expect(out).toBe(`Style Guide ${action} failed: NI unavailable`);
});

describe('style_guide schema and description', () => {
  const schema = z.object(styleGuideSchema);

  it('has the eight actions, defaults to get, and accepts each action\'s parameters', () => {
    expect(styleGuideSchema.action._def.innerType.options).toEqual(['get', 'summary', 'tokens', 'contrast', 'propose', 'proposals', 'export', 'list']);
    expect(schema.parse({}).action).toBe('get');
    for (const input of [
      { action: 'get', projectPath: PROJECT, section: 'Colors' },
      { action: 'summary', projectPath: PROJECT, taskClass: 'image_gen' },
      { action: 'tokens', projectPath: PROJECT, format: 'tailwind-v4', theme: 'dark' },
      { action: 'contrast', fg: '{semantic.text}', bg: '#ffffff', size: 'large' },
      { action: 'propose', projectPath: PROJECT, changes: { colors: { status: { danger: '#dc2626' } }, shape: { radius: { xl: null } } }, reason: 'Contrast' },
      { action: 'proposals', projectPath: PROJECT, status: 'pending' },
      { action: 'export', projectPath: PROJECT, formats: ['design-md', 'tailwind'] },
      { action: 'list' },
    ]) expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    for (const input of [{ action: 'save' }, { action: 'tokens', format: 'scss' }, { action: 'tokens', theme: 'sepia' }, { action: 'contrast', size: 'huge' }, { action: 'propose', changes: 'text' }, { action: 'export', formats: ['pdf'] }, { action: 'proposals', status: 'open' }]) {
      expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('tells a worker to pass its project path and when to call the tool; the description stays short', () => {
    expect(styleGuideSchema.projectPath.description).toBe('The project root or any path inside it (your working directory). The default is the server\'s cwd, which is usually NOT your project — pass it.');
    expect(styleGuideDescription).toMatch(/BEFORE UI, design, copy, marketing, image or video work/);
    expect(styleGuideDescription).toMatch(/Pass projectPath \(your working directory\)/);
    expect(styleGuideDescription).toMatch(/action "propose".*never edit DESIGN\.md or the token files by hand/);
    expect(styleGuideDescription.length).toBeLessThan(600);
  });

  it('the server instructions name every action and the proposal rule', () => {
    const text = buildServerInstructionsText({ activeGroups: new Set(['styleguide']), catalogMode: 'profiled', browserV2: true });
    expect(text).toContain('- Style Guide: style_guide (action: get/summary/tokens/contrast/propose/proposals/export/list) — a project\'s brand, design tokens and DESIGN.md. Call it with your project path before UI, design, copy, marketing, image or video work; suggest changes with action "propose", never by editing the files.');
    expect(buildServerInstructionsText({ activeGroups: new Set(['styleguide']), catalogMode: 'deferred', browserV2: true })).toContain('style_guide (action: get/summary/tokens/contrast/propose/proposals/export/list)');
  });
});

describe('style_guide get', () => {
  it('returns the summary, the files that exist, pending proposals and the rendered DESIGN.md', async () => {
    mock.getStyleGuide.mockResolvedValue(GUIDE);
    const out = await run({ action: 'get', projectPath: `${PROJECT}/src/app` });
    expect(mock.getStyleGuide).toHaveBeenCalledWith(`${PROJECT}/src/app`);
    expect(out).toBe([
      `Style Guide — ${PROJECT} (rev 7)`,
      '',
      SUMMARY,
      '',
      `Files: ${PROJECT}/DESIGN.md · ${PROJECT}/.synabun/style-guide/tokens.css`,
      'Pending proposals: 2',
      'To suggest a change: action "propose" with changes + reason. Never edit DESIGN.md or the token files by hand.',
      '',
      '── DESIGN.md (rendered from the saved guide) ──',
      '',
      DESIGN.trim(),
    ].join('\n'));
  });

  it('defaults to get, and says so when no projectPath was given', async () => {
    mock.getStyleGuide.mockResolvedValue({ ...GUIDE, proposalsPending: 0, written: [] });
    const out = await run({});
    expect(mock.getStyleGuide).toHaveBeenCalledWith(process.cwd());
    expect(out).toContain('Files: none written into the project yet.');
    expect(out).not.toContain('Pending proposals');
    expect(out).toContain(`(No projectPath given: used ${process.cwd()}. Pass projectPath: your project root or any path inside it (your working directory).`);
  });

  it('returns one section on request (exact or prefix, case-insensitive), or every section with the names when it is unknown', async () => {
    mock.getStyleGuide.mockResolvedValue(GUIDE);
    const colors = await run({ action: 'get', projectPath: PROJECT, section: 'colors' });
    expect(colors).toContain('── DESIGN.md (rendered from the saved guide) · section "colors" ──\n\n## Colors\n\n### Palettes\n\n**Primary** `#3b82f6`\n\n```\n## not a heading\n```');
    expect(colors).not.toContain('## Typography');
    expect(await run({ action: 'get', projectPath: PROJECT, section: 'Do' })).toContain('section "Do" ──\n\n## Do\'s and Don\'ts\n\n- Use real copy');
    const missing = await run({ action: 'get', projectPath: PROJECT, section: 'Motion' });
    expect(missing).toContain('· no section "Motion" (sections: Overview, Colors, Typography, Do\'s and Don\'ts), showing all ──');
    expect(missing).toContain('## Typography');
    expect(markdownSection('# T\n\ntext', 'x')).toEqual({ section: null, names: [] });
  });

  it('an unsaved project: the defaults are named as defaults, and a DESIGN.md the project wrote itself is shown instead', async () => {
    mock.getStyleGuide.mockResolvedValue({ ...GUIDE, saved: false, revision: 0, hasDesignFile: false, proposalsPending: 0, written: [] });
    const defaults = await run({ action: 'get', projectPath: PROJECT });
    expect(defaults).toContain(`Style Guide — ${PROJECT} (rev 0, not saved yet)`);
    expect(defaults).toContain('── DESIGN.md (the defaults: this project has no saved guide) ──');
    const dir = mkdtempSync(join(tmpdir(), 'synabun-sg-tool-'));
    try {
      writeFileSync(join(dir, 'DESIGN.md'), '# Our own design\n\nWritten by hand.\n');
      mock.getStyleGuide.mockResolvedValue({ ...GUIDE, projectPath: dir, saved: false, revision: 0, hasDesignFile: true, proposalsPending: 0, written: [] });
      const own = await run({ action: 'get', projectPath: dir });
      expect(own).toContain(`── DESIGN.md (the project's own file, ${join(dir, 'DESIGN.md')}) ──\n\n# Our own design\n\nWritten by hand.`);
      expect(own).not.toContain('# Acme — Design System');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a path in no registered project: the worker is told to pass its project path', async () => {
    mock.getStyleGuide.mockResolvedValue(NOT_REGISTERED);
    expect(await run({ action: 'get', projectPath: '/tmp/elsewhere' })).toBe('Failed to load the style guide: no registered SynaBun project contains "/tmp/elsewhere". Pass projectPath: your project root or any path inside it (your working directory). The default is the SynaBun server\'s working directory, which is usually not your project. Action "list" shows the registered projects.');
    mock.getStyleGuide.mockResolvedValue({ error: 'Neural Interface unreachable: ECONNREFUSED. Is the Neural Interface server running?' });
    expect(await run({ action: 'get', projectPath: PROJECT })).toBe('Failed to load the style guide: Neural Interface unreachable: ECONNREFUSED. Is the Neural Interface server running?');
  });
});

describe('style_guide summary and tokens', () => {
  it('summary: the compact block for the class asked, with where to go next', async () => {
    mock.getStyleGuideSummary.mockResolvedValue({ ok: true, summary: SUMMARY, tokensEstimate: 300, saved: true, revision: 7, projectPath: PROJECT });
    const out = await run({ action: 'summary', projectPath: `${PROJECT}/src`, taskClass: 'image_gen' });
    expect(mock.getStyleGuideSummary).toHaveBeenCalledWith(`${PROJECT}/src`, 'image_gen');
    expect(out).toBe(`Style Guide summary — ${PROJECT} (rev 7)\n\n${SUMMARY}\n\nMore: action "get" (the full DESIGN.md), "tokens" (CSS variables, Tailwind theme, design tokens), "contrast", "propose". Use projectPath "${PROJECT}".`);
    mock.getStyleGuideSummary.mockResolvedValue({ ok: true, summary: SUMMARY, saved: false, revision: 0, projectPath: PROJECT });
    expect(await run({ action: 'summary', projectPath: PROJECT })).toContain('(rev 0, not saved yet: these are the defaults)');
    mock.getStyleGuideSummary.mockResolvedValue(NOT_REGISTERED);
    expect(await run({ action: 'summary' })).toContain(`no registered SynaBun project contains "${process.cwd()}". Pass projectPath`);
  });

  it('tokens: resolved JSON by default, any export format and one theme on request', async () => {
    mock.getStyleGuideExport.mockResolvedValue({ ok: true, format: 'json', text: '{\n  "theme": "light"\n}\n', revision: 7 });
    expect(await run({ action: 'tokens', projectPath: PROJECT })).toBe('Style Guide tokens — json, rev 7\n\n{\n  "theme": "light"\n}');
    expect(mock.getStyleGuideExport).toHaveBeenLastCalledWith(PROJECT, 'json', undefined);
    for (const format of ['dtcg', 'css', 'tailwind-v4', 'tailwind-v3']) {
      mock.getStyleGuideExport.mockResolvedValue({ ok: true, format, text: `/* ${format} */\n`, revision: 7 });
      expect(await run({ action: 'tokens', projectPath: PROJECT, format, theme: 'dark' })).toBe(`Style Guide tokens — ${format} (dark), rev 7\n\n/* ${format} */`);
      expect(mock.getStyleGuideExport).toHaveBeenLastCalledWith(PROJECT, format, 'dark');
    }
    mock.getStyleGuideExport.mockResolvedValue({ ok: false, error: 'format must be one of: …', code: 'BAD_FORMAT' });
    expect(await run({ action: 'tokens', projectPath: PROJECT, format: 'css' })).toBe('Failed to load the tokens: format must be one of: …');
  });
});

describe('style_guide contrast', () => {
  it('reports the ratio, the WCAG verdicts and APCA; plain colors need no project, aliases send one', async () => {
    mock.styleGuideContrast.mockResolvedValue({ ok: true, ratio: 4.48, aa: false, aaa: false, aaLarge: true, aaaLarge: false, apca: 71.1, fg: '#777777', bg: '#ffffff', size: 'normal' });
    expect(await run({ action: 'contrast', fg: '#777', bg: 'white' })).toBe([
      '#777777 on #ffffff: 4.48:1',
      'WCAG 2.x normal text: AA fail (needs 4.5:1) · AAA fail (needs 7:1) · as large text or UI: AA pass (3:1)',
      'APCA Lc 71.1 (advisory; about 75 for body text, 60 for large text, 45 for headlines)',
    ].join('\n'));
    expect(mock.styleGuideContrast).toHaveBeenLastCalledWith({ fg: '#777', bg: 'white', size: undefined });
    mock.styleGuideContrast.mockResolvedValue({ ok: true, ratio: 15.8, aa: true, aaa: true, aaLarge: true, aaaLarge: true, apca: -98.2, fg: '#f0f3f7', bg: '#0e141c', size: 'large' });
    const dark = await run({ action: 'contrast', fg: '{semantic.text}', bg: '{semantic.background}', size: 'large', theme: 'dark' });
    expect(dark).toContain('WCAG 2.x large text / UI: AA pass (needs 3:1) · AAA pass (needs 4.5:1)\n');
    expect(dark).toContain('APCA Lc -98.2');
    expect(mock.styleGuideContrast).toHaveBeenLastCalledWith({ fg: '{semantic.text}', bg: '{semantic.background}', size: 'large', projectPath: process.cwd(), theme: 'dark' });
    await run({ action: 'contrast', fg: '#000', bg: '#fff', projectPath: PROJECT });
    expect(mock.styleGuideContrast).toHaveBeenLastCalledWith({ fg: '#000', bg: '#fff', size: undefined, projectPath: PROJECT });
  });

  it('needs both colors, and passes a refusal on', async () => {
    expect(await run({ action: 'contrast', fg: '#000' })).toMatch(/^contrast needs fg and bg/);
    expect(mock.styleGuideContrast).not.toHaveBeenCalled();
    mock.styleGuideContrast.mockResolvedValue({ ok: false, error: 'Not a color: bg "nope".', code: 'BAD_COLOR' });
    expect(await run({ action: 'contrast', fg: '#000', bg: 'nope' })).toBe('Contrast check failed: Not a color: bg "nope".');
  });
});

describe('style_guide propose and proposals', () => {
  const changes = { colors: { status: { danger: '#dc2626' } } };

  it('records a proposal and says that nothing changed yet', async () => {
    mock.proposeStyleGuideChange.mockResolvedValue({ ok: true, id: 'prop-abc123', pending: 3, ignored: [], diff: [{ path: 'colors.status.danger', from: '#ef4444', to: '#dc2626' }, { path: 'shape.radius.xl', from: 16, to: null }, { path: 'brand.tagline', from: null, to: 'Faster' }] });
    const out = await run({ action: 'propose', projectPath: PROJECT, changes, reason: '  The danger red fails AA on white.  ' });
    expect(mock.proposeStyleGuideChange).toHaveBeenCalledWith({ projectPath: PROJECT, changes, reason: 'The danger red fails AA on white.' });
    expect(out).toBe([
      'Proposal prop-abc123 recorded (3 pending). Nothing changed yet: the user accepts or rejects it in the Style Guide panel. Keep working with the current tokens.',
      'It would change:',
      '- colors.status.danger: #ef4444 → #dc2626',
      '- shape.radius.xl: 16 → (removed)',
      '- brand.tagline: (none) → Faster',
    ].join('\n'));
    mock.proposeStyleGuideChange.mockResolvedValue({ ok: true, id: 'prop-x', pending: 1, ignored: ['agents', 'exports'], diff: Array.from({ length: 25 }, (_, i) => ({ path: `brand.personality.${i}`, from: 'a'.repeat(120), to: { nested: true } })) });
    const long = await run({ action: 'propose', projectPath: PROJECT, changes, reason: 'Many' });
    expect(long).toContain('- … and 5 more');
    expect(long).toContain(`- brand.personality.0: ${'a'.repeat(79)}… → {"nested":true}`);
    expect(long).toContain('Ignored (not open to proposals): agents, exports');
  });

  it('refuses a call without a patch or a reason before reaching the server, and passes the server\'s refusals on', async () => {
    for (const bad of [{}, { changes: {} }, { changes: [] }, { changes: 'x' }]) expect(await run({ action: 'propose', projectPath: PROJECT, reason: 'r', ...bad })).toMatch(/^propose needs changes: a JSON merge patch/);
    expect(await run({ action: 'propose', projectPath: PROJECT, changes })).toBe('propose needs a reason: say why the guide should change.');
    expect(await run({ action: 'propose', projectPath: PROJECT, changes, reason: '   ' })).toBe('propose needs a reason: say why the guide should change.');
    expect(mock.proposeStyleGuideChange).not.toHaveBeenCalled();
    mock.proposeStyleGuideChange.mockResolvedValue({ ok: false, error: 'Proposals are turned off for this project (Style Guide → Agents).', code: 'PROPOSALS_OFF' });
    expect(await run({ action: 'propose', projectPath: PROJECT, changes, reason: 'r' })).toBe('Proposal not recorded: Proposals are turned off for this project (Style Guide → Agents).');
    mock.proposeStyleGuideChange.mockResolvedValue(NOT_REGISTERED);
    expect(await run({ action: 'propose', projectPath: '/x', changes, reason: 'r' })).toMatch(/^Proposal not recorded: no registered SynaBun project contains "\/x"\. Pass projectPath/);
  });

  it('lists proposals with their status and what each would change', async () => {
    mock.listStyleGuideProposals.mockResolvedValue([
      { id: 'prop-2', at: '2026-10-02T11:00:00.000Z', status: 'pending', decidedAt: null, reason: 'A tagline.', diff: [{ path: 'brand.tagline', from: '', to: 'Faster' }] },
      { id: 'prop-1', at: '2026-10-02T10:00:00.000Z', status: 'accepted', decidedAt: '2026-10-02T10:05:00.000Z', reason: 'Contrast.', diff: [] },
    ] as never);
    expect(await run({ action: 'proposals', projectPath: PROJECT, status: 'pending' })).toBe([
      'Proposals (2):',
      '- prop-2 · pending · proposed 2026-10-02T11:00:00.000Z · A tagline.',
      '  - brand.tagline:  → Faster',
      '- prop-1 · accepted 2026-10-02T10:05:00.000Z · proposed 2026-10-02T10:00:00.000Z · Contrast.',
    ].join('\n'));
    expect(mock.listStyleGuideProposals).toHaveBeenCalledWith(PROJECT, 'pending');
    mock.listStyleGuideProposals.mockResolvedValue([] as never);
    expect(await run({ action: 'proposals', projectPath: PROJECT })).toBe('No proposals for this project.');
    expect(await run({ action: 'proposals', projectPath: PROJECT, status: 'rejected' })).toBe('No rejected proposals for this project.');
    mock.listStyleGuideProposals.mockResolvedValue(NOT_REGISTERED);
    expect(await run({ action: 'proposals', projectPath: '/x' })).toMatch(/^Failed to list proposals: no registered SynaBun project contains "\/x"/);
  });
});

describe('style_guide export and list', () => {
  it('export: writes the saved guide\'s files and names them', async () => {
    mock.writeStyleGuideExports.mockResolvedValue({ ok: true, written: [{ format: 'design-md', path: `${PROJECT}/DESIGN.md`, changed: false }, { format: 'css', path: `${PROJECT}/.synabun/style-guide/tokens.css`, changed: true }] });
    expect(await run({ action: 'export', projectPath: PROJECT, formats: ['design-md', 'css'] })).toBe(`Wrote 2 files from the saved guide:\n- design-md → ${PROJECT}/DESIGN.md (already current)\n- css → ${PROJECT}/.synabun/style-guide/tokens.css`);
    expect(mock.writeStyleGuideExports).toHaveBeenCalledWith(PROJECT, ['design-md', 'css']);
    mock.writeStyleGuideExports.mockResolvedValue({ ok: true, written: [] });
    expect(await run({ action: 'export', projectPath: PROJECT })).toMatch(/^Nothing to write: every export is turned off/);
    mock.writeStyleGuideExports.mockResolvedValue({ ok: false, error: 'This project has no saved style guide yet: save it first.', code: 'NOT_SAVED' });
    expect(await run({ action: 'export', projectPath: PROJECT })).toBe('Export failed: This project has no saved style guide yet: save it first.');
  });

  it('list: every registered project with its guide\'s status', async () => {
    mock.listStyleGuideProjects.mockResolvedValue([
      { path: PROJECT, label: 'Acme', saved: true, revision: 7, updatedAt: '2026-10-02T10:00:00.000Z', hasDesignFile: true, proposalsPending: 1 },
      { path: '/work/other', label: 'Other', saved: false, revision: 0, updatedAt: null, hasDesignFile: true, proposalsPending: 0 },
      { path: '/work/new', label: 'New', saved: false, revision: 0, updatedAt: null, hasDesignFile: false, proposalsPending: 0 },
    ] as never);
    expect(await run({ action: 'list' })).toBe([
      'Registered projects (3):',
      `- Acme (${PROJECT}) · style guide rev 7, updated 2026-10-02T10:00:00.000Z · DESIGN.md ✓ · 1 pending proposal`,
      '- Other (/work/other) · no style guide saved · DESIGN.md ✓',
      '- New (/work/new) · no style guide saved',
    ].join('\n'));
    mock.listStyleGuideProjects.mockResolvedValue([] as never);
    expect(await run({ action: 'list' })).toBe('No projects registered.');
    mock.listStyleGuideProjects.mockResolvedValue({ error: 'Neural Interface unreachable' });
    expect(await run({ action: 'list' })).toBe('Failed to list projects: Neural Interface unreachable');
  });

  it('no action ever calls a store write: the client exposes proposals as the only change', () => {
    expect(Object.keys(ni).sort()).toEqual(['getStyleGuide', 'getStyleGuideExport', 'getStyleGuideSummary', 'listStyleGuideProjects', 'listStyleGuideProposals', 'proposeStyleGuideChange', 'styleGuideContrast', 'writeStyleGuideExports']);
  });
});
