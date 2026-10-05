import { z } from 'zod';
import { resolve } from 'path';
import { existsSync, lstatSync, readFileSync } from 'fs';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// style_guide — a project's brand and design system
// ═══════════════════════════════════════════
//
// Reads the SynaBun Style Guide through the Neural Interface (docs/style-guide.md):
// the summary agents work from, the full DESIGN.md, the tokens in any export format,
// contrast for two colors. The one thing it can change is a proposal: a merge patch
// the user accepts or rejects in the Style Guide panel. It never writes the store.

const ACTIONS = ['get', 'summary', 'tokens', 'contrast', 'propose', 'proposals', 'export', 'list'] as const;
const TOKEN_FORMATS = ['json', 'dtcg', 'css', 'tailwind-v4', 'tailwind-v3'] as const;
const EXPORT_FORMATS = ['design-md', 'dtcg', 'css', 'tailwind-v4', 'tailwind-v3', 'tailwind'] as const;

export const styleGuideSchema = {
  action: z.enum(ACTIONS).default('get').describe(
    '"summary": the compact brand block (start here). "get": summary + the full DESIGN.md (or one `section`). "tokens": the tokens in a `format`. "contrast": WCAG ratio + APCA for `fg` on `bg`. "propose": suggest a change (`changes` + `reason`) for the user to review. "proposals": list them. "export": write DESIGN.md and the token files into the project now. "list": registered projects and whether each has a guide.'
  ),
  projectPath: z.string().optional().describe(
    'The project root or any path inside it (your working directory). The default is the server\'s cwd, which is usually NOT your project — pass it.'
  ),
  section: z.string().optional().describe('get: only this DESIGN.md section, e.g. "Colors", "Typography", "Components", "Do\'s and Don\'ts".'),
  format: z.enum(TOKEN_FORMATS).optional().describe('tokens: "json" (resolved values, default), "dtcg" (W3C design tokens), "css" (custom properties), "tailwind-v4" (@theme) or "tailwind-v3" (theme.extend).'),
  theme: z.enum(['light', 'dark']).optional().describe('tokens / contrast: one theme (default: the guide\'s default theme).'),
  taskClass: z.string().optional().describe('summary: the kind of work (e.g. "image_gen" or "video_gen" puts imagery and the generation prefix first).'),
  fg: z.string().optional().describe('contrast: the text color — a hex, rgb(), hsl(), oklch(), or an alias like "{semantic.text}" or "{primary.500}".'),
  bg: z.string().optional().describe('contrast: the background color, same forms as fg.'),
  size: z.enum(['normal', 'large']).optional().describe('contrast: "large" for text ≥ 24px (or ≥ 18.66px bold) and UI components.'),
  changes: z.record(z.unknown()).optional().describe(
    'propose: a JSON merge patch (RFC 7396) against the guide, e.g. {"colors":{"status":{"danger":"#dc2626"}}}. null deletes a key. agents and exports settings cannot be proposed.'
  ),
  reason: z.string().optional().describe('propose: why the guide should change (required).'),
  status: z.enum(['pending', 'accepted', 'rejected']).optional().describe('proposals: only this status.'),
  formats: z.array(z.enum(EXPORT_FORMATS)).optional().describe('export: which files to write (default: the ones the guide has enabled).'),
  runId: z.string().optional().describe('propose: the dispatched run id, if known.'),
  provider: z.string().optional().describe('propose: the authoring provider, if known.'),
  model: z.string().optional().describe('propose: the authoring model, if known.'),
};

export const styleGuideDescription =
  'A project\'s SynaBun Style Guide: brand, colors (light/dark), type, spacing, motion, components and rules, as a summary, the full DESIGN.md or tokens (CSS variables, Tailwind theme, W3C design tokens). Call it BEFORE UI, design, copy, marketing, image or video work and use its tokens instead of inventing values. Pass projectPath (your working directory). To change the guide, use action "propose": the user reviews proposals; never edit DESIGN.md or the token files by hand.';

type Args = {
  action?: string;
  projectPath?: string;
  section?: string;
  format?: string;
  theme?: string;
  taskClass?: string;
  fg?: string;
  bg?: string;
  size?: string;
  changes?: Record<string, unknown>;
  reason?: string;
  status?: string;
  formats?: string[];
  runId?: string;
  provider?: string;
  model?: string;
};

type WrittenFile = { format: string; path: string; exists?: boolean; changed?: boolean };
type DiffRow = { path: string; from: unknown; to: unknown };

const PASS_PATH = 'Pass projectPath: your project root or any path inside it (your working directory). The default is the SynaBun server\'s working directory, which is usually not your project. Action "list" shows the registered projects.';

/** What to tell the caller when the Neural Interface refused or could not be reached. */
function failure(what: string, res: ni.NiResponse, projectPath: string): string {
  if (res.code === 'PROJECT_NOT_REGISTERED' || /not registered/i.test(String(res.error || ''))) {
    return `${what}: no registered SynaBun project contains "${projectPath}". ${PASS_PATH}`;
  }
  return `${what}: ${res.error}`;
}

const short = (value: unknown): string => {
  const out = typeof value === 'string' ? value : JSON.stringify(value);
  return out === undefined ? 'null' : out.length > 80 ? `${out.slice(0, 79)}…` : out;
};
const diffLines = (diff: DiffRow[], max = 20): string[] => [
  ...diff.slice(0, max).map((row) => `- ${row.path}: ${row.from === null ? '(none)' : short(row.from)} → ${row.to === null ? '(removed)' : short(row.to)}`),
  ...(diff.length > max ? [`- … and ${diff.length - max} more`] : []),
];

/** The `## <name>` section of a Markdown file (case-insensitive, prefix match), or null with the names it has. */
export function markdownSection(markdown: string, name: string): { section: string | null; names: string[] } {
  const lines = markdown.split('\n');
  const heads: Array<{ title: string; line: number }> = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (match) heads.push({ title: match[1], line: index });
  });
  const wanted = name.trim().toLowerCase();
  const at = heads.findIndex((head) => head.title.toLowerCase() === wanted);
  const index = at >= 0 ? at : heads.findIndex((head) => head.title.toLowerCase().startsWith(wanted));
  if (index < 0) return { section: null, names: heads.map((head) => head.title) };
  const end = index + 1 < heads.length ? heads[index + 1].line : lines.length;
  return { section: lines.slice(heads[index].line, end).join('\n').trim(), names: heads.map((head) => head.title) };
}

function filesLine(written: WrittenFile[]): string {
  const there = written.filter((file) => file.exists);
  if (!there.length) return 'Files: none written into the project yet.';
  return `Files: ${there.map((file) => file.path).join(' · ')}`;
}

export async function handleStyleGuide(args: Args) {
  try { return await handleStyleGuideAction(args); } catch (error) {
    return text(`Style Guide ${args.action || 'get'} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleStyleGuideAction(args: Args) {
  const action = args.action || 'get';
  const projectPath = args.projectPath || process.cwd();
  const defaulted = args.projectPath ? '' : `\n(No projectPath given: used ${projectPath}. ${PASS_PATH})`;

  if (action === 'list') {
    const res = await ni.listStyleGuideProjects();
    if (!Array.isArray(res)) return text(`Failed to list projects: ${(res as ni.NiResponse).error || 'unexpected response'}`);
    const projects = res as Array<{ path: string; label: string; saved: boolean; revision: number; updatedAt: string | null; hasDesignFile: boolean; proposalsPending: number }>;
    if (projects.length === 0) return text('No projects registered.');
    const rows = projects.map((p) => `- ${p.label} (${p.path}) · ${p.saved ? `style guide rev ${p.revision}${p.updatedAt ? `, updated ${p.updatedAt}` : ''}` : 'no style guide saved'}${p.hasDesignFile ? ' · DESIGN.md ✓' : ''}${p.proposalsPending ? ` · ${p.proposalsPending} pending proposal${p.proposalsPending === 1 ? '' : 's'}` : ''}`);
    return text(`Registered projects (${projects.length}):\n${rows.join('\n')}`);
  }

  if (action === 'summary') {
    const res = await ni.getStyleGuideSummary(projectPath, args.taskClass);
    if (res.error) return text(failure('Failed to load the style guide', res, projectPath));
    const root = String(res.projectPath || projectPath);
    return text([
      `Style Guide summary — ${root} (rev ${res.revision ?? 0}${res.saved ? '' : ', not saved yet: these are the defaults'})`,
      '',
      String(res.summary || '(empty)'),
      '',
      `More: action "get" (the full DESIGN.md), "tokens" (CSS variables, Tailwind theme, design tokens), "contrast", "propose". Use projectPath "${root}".${defaulted}`,
    ].join('\n'));
  }

  if (action === 'tokens') {
    const format = args.format || 'json';
    const res = await ni.getStyleGuideExport(projectPath, format, args.theme);
    if (res.error) return text(failure('Failed to load the tokens', res, projectPath));
    return text(`Style Guide tokens — ${format}${args.theme ? ` (${args.theme})` : ''}, rev ${res.revision ?? 0}${defaulted}\n\n${String(res.text || '').trim()}`);
  }

  if (action === 'contrast') {
    if (!args.fg || !args.bg) return text('contrast needs fg and bg: two colors (hex, rgb(), hsl(), oklch()) or aliases like "{semantic.text}" and "{semantic.background}".');
    const usesAlias = /\{/.test(`${args.fg}${args.bg}`);
    const res = await ni.styleGuideContrast({
      fg: args.fg, bg: args.bg, size: args.size,
      ...(usesAlias || args.projectPath ? { projectPath } : {}), ...(args.theme ? { theme: args.theme } : {}),
    });
    if (res.error) return text(failure('Contrast check failed', res, projectPath));
    const large = res.size === 'large';
    const mark = (ok: unknown) => (ok ? 'pass' : 'fail');
    return text([
      `${res.fg} on ${res.bg}: ${res.ratio}:1`,
      `WCAG 2.x ${large ? 'large text / UI' : 'normal text'}: AA ${mark(res.aa)} (needs ${large ? 3 : 4.5}:1) · AAA ${mark(res.aaa)} (needs ${large ? 4.5 : 7}:1)${large ? '' : ` · as large text or UI: AA ${mark(res.aaLarge)} (3:1)`}`,
      `APCA Lc ${res.apca} (advisory; about 75 for body text, 60 for large text, 45 for headlines)`,
    ].join('\n'));
  }

  if (action === 'propose') {
    if (!args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes) || !Object.keys(args.changes).length) {
      return text('propose needs changes: a JSON merge patch against the guide, e.g. {"colors":{"status":{"danger":"#dc2626"}}}. Read the current values with action "tokens" or "get" first.');
    }
    if (!args.reason || !args.reason.trim()) return text('propose needs a reason: say why the guide should change.');
    const res = await ni.proposeStyleGuideChange({ projectPath, changes: args.changes, reason: args.reason.trim(),
      ...(args.runId ? { runId: args.runId } : {}), ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}),
    });
    if (res.error) return text(failure('Proposal not recorded', res, projectPath));
    const diff = (Array.isArray(res.diff) ? res.diff : []) as DiffRow[];
    const ignored = (Array.isArray(res.ignored) ? res.ignored : []) as string[];
    return text([
      `Proposal ${res.id} recorded (${res.pending} pending). Nothing changed yet: the user accepts or rejects it in the Style Guide panel. Keep working with the current tokens.`,
      ...(diff.length ? ['It would change:', ...diffLines(diff)] : []),
      ...(ignored.length ? [`Ignored (not open to proposals): ${ignored.join(', ')}`] : []),
    ].join('\n'));
  }

  if (action === 'proposals') {
    const res = await ni.listStyleGuideProposals(projectPath, args.status);
    if (!Array.isArray(res)) return text(failure('Failed to list proposals', res as ni.NiResponse, projectPath));
    const rows = res as Array<{ id: string; at: string; status: string; reason: string; diff?: DiffRow[]; decidedAt?: string | null }>;
    if (!rows.length) return text(`No ${args.status ? `${args.status} ` : ''}proposals for this project.`);
    return text([
      `Proposals (${rows.length}):`,
      ...rows.flatMap((row) => [
        `- ${row.id} · ${row.status}${row.decidedAt ? ` ${row.decidedAt}` : ''} · proposed ${row.at} · ${row.reason}`,
        ...diffLines(row.diff || [], 6).map((line) => `  ${line}`),
      ]),
    ].join('\n'));
  }

  if (action === 'export') {
    const res = await ni.writeStyleGuideExports(projectPath, args.formats);
    if (res.error) return text(failure('Export failed', res, projectPath));
    const written = (Array.isArray(res.written) ? res.written : []) as WrittenFile[];
    if (!written.length) return text('Nothing to write: every export is turned off for this project (Style Guide → Import & export).');
    return text(`Wrote ${written.length} file${written.length === 1 ? '' : 's'} from the saved guide:\n${written.map((file) => `- ${file.format} → ${file.path}${file.changed === false ? ' (already current)' : ''}`).join('\n')}`);
  }

  // action === 'get'
  const res = await ni.getStyleGuide(projectPath);
  if (res.error) return text(failure('Failed to load the style guide', res, projectPath));
  const root = String(res.projectPath || projectPath);
  const saved = res.saved !== false;
  const written = (Array.isArray(res.written) ? res.written : []) as WrittenFile[];
  let design = String(res.designMd || '');
  let source = 'rendered from the saved guide';
  // A project with no saved guide may still have a DESIGN.md somebody wrote: that file is its guide.
  const designPath = resolve(root, 'DESIGN.md');
  if (!saved && res.hasDesignFile && existsSync(designPath)) {
    source = 'the defaults: this project has no saved guide';
    try {
      const stat = lstatSync(designPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024) {
        design = readFileSync(designPath, 'utf-8'); source = `the project's own file, ${designPath}`;
      }
    } catch { /* keep the rendered defaults */ }
  } else if (!saved) source = 'the defaults: this project has no saved guide';
  let body = design.trim() || '(empty)';
  let sectionNote = '';
  if (args.section) {
    const found = markdownSection(design, args.section);
    if (found.section) { body = found.section; sectionNote = ` · section "${args.section}"`; }
    else sectionNote = ` · no section "${args.section}" (sections: ${found.names.join(', ')}), showing all`;
  }
  const pending = Number(res.proposalsPending) || 0;
  return text([
    `Style Guide — ${root} (rev ${res.revision ?? 0}${saved ? '' : ', not saved yet'})`,
    '',
    String(res.summary || '(no tokens defined yet)'),
    '',
    filesLine(written),
    ...(pending ? [`Pending proposals: ${pending}`] : []),
    `To suggest a change: action "propose" with changes + reason. Never edit DESIGN.md or the token files by hand.${defaulted}`,
    '',
    `── DESIGN.md (${source})${sectionNote} ──`,
    '',
    body,
  ].join('\n'));
}
