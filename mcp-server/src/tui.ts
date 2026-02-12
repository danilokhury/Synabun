#!/usr/bin/env node

// Load .env from parent directory before any service imports
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname_, '..', '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env not found, rely on existing env vars */ }

import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';
import { ensureCollection, scrollMemories, searchMemories, getMemory, deleteMemory, updatePayload, updateVector, upsertMemory, getMemoryStats, countMemories, updatePayloadByFilter } from './services/qdrant.js';
import { getAllCategories, getCategories, getCustomCategories, getCategoryDescription, validateCategoryName, addCategory, removeCategory } from './services/categories.js';
import { generateEmbedding } from './services/embeddings.js';
import { detectProject } from './config.js';
import type { MemoryPayload, MemorySource } from './types.js';

// ── Box drawing characters ────────────────────────────────────────

const BOX = {
  tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F',
  h: '\u2500', v: '\u2502',
  ltee: '\u251C', rtee: '\u2524',
  dh: '\u2550', dtl: '\u2554', dtr: '\u2557', dbl: '\u255A', dbr: '\u255D', dv: '\u2551',
} as const;

const ICONS = {
  brain: '\u2022',    // bullet
  search: '\u25C9',   // fisheye
  plus: '\u253C',     // cross
  folder: '\u25A0',   // square
  chart: '\u25B2',    // triangle
  exit: '\u25C6',     // diamond
  tag: '#',
  arrow: '\u25B6',    // right triangle
  dot: '\u2022',
  star: '\u2605',
  check: '\u2713',
  cross: '\u2717',
  sparkle: '\u2734',
  memo: '\u2261',     // triple bar
  clock: '\u25CB',    // circle
  link: '\u221E',     // infinity
  edit: '\u270E',     // pencil
  trash: '\u2620',    // skull
  back: '\u25C0',     // left triangle
  more: '\u22EF',     // midline ellipsis
} as const;

// ── Color helpers ──────────────────────────────────────────────────

// Dynamic category color palette — cycles through for categories without a preset
const CATEGORY_COLOR_PALETTE = [
  '#5B9BD5', '#70AD47', '#FFC000', '#ED7D31', '#44C8F5',
  '#A5A5A5', '#4472C4', '#FF6B9D', '#00B050', '#E040FB',
  '#00BFA5', '#7C4DFF', '#FF5252', '#D32F2F', '#64FFDA',
  '#536DFE', '#FFD740', '#69F0AE', '#18FFFF', '#B2FF59',
];

const CATEGORY_ICON_PALETTE = [
  '\u25C8', '\u25A3', '\u2261', '\u2605', '\u25CF',
  '\u25AC', '\u25A4', '\u2665', '\u25B2', '\u25C6',
  '\u25CB', '\u25AA', '\u2726', '\u25D0', '\u25B6',
  '\u2662', '\u2716', '\u25C9', '\u2756', '\u2318',
];

function getCategoryColorFn(cat: string): (s: string) => string {
  const allCats = getAllCategories();
  const idx = allCats.indexOf(cat);
  const hex = idx >= 0 ? CATEGORY_COLOR_PALETTE[idx % CATEGORY_COLOR_PALETTE.length] : '#888888';
  return chalk.hex(hex);
}

function getCategoryIcon(cat: string): string {
  const allCats = getAllCategories();
  const idx = allCats.indexOf(cat);
  return idx >= 0 ? CATEGORY_ICON_PALETTE[idx % CATEGORY_ICON_PALETTE.length] : ICONS.dot;
}

const accent = chalk.hex('#7B68EE');   // medium slate blue - main brand color
const accent2 = chalk.hex('#9370DB');  // medium purple
const dim = chalk.hex('#555555');
const success = chalk.hex('#00E676');
const warn = chalk.hex('#FFAB40');
const danger = chalk.hex('#FF5252');
const info = chalk.hex('#40C4FF');
const muted = chalk.hex('#666666');

function colorCategory(cat: string): string {
  const fn = getCategoryColorFn(cat);
  const icon = getCategoryIcon(cat);
  return fn(`${icon} ${cat}`);
}

function colorCategoryName(cat: string): string {
  const fn = getCategoryColorFn(cat);
  return fn(cat);
}

function importanceBadge(imp: number): string {
  if (imp >= 9) return chalk.bgHex('#FF5252').white.bold(` ${imp} `);
  if (imp >= 8) return chalk.bgHex('#FF7043').white(` ${imp} `);
  if (imp >= 6) return chalk.bgHex('#FFA726').black(` ${imp} `);
  if (imp >= 4) return chalk.bgHex('#78909C').white(` ${imp} `);
  return chalk.bgHex('#455A64').white(` ${imp} `);
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1mo ago';
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? '1y ago' : `${years}y ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function truncate(s: string, max: number): string {
  const line = s.replace(/\n/g, ' ').trim();
  return line.length <= max ? line : line.slice(0, max - 1) + '\u2026';
}

// ── Box & layout helpers ──────────────────────────────────────────

function boxTop(width: number, title?: string): string {
  if (title) {
    const titleStr = ` ${title} `;
    const stripped = titleStr.replace(/\x1B\[[0-9;]*m/g, '');
    const remaining = width - stripped.length;
    const left = Math.max(0, Math.floor(remaining / 2));
    const right = Math.max(0, remaining - left);
    return dim(BOX.tl + BOX.h.repeat(left)) + accent.bold(titleStr) + dim(BOX.h.repeat(right) + BOX.tr);
  }
  return dim(BOX.tl + BOX.h.repeat(width) + BOX.tr);
}

function boxBottom(width: number): string {
  return dim(BOX.bl + BOX.h.repeat(width) + BOX.br);
}

function boxRow(width: number, content: string, pad = 1): string {
  // Strip ANSI for length calculation
  const stripped = content.replace(/\x1B\[[0-9;]*m/g, '');
  const remaining = width - stripped.length - (pad * 2);
  const right = Math.max(0, remaining);
  return dim(BOX.v) + ' '.repeat(pad) + content + ' '.repeat(right + pad) + dim(BOX.v);
}

function boxEmpty(width: number): string {
  return dim(BOX.v) + ' '.repeat(width) + dim(BOX.v);
}

function boxSep(width: number): string {
  return dim(BOX.ltee + BOX.h.repeat(width) + BOX.rtee);
}

// Renders a double-bordered row: ║ <centered content padded to W> ║
function dboxRow(width: number, content: string): string {
  const stripped = content.replace(/\x1B\[[0-9;]*m/g, '');
  const totalPad = width - stripped.length;
  const left = Math.max(0, Math.floor(totalPad / 2));
  const right = Math.max(0, totalPad - left);
  return dim(BOX.dv) + ' '.repeat(left) + content + ' '.repeat(right) + dim(BOX.dv);
}

// ── ASCII Art ─────────────────────────────────────────────────────

function printLogo(): void {
  const W = 56;

  // The art lines with fixed left indent for consistent visual alignment
  const indent = '  ';
  const rawArt = [
    `${indent}  __  __                                `,
    `${indent} |  \\/  | ___ _ __ ___   ___  _ __ _   _`,
    `${indent}| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |`,
    `${indent}| |  | |  __/ | | | | | (_) | |  | |_| |`,
    `${indent}|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |`,
    `${indent}                                   |___/ `,
  ];

  // Fixed-width row: ║ + left pad + content + right pad + ║
  function artRow(content: string): string {
    const stripped = content.replace(/\x1B\[[0-9;]*m/g, '');
    const pad = Math.max(0, W - stripped.length);
    const left = 3; // fixed left margin
    const right = Math.max(0, pad - left);
    return dim(BOX.dv) + ' '.repeat(left) + content + ' '.repeat(right) + dim(BOX.dv);
  }

  console.log('');
  console.log(dim(BOX.dtl + BOX.dh.repeat(W) + BOX.dtr));
  console.log(dboxRow(W, ''));

  for (const line of rawArt) {
    console.log(artRow(accent.bold(line)));
  }

  // Empty line before tagline
  console.log(dboxRow(W, ''));

  // Tagline (centered)
  const tagline = accent2('Vector-Powered') + dim(' \u2022 ') + info('Qdrant') + dim(' \u2022 ') + chalk.white('v1.0.0');
  console.log(dboxRow(W, tagline));

  console.log(dim(BOX.dbl + BOX.dh.repeat(W) + BOX.dbr));
  console.log('');
}

function printScreenHeader(title: string, subtitle?: string): void {
  const W = 56;
  console.log('');
  console.log('  ' + boxTop(W, title));
  if (subtitle) {
    console.log('  ' + boxRow(W, muted(subtitle)));
  }
  console.log('  ' + boxBottom(W));
  console.log('');
}

function printSpinner(text: string): void {
  console.log(muted(`\n  ${ICONS.more} ${text}`));
}

// ── Prompt wrapper (Ctrl+C -> null instead of crash) ──────────────

async function safePrompt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ExitPromptError') {
      return null;
    }
    throw err;
  }
}

// ── Format memories ───────────────────────────────────────────────

function formatMemoryDetail(id: string, p: MemoryPayload): string {
  const W = 62;
  const lines: string[] = [];

  lines.push('  ' + boxTop(W, `${ICONS.memo} Memory Detail`));
  lines.push('  ' + boxEmpty(W));

  // Content - may be multi-line
  const contentLines = p.content.split('\n');
  lines.push('  ' + boxRow(W, chalk.bold('Content')));
  for (const cl of contentLines) {
    lines.push('  ' + boxRow(W, `  ${chalk.white(cl)}`));
  }

  lines.push('  ' + boxSep(W));

  // Metadata grid
  const catColorFn = getCategoryColorFn(p.category);
  const catIcon = getCategoryIcon(p.category);

  lines.push('  ' + boxRow(W, `${muted('Category')}    ${catColorFn(`${catIcon} ${p.category}`)}${p.subcategory ? muted(` / ${p.subcategory}`) : ''}`));
  lines.push('  ' + boxRow(W, `${muted('Project')}     ${info(p.project)}`));
  lines.push('  ' + boxRow(W, `${muted('Importance')}  ${importanceBadge(p.importance)}`));
  lines.push('  ' + boxRow(W, `${muted('Source')}      ${chalk.white(p.source)}`));

  if (p.tags.length) {
    const tagStr = p.tags.map(t => info(`${ICONS.tag}${t}`)).join(' ');
    lines.push('  ' + boxRow(W, `${muted('Tags')}        ${tagStr}`));
  }

  lines.push('  ' + boxSep(W));

  // Timestamps
  lines.push('  ' + boxRow(W, `${muted('Created')}     ${chalk.white(formatDate(p.created_at))} ${dim(`(${formatAge(p.created_at)})`)}`));
  lines.push('  ' + boxRow(W, `${muted('Updated')}     ${chalk.white(formatDate(p.updated_at))}`));
  lines.push('  ' + boxRow(W, `${muted('Accessed')}    ${chalk.white(String(p.access_count))} time${p.access_count !== 1 ? 's' : ''} ${dim(`\u2022 last ${formatAge(p.accessed_at)}`)}`));

  if (p.related_files?.length) {
    lines.push('  ' + boxSep(W));
    lines.push('  ' + boxRow(W, `${muted('Files')}       ${p.related_files.map(f => dim(f)).join(', ')}`));
  }
  if (p.related_memory_ids?.length) {
    if (!p.related_files?.length) lines.push('  ' + boxSep(W));
    lines.push('  ' + boxRow(W, `${muted('Related')}     ${p.related_memory_ids.map(r => dim(r.slice(0, 8) + '\u2026')).join(', ')}`));
  }

  lines.push('  ' + boxEmpty(W));
  lines.push('  ' + boxRow(W, dim(`ID: ${id}`)));
  lines.push('  ' + boxBottom(W));

  return lines.join('\n');
}

function formatMemoryLine(id: string, p: MemoryPayload): string {
  const catColorFn = getCategoryColorFn(p.category);
  const catIconStr = getCategoryIcon(p.category);
  const imp = importanceBadge(p.importance);
  const age = dim(formatAge(p.created_at).padStart(7));
  const content = chalk.white(truncate(p.content, 38));
  const cat = catColorFn(catIconStr + ' ' + p.category.slice(0, 4).padEnd(4));
  return `${imp} ${cat} ${content} ${age}`;
}

// ── Screens ───────────────────────────────────────────────────────

async function detailView(id: string, payload: MemoryPayload): Promise<void> {
  while (true) {
    console.log('\n' + formatMemoryDetail(id, payload));

    const action = await safePrompt(() =>
      select({
        message: accent(`  ${ICONS.arrow} Action`),
        choices: [
          { name: `${ICONS.back}  Back`, value: 'back' },
          { name: `${ICONS.edit}  Edit`, value: 'edit' },
          { name: `${ICONS.trash}  Delete`, value: 'delete' },
        ],
      })
    );

    if (action === null || action === 'back') return;

    if (action === 'delete') {
      const yes = await safePrompt(() =>
        confirm({ message: danger(`  ${ICONS.trash} Delete this memory permanently?`), default: false })
      );
      if (yes) {
        await deleteMemory(id);
        console.log(success(`\n  ${ICONS.check} Memory deleted.`));
        return;
      }
      continue;
    }

    if (action === 'edit') {
      await editMemory(id, payload);
      const refreshed = await getMemory(id);
      if (refreshed) {
        payload = refreshed.payload as unknown as MemoryPayload;
      } else {
        console.log(warn(`\n  ${ICONS.cross} Memory no longer exists.`));
        return;
      }
    }
  }
}

async function editMemory(id: string, payload: MemoryPayload): Promise<void> {
  printScreenHeader(`${ICONS.edit} Edit Memory`, 'Select a field to modify');

  const field = await safePrompt(() =>
    select({
      message: accent('  Field to edit'),
      choices: [
        { name: `${ICONS.memo}  Content:     ${muted(truncate(payload.content, 35))}`, value: 'content' },
        { name: `${ICONS.folder}  Category:    ${colorCategoryName(payload.category)}`, value: 'category' },
        { name: `${ICONS.star}  Importance:  ${importanceBadge(payload.importance)}`, value: 'importance' },
        { name: `${ICONS.tag}  Tags:        ${payload.tags.length ? payload.tags.map(t => info(`#${t}`)).join(' ') : muted('none')}`, value: 'tags' },
        { name: `${ICONS.dot}  Subcategory: ${muted(payload.subcategory || 'none')}`, value: 'subcategory' },
        { name: `${ICONS.folder}  Project:     ${info(payload.project)}`, value: 'project' },
        { name: `${ICONS.back}  Cancel`, value: 'cancel' },
      ],
    })
  );

  if (field === null || field === 'cancel') return;

  const now = new Date().toISOString();

  if (field === 'content') {
    const val = await safePrompt(() =>
      input({ message: '  New content:', default: payload.content })
    );
    if (val === null || val === payload.content) return;
    const merged: MemoryPayload = { ...payload, content: val, updated_at: now };
    printSpinner('Re-generating embedding...');
    const vector = await generateEmbedding(val);
    await updateVector(id, vector, merged);
    console.log(success(`  ${ICONS.check} Content updated & re-embedded.`));
  } else if (field === 'category') {
    const cats = getAllCategories();
    const val = await safePrompt(() =>
      select({
        message: '  Category:',
        choices: cats.map(c => ({
          name: `${colorCategory(c)} ${dim(getCategoryDescription(c))}`,
          value: c,
        })),
        default: payload.category,
      })
    );
    if (val === null || val === payload.category) return;
    await updatePayload(id, { category: val, updated_at: now });
    console.log(success(`  ${ICONS.check} Category ${ICONS.arrow} ${colorCategoryName(val)}`));
  } else if (field === 'importance') {
    const val = await safePrompt(() =>
      input({
        message: '  Importance (1-10):',
        default: String(payload.importance),
        validate: (v: string) => { const n = Number(v); return (Number.isInteger(n) && n >= 1 && n <= 10) || 'Must be 1-10'; },
      })
    );
    if (val === null) return;
    const num = Number(val);
    if (num === payload.importance) return;
    await updatePayload(id, { importance: num, updated_at: now });
    console.log(success(`  ${ICONS.check} Importance ${ICONS.arrow} ${importanceBadge(num)}`));
  } else if (field === 'tags') {
    const val = await safePrompt(() =>
      input({
        message: '  Tags (comma-separated):',
        default: payload.tags.join(', '),
      })
    );
    if (val === null) return;
    const tags = val.split(',').map(t => t.trim()).filter(Boolean);
    await updatePayload(id, { tags, updated_at: now });
    console.log(success(`  ${ICONS.check} Tags updated: ${tags.map(t => info(`#${t}`)).join(' ') || muted('none')}`));
  } else if (field === 'subcategory') {
    const val = await safePrompt(() =>
      input({ message: '  Subcategory:', default: payload.subcategory || '' })
    );
    if (val === null) return;
    await updatePayload(id, { subcategory: val || undefined, updated_at: now });
    console.log(success(`  ${ICONS.check} Subcategory ${ICONS.arrow} ${val || muted('none')}`));
  } else if (field === 'project') {
    const val = await safePrompt(() =>
      input({ message: '  Project:', default: payload.project })
    );
    if (val === null) return;
    await updatePayload(id, { project: val, updated_at: now });
    console.log(success(`  ${ICONS.check} Project ${ICONS.arrow} ${info(val)}`));
  }
}

async function browseScreen(): Promise<void> {
  let offset: string | undefined;

  while (true) {
    printScreenHeader(`${ICONS.brain} Browse Memories`, 'Navigate and select a memory to view details');
    printSpinner('Loading memories...');

    const result = await scrollMemories(undefined, 20, offset);
    const points = result.points;

    if (points.length === 0 && !offset) {
      console.log(warn(`\n  ${ICONS.cross} No memories found. Create some first!`));
      await safePrompt(() => input({ message: '  Press Enter to go back' }));
      return;
    }

    // Sort by created_at descending
    points.sort((a, b) => {
      const pa = (a.payload as unknown as MemoryPayload).created_at;
      const pb = (b.payload as unknown as MemoryPayload).created_at;
      return pb.localeCompare(pa);
    });

    const choices = points.map(pt => ({
      name: `  ${formatMemoryLine(pt.id as string, pt.payload as unknown as MemoryPayload)}`,
      value: pt.id as string,
    }));

    const nextOffset = result.next_page_offset as string | undefined;
    if (nextOffset) {
      choices.push({ name: info(`  ${ICONS.more} Load more...`), value: '__more__' });
    }
    choices.push({ name: dim(`  ${ICONS.back} Back to menu`), value: '__back__' });

    const choice = await safePrompt(() =>
      select({
        message: accent(`  ${ICONS.arrow} Select memory`),
        choices,
        pageSize: 15,
      })
    );

    if (choice === null || choice === '__back__') return;

    if (choice === '__more__') {
      offset = nextOffset;
      continue;
    }

    const mem = await getMemory(choice);
    if (mem) {
      await detailView(mem.id as string, mem.payload as unknown as MemoryPayload);
    }
    offset = undefined;
  }
}

async function searchScreen(): Promise<void> {
  while (true) {
    printScreenHeader(`${ICONS.search} Search Memories`, 'Semantic search powered by OpenAI embeddings');

    const query = await safePrompt(() =>
      input({ message: accent(`  ${ICONS.search} Query:`) })
    );
    if (query === null || query.trim() === '') return;

    // Optional category filter
    const cats = getAllCategories();
    const catFilter = await safePrompt(() =>
      select({
        message: accent('  Filter by category'),
        choices: [
          { name: `${ICONS.sparkle}  All categories`, value: '__all__' },
          ...cats.map(c => ({ name: `  ${colorCategory(c)}`, value: c })),
        ],
      })
    );
    if (catFilter === null) return;

    // Optional importance filter
    const minImpStr = await safePrompt(() =>
      input({
        message: accent('  Min importance (1-10, Enter = any):'),
        default: '',
        validate: (v: string) => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 10) || 'Must be 1-10 or empty',
      })
    );
    if (minImpStr === null) return;

    // Build Qdrant filter
    const must: Record<string, unknown>[] = [];
    if (catFilter !== '__all__') {
      must.push({ key: 'category', match: { value: catFilter } });
    }
    if (minImpStr !== '') {
      must.push({ key: 'importance', range: { gte: Number(minImpStr) } });
    }
    const filter = must.length > 0 ? { must } : undefined;

    printSpinner('Generating embedding & searching...');
    const vector = await generateEmbedding(query);
    const results = await searchMemories(vector, 20, filter, 0.3);

    if (results.length === 0) {
      console.log(warn(`\n  ${ICONS.cross} No matching memories found.`));
      const again = await safePrompt(() =>
        confirm({ message: accent('  Try another search?'), default: true })
      );
      if (again === null || !again) return;
      continue;
    }

    const resultHeader = success(`  ${ICONS.check} Found ${results.length} result${results.length !== 1 ? 's' : ''}`);
    console.log(`\n${resultHeader}\n`);

    const choices = results.map(r => {
      const p = r.payload as unknown as MemoryPayload;
      const pct = Math.round(r.score * 100);
      const scoreBar = pct >= 80 ? success(`${pct}%`) : pct >= 50 ? warn(`${pct}%`) : dim(`${pct}%`);
      return {
        name: `  ${scoreBar.padEnd(18)} ${formatMemoryLine(r.id as string, p)}`,
        value: r.id as string,
      };
    });
    choices.push({ name: info(`  ${ICONS.search} Search again`), value: '__again__' });
    choices.push({ name: dim(`  ${ICONS.back} Back to menu`), value: '__back__' });

    const choice = await safePrompt(() =>
      select({
        message: accent(`  ${ICONS.arrow} Select result`),
        choices,
        pageSize: 15,
      })
    );

    if (choice === null || choice === '__back__') return;
    if (choice === '__again__') continue;

    const mem = await getMemory(choice);
    if (mem) {
      await detailView(mem.id as string, mem.payload as unknown as MemoryPayload);
    }
  }
}

async function createScreen(): Promise<void> {
  printScreenHeader(`${ICONS.plus} Create Memory`, 'Store a new piece of knowledge');

  // Content
  const content = await safePrompt(() =>
    input({
      message: accent(`  ${ICONS.memo} Content:`),
      validate: (v: string) => v.trim().length > 0 || 'Content is required',
    })
  );
  if (content === null) return;

  // Category
  const cats = getAllCategories();
  const category = await safePrompt(() =>
    select({
      message: accent(`  ${ICONS.folder} Category:`),
      choices: cats.map(c => ({
        name: `  ${colorCategory(c)} ${dim(getCategoryDescription(c))}`,
        value: c,
      })),
    })
  );
  if (category === null) return;

  // Project
  const defaultProject = detectProject();
  const project = await safePrompt(() =>
    input({ message: accent(`  ${ICONS.folder} Project:`), default: defaultProject })
  );
  if (project === null) return;

  // Importance
  const impStr = await safePrompt(() =>
    input({
      message: accent(`  ${ICONS.star} Importance (1-10):`),
      default: '5',
      validate: (v: string) => { const n = Number(v); return (Number.isInteger(n) && n >= 1 && n <= 10) || 'Must be 1-10'; },
    })
  );
  if (impStr === null) return;
  const importance = Number(impStr);

  // Tags
  const tagsStr = await safePrompt(() =>
    input({ message: accent(`  ${ICONS.tag} Tags (comma-separated):`), default: '' })
  );
  if (tagsStr === null) return;
  const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);

  // Source
  const source = await safePrompt(() =>
    select<MemorySource>({
      message: accent(`  ${ICONS.arrow} Source:`),
      choices: [
        { name: `  ${chalk.white('user-told')}       ${dim('User explicitly shared')}`, value: 'user-told' as MemorySource },
        { name: `  ${chalk.white('self-discovered')} ${dim('Found during work')}`, value: 'self-discovered' as MemorySource },
        { name: `  ${chalk.white('auto-saved')}      ${dim('Session context')}`, value: 'auto-saved' as MemorySource },
      ],
      default: 'user-told' as MemorySource,
    })
  );
  if (source === null) return;

  // Subcategory (optional)
  const subcategory = await safePrompt(() =>
    input({ message: accent(`  ${ICONS.dot} Subcategory (optional):`), default: '' })
  );
  if (subcategory === null) return;

  // Build payload
  const now = new Date().toISOString();
  const payload: MemoryPayload = {
    content,
    category,
    project,
    importance,
    tags,
    source,
    subcategory: subcategory || undefined,
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
  };

  // Preview
  console.log('\n' + formatMemoryDetail('(preview)', payload));

  const ok = await safePrompt(() =>
    confirm({ message: accent(`  ${ICONS.sparkle} Save this memory?`), default: true })
  );
  if (ok === null || !ok) {
    console.log(warn(`  ${ICONS.cross} Cancelled.`));
    return;
  }

  const id = uuidv4();
  printSpinner('Generating embedding...');
  const vector = await generateEmbedding(content);
  await upsertMemory(id, vector, payload);
  console.log(success(`\n  ${ICONS.check} Memory saved!`) + dim(` ID: ${id}`));
}

async function categoriesScreen(): Promise<void> {
  while (true) {
    printScreenHeader(`${ICONS.folder} Categories`, 'Manage memory categories');

    const action = await safePrompt(() =>
      select({
        message: accent(`  ${ICONS.arrow} Action`),
        choices: [
          { name: `  ${ICONS.memo}  List all categories`, value: 'list' },
          { name: `  ${ICONS.plus}  Create custom category`, value: 'create' },
          { name: `  ${ICONS.trash}  Delete custom category`, value: 'delete' },
          { name: dim(`  ${ICONS.back}  Back to menu`), value: 'back' },
        ],
      })
    );

    if (action === null || action === 'back') return;

    if (action === 'list') {
      const W = 52;
      console.log('\n  ' + boxTop(W, 'All Categories'));

      const allCats = getCategories();
      for (const c of allCats) {
        console.log('  ' + boxRow(W, `${colorCategory(c.name)}  ${dim(c.description)}`));
      }

      console.log('  ' + boxBottom(W));
      console.log('');
    }

    if (action === 'create') {
      const name = await safePrompt(() =>
        input({
          message: accent('  Category name (a-z, 0-9, hyphens):'),
          validate: (v: string) => {
            const result = validateCategoryName(v);
            return result.valid || result.error!;
          },
        })
      );
      if (name === null) continue;

      const description = await safePrompt(() =>
        input({ message: accent('  Description:'), validate: (v: string) => v.trim().length > 0 || 'Required' })
      );
      if (description === null) continue;

      addCategory(name, description);
      console.log(success(`\n  ${ICONS.check} Category "${name}" created.`));
    }

    if (action === 'delete') {
      const custom = getCustomCategories();
      if (custom.length === 0) {
        console.log(warn(`\n  ${ICONS.cross} No custom categories to delete.`));
        continue;
      }

      const name = await safePrompt(() =>
        select({
          message: accent('  Delete which category?'),
          choices: [
            ...custom.map(c => ({
              name: `  ${chalk.hex('#FF6B9D')(`${ICONS.sparkle} ${c.name}`)} ${dim(`- ${c.description}`)}`,
              value: c.name,
            })),
            { name: dim(`  ${ICONS.back} Cancel`), value: '__cancel__' },
          ],
        })
      );
      if (name === null || name === '__cancel__') continue;

      const count = await countMemories({
        must: [{ key: 'category', match: { value: name } }],
      });

      if (count > 0) {
        console.log(warn(`\n  ${ICONS.cross} ${count} memories use this category.`));
        const reassign = await safePrompt(() =>
          confirm({ message: accent('  Reassign them to another category?'), default: true })
        );
        if (reassign === null || !reassign) continue;

        const target = await safePrompt(() =>
          select({
            message: accent('  Reassign to:'),
            choices: getAllCategories()
              .filter(c => c !== name)
              .map(c => ({ name: `  ${colorCategory(c)}`, value: c })),
          })
        );
        if (target === null) continue;

        await updatePayloadByFilter(
          { must: [{ key: 'category', match: { value: name } }] },
          { category: target, updated_at: new Date().toISOString() }
        );
        console.log(success(`  ${ICONS.check} Reassigned ${count} memories to ${colorCategoryName(target)}.`));
      }

      const ok = await safePrompt(() =>
        confirm({ message: danger(`  ${ICONS.trash} Delete category "${name}"?`), default: false })
      );
      if (ok) {
        removeCategory(name);
        console.log(success(`  ${ICONS.check} Category "${name}" deleted.`));
      }
    }
  }
}

async function statsScreen(): Promise<void> {
  printScreenHeader(`${ICONS.chart} Statistics`, 'Memory database overview');
  printSpinner('Loading statistics...');
  const stats = await getMemoryStats();

  const W = 56;
  console.log('\n  ' + boxTop(W, 'Overview'));
  console.log('  ' + boxRow(W, `${chalk.bold.white(String(stats.total))} total memories stored`));
  if (stats.oldest) {
    console.log('  ' + boxRow(W, `${muted('Oldest:')} ${chalk.white(formatDate(stats.oldest))} ${dim(`(${formatAge(stats.oldest)})`)}`));
  }
  if (stats.newest) {
    console.log('  ' + boxRow(W, `${muted('Newest:')} ${chalk.white(formatDate(stats.newest))} ${dim(`(${formatAge(stats.newest)})`)}`));
  }
  console.log('  ' + boxBottom(W));

  // Category chart
  const catEntries = Object.entries(stats.by_category)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (catEntries.length > 0) {
    console.log('\n  ' + boxTop(W, 'By Category'));
    const maxCount = Math.max(...catEntries.map(([, c]) => c));
    const barWidth = 24;
    for (const [cat, count] of catEntries) {
      const catColorFn = getCategoryColorFn(cat);
      const catIconStr = getCategoryIcon(cat);
      const filled = Math.max(1, Math.round((count / maxCount) * barWidth));
      const empty = barWidth - filled;
      const bar = catColorFn('\u2588'.repeat(filled)) + dim('\u2591'.repeat(empty));
      // icon(1) + space(1) + name + padding = 16 chars visual
      const nameVisual = `${catIconStr} ${cat}`;
      const padLen = Math.max(1, 16 - nameVisual.length);
      const label = catColorFn(nameVisual) + ' '.repeat(padLen);
      console.log('  ' + boxRow(W, `${label}${bar} ${chalk.bold.white(String(count).padStart(3))}`));
    }
    console.log('  ' + boxBottom(W));
  }

  // Project breakdown
  const projEntries = Object.entries(stats.by_project)
    .sort((a, b) => b[1] - a[1]);

  if (projEntries.length > 0) {
    console.log('\n  ' + boxTop(W, 'By Project'));
    for (const [proj, count] of projEntries) {
      const pct = Math.round((count / stats.total) * 100);
      const pctBar = dim(`(${pct}%)`);
      console.log('  ' + boxRow(W, `${info(proj.padEnd(20))} ${chalk.bold.white(String(count).padStart(4))} ${pctBar}`));
    }
    console.log('  ' + boxBottom(W));
  }

  console.log('');
  await safePrompt(() => input({ message: dim('  Press Enter to go back') }));
}

// ── Main Menu ─────────────────────────────────────────────────────

async function mainMenu(): Promise<void> {
  printLogo();

  while (true) {
    const choice = await safePrompt(() =>
      select({
        message: accent(`  ${ICONS.arrow} Main Menu`),
        choices: [
          { name: `  ${accent2(ICONS.brain)}  ${chalk.white('Browse Memories')}     ${dim('Paginated list')}`, value: 'browse' },
          { name: `  ${accent2(ICONS.search)}  ${chalk.white('Search Memories')}     ${dim('Semantic search')}`, value: 'search' },
          { name: `  ${accent2(ICONS.plus)}  ${chalk.white('Create Memory')}       ${dim('Store new knowledge')}`, value: 'create' },
          { name: `  ${accent2(ICONS.folder)}  ${chalk.white('Manage Categories')}  ${dim('Create & organize')}`, value: 'categories' },
          { name: `  ${accent2(ICONS.chart)}  ${chalk.white('Statistics')}          ${dim('Database overview')}`, value: 'stats' },
          { name: dim(`  ${ICONS.exit}  Exit`), value: 'exit' },
        ],
      })
    );

    if (choice === null || choice === 'exit') {
      console.log(dim(`\n  ${ICONS.exit} Goodbye!\n`));
      process.exit(0);
    }

    switch (choice) {
      case 'browse': await browseScreen(); break;
      case 'search': await searchScreen(); break;
      case 'create': await createScreen(); break;
      case 'categories': await categoriesScreen(); break;
      case 'stats': await statsScreen(); break;
    }
  }
}

// ── Entry Point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    // Suppress Qdrant "Api key is used with unsecure connection" warning
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = String(args[0] || '');
      if (msg.includes('unsecure connection')) return;
      origWarn.apply(console, args);
    };

    await ensureCollection();

    console.warn = origWarn;

    await mainMenu();
  } catch (err) {
    console.error(danger(`\n  ${ICONS.cross} Fatal error:`), err);
    process.exit(1);
  }
}

main();
