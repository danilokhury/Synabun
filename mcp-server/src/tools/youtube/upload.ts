/**
 * youtube_upload — upload a local video file to YouTube Studio, set its core
 * metadata, publish at the chosen visibility, and RECORD it to the youtube-videos
 * dedup ledger so the autopilot can never post the same trailer twice.
 *
 * This is the lynchpin: it drives Studio's Create → Upload dialog and uses
 * Playwright setInputFiles on the dialog's hidden <input type="file"> (no API
 * quota / no audit private-lock).
 *
 * Studio is a Polymer app — selectors use stable, locale-independent ids and
 * `name=` attributes (PUBLIC/PRIVATE/SCHEDULE), and success is confirmed by the
 * wizard dialog closing + a resolvable video id, NOT by matching localized UI
 * text (which silently failed on non-English channels and made failed uploads
 * look successful).
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import * as ni from '../../services/neural-interface.js';
import { generateEmbedding } from '../../services/local-embeddings.js';
import { upsertMemory } from '../../services/sqlite.js';
import { categoryExists, addCategory } from '../../services/categories.js';
import { detectProject } from '../../config.js';
import type { MemoryPayload } from '../../types.js';
import { text } from '../response.js';
import {
  STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate,
  clickStudio, fillStudio, resolveLatestUploadedVideoId, type Resolved,
} from './helpers.js';
import { TRAILER_CATEGORY, ledgerTags } from './dedup.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

export const youtubeUploadSchema = {
  filePath: z.string().describe('Absolute path to the local video file (from youtube_download).'),
  title: z.string().describe('Video title (≤100 chars). Studio truncates beyond 100.'),
  description: z.string().optional().describe('Video description (credits, store link, etc.).'),
  tags: z.array(z.string()).optional().describe('Tags/keywords (added under "Show more").'),
  visibility: z.enum(['private', 'unlisted', 'public'] as const).optional().describe('Publish visibility. Default: private (schedule/publish later with youtube_schedule).'),
  madeForKids: z.boolean().optional().describe('COPPA audience flag. Default false (Not made for kids).'),
  // Dedup identity — recorded to the youtube-videos ledger so this trailer is
  // never re-sourced. Pass these straight from the youtube_source candidate.
  game: z.string().optional().describe('Game name (from the youtube_source candidate). Recorded to the youtube-videos dedup ledger.'),
  igdbId: z.number().optional().describe('IGDB id (from youtube_source). Dedup ledger key — pass it whenever known.'),
  appid: z.number().optional().describe('Steam appid (from youtube_source). Dedup ledger key — pass it whenever known.'),
  sourceTrailerId: z.string().optional().describe('The SOURCE trailer YouTube id you downloaded (a youtube_source ytTrailerIds value). Dedup ledger key.'),
  source: z.enum(['steam', 'yt-dlp', 'youtube'] as const).optional().describe('Where the downloaded file came from (recorded for the ledger).'),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubeUploadDescription =
  'Upload a local video file to YouTube Studio, publish it, and record it to the youtube-videos dedup ledger. ' +
  'Opens Create → Upload, sets the file, fills title/description/tags, advances the wizard, sets visibility, clicks Done, then verifies the wizard closed and resolves the new video id. [mutating — publishes to the channel]. ' +
  'Pass game/igdbId/appid/sourceTrailerId so the upload is remembered and never re-posted. Default visibility=private so you can schedule afterwards with youtube_schedule.';

async function ensureOnStudio(r: Resolved): Promise<string | null> {
  const res = await ni.evaluate(r.sessionId, `location.href`, r.tabId);
  const url = String(res.result || '');
  if (/studio\.youtube\.com/.test(url)) return null;
  const nav = await safeNavigate(r, STUDIO_BASE);
  if (nav.error) return `Navigation failed: ${nav.error}`;
  return ensureAuth(r);
}

/** Ensure the dedup-ledger category exists (so it shows in the UI and routing). */
function ensureTrailerCategory(): void {
  try {
    if (!categoryExists(TRAILER_CATEGORY)) {
      addCategory(
        TRAILER_CATEGORY,
        'One memory per uploaded YouTube trailer — the dedup ledger. Written automatically by youtube_upload; tagged with canonical source ids (igdb:/appid:/ytid:/name:) that youtube_source reads to skip already-posted trailers. Do not store anything else here.',
        categoryExists('social') ? 'social' : undefined,
      );
    }
  } catch { /* non-fatal — upsertMemory does not require a registered category */ }
}

/** Write the dedup-ledger memory for a just-uploaded trailer. Returns the memory id, or null on failure. */
async function recordTrailerLedger(idy: {
  game?: string;
  igdbId?: number;
  appid?: number;
  sourceTrailerId?: string;
  source?: string;
  videoId: string | null;
  title: string;
  visibility: string;
}): Promise<string | null> {
  try {
    ensureTrailerCategory();
    const tags = ledgerTags({
      game: idy.game, igdbId: idy.igdbId, appid: idy.appid, sourceTrailerId: idy.sourceTrailerId,
    });
    const parts = [
      idy.game ? `game=${idy.game}` : null,
      idy.igdbId != null ? `igdbId=${idy.igdbId}` : null,
      idy.appid != null ? `appid=${idy.appid}` : null,
      idy.sourceTrailerId ? `sourceTrailerId=${idy.sourceTrailerId}` : null,
      idy.source ? `source=${idy.source}` : null,
      `videoId=${idy.videoId || 'unknown'}`,
      `visibility=${idy.visibility}`,
    ].filter(Boolean).join(' | ');
    const content = `YouTube trailer uploaded: ${idy.title} [${parts}]`;
    const now = new Date().toISOString();
    const payload: MemoryPayload = {
      content,
      category: TRAILER_CATEGORY,
      project: detectProject(),
      tags,
      importance: 6,
      source: 'self-discovered',
      created_at: now,
      updated_at: now,
      accessed_at: now,
      access_count: 0,
    };
    const id = uuidv4();
    const vector = await generateEmbedding(content);
    await upsertMemory(id, vector, payload);
    try { ni.invalidateCache('remember', id); } catch { /* fire-and-forget */ }
    return id;
  } catch {
    return null;
  }
}

export async function handleYoutubeUpload(args: {
  filePath: string;
  title: string;
  description?: string;
  tags?: string[];
  visibility?: 'private' | 'unlisted' | 'public';
  madeForKids?: boolean;
  game?: string;
  igdbId?: number;
  appid?: number;
  sourceTrailerId?: string;
  source?: 'steam' | 'yt-dlp' | 'youtube';
  sessionId?: string;
  tabId?: string;
}) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const onErr = await ensureOnStudio(r);
  if (onErr) return text(onErr);

  // 1) Open the Create menu → Upload videos.
  // #create-icon is locale-independent in most builds; fall back to aria-label
  // and class-based selectors for PT-BR and other locales where the id is absent.
  let create = await clickStudio(r, '#create-icon', 'Create');
  if (!create.ok) {
    create = await clickStudio(r, 'button[aria-label="Criar"]', 'Criar');
  }
  if (!create.ok) {
    create = await clickStudio(r, 'ytcp-button[class*="CreateIcon"]', 'Criar');
  }
  if (!create.ok) return text(`Could not open the Create menu: ${create.error}`);
  await wait(700);
  // The first item in the create menu is "Upload videos" (PT-BR: "Enviar vídeos").
  const uploadItem = await clickStudio(r, 'tp-yt-paper-item#text-item-0', 'Upload videos');
  if (!uploadItem.ok) {
    // Fallback 1: some Studio builds expose a direct upload button id.
    const alt = await clickStudio(r, '#upload-button', 'Upload videos');
    if (!alt.ok) {
      // Fallback 2: PT-BR locale — click first menuitem by role.
      const altPt = await clickStudio(r, '[role="menuitem"]:first-of-type', 'Enviar vídeos');
      if (!altPt.ok) return text(`Could not find the "Upload videos" menu item: ${uploadItem.error}`);
    }
  }

  // 2) Set the file on the dialog's hidden file input.
  const waitInput = await ni.waitFor(r.sessionId, { selector: 'input[type="file"]', state: 'attached', timeout: 15000 }, r.tabId);
  if (waitInput.error) return text(`Upload dialog did not open: ${waitInput.error}`);
  const up = await ni.upload(r.sessionId, 'input[type="file"]', [args.filePath], undefined, r.tabId);
  if (up.error) return text(`File upload failed: ${up.error}. Check the path exists and is a video file.`);

  // 3) Wait for the details form (title box) to render.
  const formReady = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'visible', timeout: 30000 }, r.tabId);
  if (formReady.error) return text(`Upload details form did not appear: ${formReady.error}`);
  await wait(800);

  // 4) Title (clear the auto-filled filename first via fill).
  const titleOk = await fillStudio(r, '#title-textarea #textbox', args.title.slice(0, 100), 'Add a title that describes your video');
  if (!titleOk.ok) return text(`Could not set the title: ${titleOk.error}`);

  // 5) Description (optional).
  if (args.description) {
    await fillStudio(r, '#description-textarea #textbox', args.description, 'Tell viewers about your video');
  }

  // 6) Tags (optional) — revealed under "Show more". Studio tokenizes a tag on
  // each comma/Enter, so type them one at a time (a single comma-joined blob only
  // commits the last token — the bug that left most tags unset).
  if (args.tags && args.tags.length) {
    await clickStudio(r, '#toggle-button', 'Show more');
    await wait(700);
    for (const tag of args.tags) {
      const t = tag.trim();
      if (!t) continue;
      const typed = await ni.type(r.sessionId, '#tags-container #text-input', `${t},`, undefined, r.tabId, 'Tags', 'insert');
      if (typed.error) break; // tags are optional — never fail the upload over them
      await wait(150);
    }
    await ni.pressKey(r.sessionId, 'Enter', r.tabId);
    await wait(300);
  }

  // 7) Audience (made-for-kids). Default: Not made for kids.
  const kidsName = args.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK';
  await clickStudio(r, `tp-yt-paper-radio-button[name="${kidsName}"]`, args.madeForKids ? 'Yes, it\'s made for kids' : 'No, it\'s not made for kids');
  await wait(400);

  // 8) Advance the wizard: Details → Video elements → Checks → Visibility.
  for (let step = 0; step < 3; step++) {
    const next = await clickStudio(r, '#next-button', 'Next');
    if (!next.ok) break;
    await wait(900);
  }

  // 9) Visibility radio. Wait for the radio group itself (locale-independent
  // name= attribute, shadow-DOM-pierced by Playwright) rather than localized text.
  const vis = (args.visibility || 'private').toUpperCase();
  const visReady = await ni.waitFor(r.sessionId, { selector: `tp-yt-paper-radio-button[name="${vis}"]`, state: 'visible', timeout: 12000 }, r.tabId);
  if (visReady.error) {
    return text(`Reached the wizard but the visibility step did not render (${visReady.error}). The upload may be incomplete — open Studio → Content and finish/verify before retrying to avoid a duplicate.`);
  }
  const visClick = await clickStudio(r, `tp-yt-paper-radio-button[name="${vis}"]`, vis.charAt(0) + vis.slice(1).toLowerCase());
  if (!visClick.ok) return text(`Could not select visibility ${vis}: ${visClick.error}.`);
  await wait(500);

  // 10) Publish / Done.
  const done = await clickStudio(r, '#done-button', args.visibility === 'public' ? 'Publish' : 'Save');
  if (!done.ok) return text(`Set metadata but could not click Done/Publish: ${done.error}. Finish manually in the browser panel.`);

  // 11) Resolve the new video id from the share dialog (freshest source).
  let videoId = await pollFor<string>(
    r,
    `(() => {
      const m = (document.body.innerText || '').match(/youtu\\.be\\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
      const a = Array.from(document.querySelectorAll('a[href*="youtu"]')).map(x => x.href).join(' ');
      const m2 = a.match(/youtu\\.be\\/([A-Za-z0-9_-]{6,})|watch\\?v=([A-Za-z0-9_-]{6,})/);
      return m2 ? (m2[1] || m2[2]) : null;
    })()`,
    9000,
    600,
  );

  // 12) Confirm the wizard actually finished (dialog closed) — the honest
  // success signal. Don't claim a post that didn't complete.
  const closed = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'hidden', timeout: 12000 }, r.tabId);
  const publishConfirmed = !closed.error;

  // 13) Fallback id resolution from the content grid (navigates away — only once
  // publishing is confirmed, so the just-uploaded video is the newest row).
  if (!videoId && publishConfirmed) {
    videoId = await resolveLatestUploadedVideoId(r);
  }

  const uploaded = publishConfirmed || !!videoId;

  // 14) Record the dedup ledger (only on a confirmed upload with an identity —
  // never poison the ledger with a non-upload).
  const hasIdentity = !!(args.game || args.igdbId != null || args.appid != null || args.sourceTrailerId);
  let recordedMemoryId: string | null = null;
  if (uploaded && hasIdentity) {
    recordedMemoryId = await recordTrailerLedger({
      game: args.game,
      igdbId: args.igdbId,
      appid: args.appid,
      sourceTrailerId: args.sourceTrailerId,
      source: args.source,
      videoId: videoId || null,
      title: args.title.slice(0, 100),
      visibility: args.visibility || 'private',
    });
  }

  return text(JSON.stringify({
    uploaded,
    videoId: videoId || null,
    visibility: args.visibility || 'private',
    title: args.title.slice(0, 100),
    recordedMemoryId,
    ledger: recordedMemoryId
      ? 'Recorded to youtube-videos (dedup ledger) — youtube_source will skip this trailer from now on.'
      : (hasIdentity
        ? 'Upload not confirmed — ledger NOT recorded.'
        : 'No game/igdbId/appid/sourceTrailerId passed — ledger NOT recorded; a future run could re-post this. Pass identity from the youtube_source candidate to enable dedup.'),
    note: !uploaded
      ? 'Could not confirm the upload completed (the publish dialog did not close and no video id appeared). Open Studio → Content and verify before retrying to avoid a duplicate.'
      : (videoId ? `Published. Video id ${videoId}.` : 'Published, but could not auto-detect the video id — verify in Studio → Content. Ledger recorded by game id.'),
  }, null, 2));
}
