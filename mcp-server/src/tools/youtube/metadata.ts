/**
 * youtube_metadata — edit metadata on an existing/just-uploaded video via the
 * Studio video edit page (/video/<id>/edit): title, description, tags, category.
 * Visibility/scheduling is handled by youtube_schedule.
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate, clickStudio, fillStudio, type Resolved } from './helpers.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

export const youtubeMetadataSchema = {
  videoId: z.string().describe('YouTube video id to edit.'),
  title: z.string().optional().describe('New title (≤100 chars).'),
  description: z.string().optional().describe('New description (replaces existing).'),
  tags: z.array(z.string()).optional().describe('Tags/keywords (replaces existing; revealed under "Show more").'),
  category: z.string().optional().describe('Category name, e.g. "Gaming". Set via the Show-more category dropdown.'),
  madeForKids: z.boolean().optional().describe('COPPA audience flag.'),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubeMetadataDescription =
  'Edit an existing video\'s metadata on its Studio edit page: title, description, tags, category, made-for-kids. Saves on completion. [mutating]. Use youtube_schedule for visibility/publish-time.';

async function openEdit(r: Resolved, videoId: string): Promise<string | null> {
  const nav = await safeNavigate(r, `${STUDIO_BASE}/video/${videoId}/edit`);
  if (nav.error) return `Navigation failed: ${nav.error}`;
  const authErr = await ensureAuth(r);
  if (authErr) return authErr;
  const ready = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'visible', timeout: 20000 }, r.tabId);
  if (ready.error) return `Edit page did not load for ${videoId}: ${ready.error}`;
  await wait(600);
  return null;
}

export async function handleYoutubeMetadata(args: {
  videoId: string;
  title?: string;
  description?: string;
  tags?: string[];
  category?: string;
  madeForKids?: boolean;
  sessionId?: string;
  tabId?: string;
}) {
  if (!args.title && !args.description && !args.tags && !args.category && args.madeForKids === undefined) {
    return text('Nothing to update — provide at least one of: title, description, tags, category, madeForKids.');
  }
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const openErr = await openEdit(r, args.videoId);
  if (openErr) return text(openErr);

  const changed: string[] = [];

  if (args.title) {
    const ok = await fillStudio(r, '#title-textarea #textbox', args.title.slice(0, 100), 'Add a title that describes your video');
    if (ok.ok) changed.push('title');
  }
  if (args.description) {
    const ok = await fillStudio(r, '#description-textarea #textbox', args.description, 'Tell viewers about your video');
    if (ok.ok) changed.push('description');
  }

  // Tags + category live under "Show more".
  if (args.tags?.length || args.category) {
    await clickStudio(r, '#toggle-button', 'Show more');
    await wait(700);
  }
  if (args.tags?.length) {
    // Clear, then commit each tag with its own comma — a comma-joined blob only
    // tokenizes the last tag.
    await ni.fill(r.sessionId, '#tags-container #text-input', '', undefined, r.tabId, 'Tags').catch(() => {});
    let anyTag = false;
    for (const tag of args.tags) {
      const tg = tag.trim();
      if (!tg) continue;
      const typed = await ni.type(r.sessionId, '#tags-container #text-input', `${tg},`, undefined, r.tabId, 'Tags', 'insert');
      if (typed.error) break;
      anyTag = true;
      await wait(150);
    }
    if (anyTag) { await ni.pressKey(r.sessionId, 'Enter', r.tabId); changed.push('tags'); }
  }
  if (args.category) {
    const dd = await clickStudio(r, '#category-container', 'Category');
    if (dd.ok) {
      await wait(600);
      const opt = await clickStudio(r, `tp-yt-paper-item:has-text("${args.category}")`, args.category);
      if (opt.ok) changed.push('category');
      await wait(300);
    }
  }
  if (args.madeForKids !== undefined) {
    const kidsName = args.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK';
    const ok = await clickStudio(r, `tp-yt-paper-radio-button[name="${kidsName}"]`);
    if (ok.ok) changed.push('madeForKids');
    await wait(300);
  }

  // Save.
  const save = await clickStudio(r, '#save', 'Save');
  if (!save.ok) return text(`Updated [${changed.join(', ') || 'nothing'}] but could not click Save: ${save.error}.`);
  // Locale-tolerant: match the "saved" success stems across en + pt-BR.
  const saved = await pollFor(r, `(() => /saved|Salv|Changes saved|Alteraç|Atualizad/i.test(document.body.innerText) ? true : null)()`, 12000, 500);

  return text(JSON.stringify({ videoId: args.videoId, updated: changed, saved: !!saved }, null, 2));
}
