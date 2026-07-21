/**
 * youtube_thumbnail — upload a custom thumbnail image to a video.
 * youtube_endscreen — apply an end-screen template to a video.
 * Both operate on the Studio video editor pages.
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate, clickStudio, type Resolved } from './helpers.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

// ── youtube_thumbnail ─────────────────────────────────────────

export const youtubeThumbnailSchema = {
  videoId: z.string().describe('YouTube video id.'),
  filePath: z.string().describe('Absolute path to the thumbnail image (JPG/PNG, ≤2MB, 1280×720 recommended).'),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubeThumbnailDescription =
  'Upload a custom thumbnail to a video via its Studio edit page (uses the hidden thumbnail file input). Saves on completion. [mutating].';

export async function handleYoutubeThumbnail(args: { videoId: string; filePath: string; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const nav = await safeNavigate(r, `${STUDIO_BASE}/video/${args.videoId}/edit`);
  if (nav.error) return text(`Navigation failed: ${nav.error}`);
  const authErr = await ensureAuth(r);
  if (authErr) return text(authErr);
  const ready = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'visible', timeout: 20000 }, r.tabId);
  if (ready.error) return text(`Edit page did not load: ${ready.error}`);
  await wait(600);

  // The thumbnail uploader uses <input id="file-loader" type="file">. Fall back
  // to any file input inside the thumbnail editor if the id shifts.
  let up = await ni.upload(r.sessionId, '#file-loader', [args.filePath], undefined, r.tabId);
  if (up.error) {
    up = await ni.upload(r.sessionId, 'ytcp-video-thumbnail-editor input[type="file"]', [args.filePath], undefined, r.tabId);
  }
  if (up.error) return text(`Thumbnail upload failed: ${up.error}. The video may still be processing, or it is too large.`);
  await wait(1200);

  const save = await clickStudio(r, '#save', 'Save');
  if (!save.ok) return text(`Thumbnail set but could not click Save: ${save.error}.`);
  const saved = await pollFor(r, `(() => /saved|Salvo|Changes saved/i.test(document.body.innerText) ? true : null)()`, 12000, 500);
  return text(JSON.stringify({ videoId: args.videoId, thumbnail: 'uploaded', saved: !!saved }, null, 2));
}

// ── youtube_endscreen ─────────────────────────────────────────

export const youtubeEndscreenSchema = {
  videoId: z.string().describe('YouTube video id.'),
  template: z.enum(['default', 'last_video_subscribe', 'import'] as const).optional().describe(
    "Which end-screen layout to apply. 'default' = first built-in template; 'last_video_subscribe' = best-for-retention; 'import' = copy from your most recent video.",
  ),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubeEndscreenDescription =
  'Apply an end-screen template to a video (links to a related video/playlist + a subscribe element) via the Studio end-screen editor, then save. [mutating]. End-screen editing is canvas-based and may need a manual touch-up.';

export async function handleYoutubeEndscreen(args: {
  videoId: string;
  template?: 'default' | 'last_video_subscribe' | 'import';
  sessionId?: string;
  tabId?: string;
}) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const nav = await safeNavigate(r, `${STUDIO_BASE}/video/${args.videoId}/end_screens`);
  if (nav.error) return text(`Navigation failed: ${nav.error}`);
  const authErr = await ensureAuth(r);
  if (authErr) return text(authErr);
  await pollFor(r, `(() => /end screen|Tela final|Apply (a )?template|Aplicar modelo|Import|Importar/i.test(document.body.innerText) ? true : null)()`, 20000, 500);
  await wait(800);

  if (args.template === 'import') {
    const imp = await clickStudio(r, '#import-button', 'Import from video');
    if (imp.ok) {
      await wait(900);
      // Pick the first video in the import picker.
      await clickStudio(r, 'ytve-import-video-row', undefined, 0);
      await wait(600);
      await clickStudio(r, '#import-button-in-dialog', 'Import');
    }
  } else {
    // Apply a built-in template. The template gallery items are paper-items;
    // 'last_video_subscribe' is typically the 2nd template, 'default' the 1st.
    const applied = await clickStudio(r, '#templates-button', 'Apply template');
    if (applied.ok) await wait(800);
    const idx = args.template === 'last_video_subscribe' ? 1 : 0;
    await clickStudio(r, 'ytve-template-picker-item, tp-yt-paper-item', undefined, idx);
    await wait(700);
  }

  const save = await clickStudio(r, '#save-button', 'Save');
  if (!save.ok) {
    const alt = await clickStudio(r, '#save', 'Save');
    if (!alt.ok) return text(`Applied an end-screen layout but could not click Save: ${save.error}. Finish in the browser panel.`);
  }
  const saved = await pollFor(r, `(() => /saved|Salvo|Changes saved/i.test(document.body.innerText) ? true : null)()`, 12000, 500);
  return text(JSON.stringify({ videoId: args.videoId, endscreen: args.template || 'default', saved: !!saved }, null, 2));
}
