import { z } from 'zod';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';

// ═══════════════════════════════════════════
// style_guide — Per-project visual identity
// ═══════════════════════════════════════════

export const styleGuideSchema = {
  action: z.enum(['get', 'list']).default('get').describe(
    '"get" returns the active style guide JSON + DESIGN.md for a project. "list" enumerates registered projects with style-guide status.'
  ),
  projectPath: z.string().optional().describe(
    'Absolute path to the project root. Required for "get". Defaults to the current working directory.'
  ),
};

export const styleGuideDescription =
  'Read the SynaBun Style Guide (visual identity tokens) for a project. Returns the color palette, typography, shape/spacing, and logo info plus the rendered DESIGN.md. Consult this BEFORE any creative or UI work on the project so the output matches the user-defined brand. Edits happen in the Neural Interface Style Guide module (Skills > Style Guide).';

interface StyleGuideConfig {
  projectPath?: string;
  updatedAt?: string;
  colors?: Record<string, Record<string, string> | undefined>;
  typography?: {
    heading?: { family?: string; weights?: number[]; scale?: Record<string, number> };
    body?:    { family?: string; weights?: number[]; size?: number; lineHeight?: number };
    mono?:    { family?: string; weights?: number[] };
  };
  shape?: {
    radius?: Record<string, number>;
    spacing?: number[];
    shadows?: Record<string, string>;
  };
  logo?: {
    variants?: Array<{ id: string; name: string; file: string; bg: string }>;
    iconLibrary?: string;
    imageryNotes?: string;
  };
}

function summarizeConfig(cfg: StyleGuideConfig): string {
  const lines: string[] = [];
  const colors = cfg.colors || {};
  const primary500 = colors.primary?.['500'];
  const secondary500 = colors.secondary?.['500'];
  const accent500 = colors.accent?.['500'];
  const status = colors.status || {};
  if (primary500 || secondary500 || accent500) {
    lines.push(`Colors: primary ${primary500 || '—'}, secondary ${secondary500 || '—'}, accent ${accent500 || '—'}`);
  }
  if (Object.keys(status).length) {
    lines.push(`Status: ${Object.entries(status).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const typo = cfg.typography || {};
  if (typo.heading?.family) lines.push(`Heading font: ${typo.heading.family}`);
  if (typo.body?.family)    lines.push(`Body font: ${typo.body.family}${typo.body.size ? ` (${typo.body.size}px)` : ''}`);
  if (typo.mono?.family)    lines.push(`Mono font: ${typo.mono.family}`);
  const shape = cfg.shape || {};
  if (shape.radius) lines.push(`Radii: ${Object.entries(shape.radius).map(([k, v]) => `${k}=${v}px`).join(', ')}`);
  if (shape.spacing?.length) lines.push(`Spacing scale: ${shape.spacing.map(v => v + 'px').join(' / ')}`);
  const logo = cfg.logo || {};
  if (logo.variants?.length) lines.push(`Logo variants: ${logo.variants.length}`);
  if (logo.iconLibrary) lines.push(`Icon library: ${logo.iconLibrary}`);
  return lines.join('\n');
}

export async function handleStyleGuide(args: {
  action?: string;
  projectPath?: string;
}) {
  const action = args.action || 'get';

  if (action === 'list') {
    const res = await ni.listProjects();
    if (res.error) return text(`Failed to list projects: ${res.error}`);
    const projects = (res.projects || []) as Array<{ path: string; label: string }>;
    if (projects.length === 0) return text('No projects registered.');

    const rows = await Promise.all(projects.map(async (p) => {
      const designPath = resolve(p.path, 'DESIGN.md');
      const hasDesign = existsSync(designPath);
      let updatedAt = '';
      try {
        const sg = await ni.getStyleGuide(p.path);
        const cfg = (sg.config || {}) as StyleGuideConfig;
        if (cfg.updatedAt) updatedAt = cfg.updatedAt;
      } catch { /* ignore */ }
      return `- ${p.label} (${p.path})${hasDesign ? ' · DESIGN.md ✓' : ''}${updatedAt ? ` · updated ${updatedAt}` : ''}`;
    }));
    return text(`Registered projects (${projects.length}):\n${rows.join('\n')}`);
  }

  // action === 'get'
  const projectPath = args.projectPath || process.cwd();
  const res = await ni.getStyleGuide(projectPath);
  if (res.error) return text(`Failed to load style guide: ${res.error}`);

  const config = (res.config || {}) as StyleGuideConfig;
  const designMd = (res.designMd as string) || '';
  const hasDesignFile = Boolean(res.hasDesignFile);

  // Prefer DESIGN.md from disk so the model sees exactly what was version-controlled.
  let designSource = 'rendered';
  let design = designMd;
  const designPath = resolve(projectPath, 'DESIGN.md');
  if (hasDesignFile && existsSync(designPath)) {
    try {
      design = readFileSync(designPath, 'utf-8');
      designSource = `disk (${designPath})`;
    } catch { /* fall back to rendered */ }
  }

  const summary = summarizeConfig(config);
  const out = [
    `Style Guide — ${projectPath}`,
    config.updatedAt ? `Last updated: ${config.updatedAt}` : '',
    '',
    summary || '(no tokens defined yet)',
    '',
    `── DESIGN.md (${designSource}) ──`,
    '',
    design.trim() || '(empty)',
  ].filter(Boolean).join('\n');

  return text(out);
}
