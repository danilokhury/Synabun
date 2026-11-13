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

import { statSync } from 'node:fs';
import { z } from 'zod/v3';
import { v4 as uuidv4 } from 'uuid';
import * as ni from '../../services/neural-interface.js';
import { generateEmbedding } from '../../services/local-embeddings.js';
import { upsertMemory } from '../../services/sqlite.js';
import { ensureCategory, FEATURE_CATEGORIES } from '../../services/categories.js';
import { detectProject } from '../../config.js';
import type { MemoryPayload } from '../../types.js';
import { text } from '../response.js';
import {
  STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate,
  clickStudio, fillStudio, type Resolved,
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
  'Pass game/igdbId/appid/sourceTrailerId so the upload is remembered and never re-posted. Default visibility=private so you can schedule afterwards with youtube_schedule. ' +
  'Result JSON: state = "published" (the tool clicked Publish/Save and Studio confirmed it; visibility is then the one applied), "draft" (a video row exists but is NOT published: see draftReason, e.g. processing/checks still running or the publish step not reached; finish it in Studio with Edit draft → Visibility → Publish once processing ends, never re-upload) or "upload_not_confirmed" (no evidence a row exists; check Studio → Content before any retry). ' +
  'videoId is read only from this upload\'s own dialog; idConfirmed=false with videoId null means no trustworthy id was found (never a guess). videoRowExists tells you whether a duplicate upload would be created by retrying.';

async function ensureOnStudio(r: Resolved): Promise<string | null> {
  const res = await ni.evaluate(r.sessionId, `location.href`, r.tabId);
  const url = String(res.result || '');
  if (/studio\.youtube\.com/.test(url)) return null;
  const nav = await safeNavigate(r, STUDIO_BASE);
  if (nav.error) return `Navigation failed: ${nav.error}`;
  return ensureAuth(r);
}

/** Ensure the dedup-ledger category exists (so it shows in the UI and routing): made on the first upload, under "social" when that exists. */
function ensureTrailerCategory(): void {
  ensureCategory(TRAILER_CATEGORY, FEATURE_CATEGORIES[TRAILER_CATEGORY].description, { parent: 'social' });
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

/**
 * Read the upload dialog's own state. Everything is scoped to
 * ytcp-uploads-dialog (and the share dialog Studio shows after Publish/Save),
 * never the page: the old reader matched the first youtu.be link anywhere in
 * document.body, which picked up other videos of the channel.
 */
const DIALOG_PROBE = `(() => {
  const ID = /(?:youtu\\.be\\/|\\/shorts\\/|watch\\?v=|\\/video\\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
  const deepAll = (root, sel, out) => {
    if (!root) return out;
    root.querySelectorAll(sel).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) deepAll(el.shadowRoot, sel, out); });
    return out;
  };
  const visible = (el) => !!el && !el.hidden && el.getAttribute('aria-hidden') !== 'true' && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const idIn = (root) => {
    if (!root) return null;
    for (const a of deepAll(root, 'a[href]', [])) { const m = (a.getAttribute('href') || '').match(ID); if (m) return m[1]; }
    for (const el of deepAll(root, '[video-id],[data-video-id]', [])) {
      const v = el.getAttribute('video-id') || el.getAttribute('data-video-id');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    }
    return null;
  };
  const dialog = deepAll(document, 'ytcp-uploads-dialog', []).find(visible) || null;
  const share = deepAll(document, 'ytcp-video-share-dialog', []).find(visible) || null;
  const prechecks = deepAll(document, 'ytcp-prechecks-warning-dialog', []).find(visible) || null;
  const progress = dialog ? (deepAll(dialog, 'ytcp-video-upload-progress', [])[0] || null) : null;
  const progressText = progress ? (progress.innerText || progress.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const pm = progressText.match(/(\\d{1,3})\\s?%/);
  const done = dialog ? (deepAll(dialog, '#done-button', [])[0] || null) : null;
  const doneDisabled = done ? (done.hasAttribute('disabled') || done.getAttribute('aria-disabled') === 'true') : null;
  const uploadingAttr = progress ? (progress.hasAttribute('uploading') || progress.getAttribute('upload-status') === 'UPLOADING') : false;
  const uploadingWord = /upload|envi|carreg/i.test(progressText) && !!pm;
  return {
    dialogOpen: !!dialog,
    shareOpen: !!share,
    prechecksOpen: !!prechecks,
    id: idIn(share) || idIn(dialog),
    percent: pm ? Number(pm[1]) : null,
    uploading: uploadingAttr || uploadingWord,
    progressText: progressText.slice(0, 160),
    doneDisabled,
    formVisible: !!dialog && deepAll(dialog, '#title-textarea', []).some(visible),
  };
})()`;

type DialogState = {
  dialogOpen: boolean; shareOpen: boolean; prechecksOpen: boolean; id: string | null;
  percent: number | null; uploading: boolean; progressText: string; doneDisabled: boolean | null; formVisible: boolean;
};

async function probe(r: Resolved): Promise<DialogState | null> {
  const res = await ni.evaluate(r.sessionId, DIALOG_PROBE, r.tabId);
  if (res.error || !res.result || typeof res.result !== 'object') return null;
  return res.result as DialogState;
}

/** Wait until the file transfer itself is over (no longer "uploading"), bounded by a size-aware limit. */
async function waitForTransfer(r: Resolved, limitMs: number): Promise<{ finished: boolean; last: DialogState | null }> {
  const start = Date.now();
  let last: DialogState | null = null;
  while (Date.now() - start < limitMs) {
    last = await probe(r);
    if (last && last.dialogOpen && last.formVisible && !last.uploading) return { finished: true, last };
    if (last && !last.dialogOpen) return { finished: false, last };
    await wait(2000);
  }
  return { finished: false, last };
}

function sizeAwareLimitMs(filePath: string): number {
  let bytes = 0;
  try { bytes = statSync(filePath).size; } catch { /* unknown size */ }
  // Assume a slow 0.25 MB/s upstream, plus 2 minutes; cap at 45 minutes.
  return Math.min(45 * 60_000, 120_000 + Math.ceil(bytes / (0.25 * 1024 * 1024)) * 1000);
}

type UploadState = 'published' | 'draft' | 'upload_not_confirmed';

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

  const requested = args.visibility || 'private';
  const title = args.title.slice(0, 100);
  const limitMs = sizeAwareLimitMs(args.filePath);
  let videoId: string | null = null;
  const notes: string[] = [];
  const noteId = (s: DialogState | null) => { if (!videoId && s?.id) videoId = s.id; };

  // 1) Open the Create menu → Upload videos.
  let create = await clickStudio(r, '#create-icon', 'Create');
  if (!create.ok) create = await clickStudio(r, 'button[aria-label="Criar"]', 'Criar');
  if (!create.ok) create = await clickStudio(r, 'ytcp-button[class*="CreateIcon"]', 'Criar');
  if (!create.ok) return text(`Could not open the Create menu: ${create.error}`);
  await wait(700);
  const uploadItem = await clickStudio(r, 'tp-yt-paper-item#text-item-0', 'Upload videos');
  if (!uploadItem.ok) {
    const alt = await clickStudio(r, '#upload-button', 'Upload videos');
    if (!alt.ok) {
      const altPt = await clickStudio(r, '[role="menuitem"]:first-of-type', 'Enviar vídeos');
      if (!altPt.ok) return text(`Could not find the "Upload videos" menu item: ${uploadItem.error}`);
    }
  }

  // 2) Set the file. A timeout here does not mean the upload failed: YouTube
  // often has the file already, so look at the dialog before giving up.
  const waitInput = await ni.waitFor(r.sessionId, { selector: 'input[type="file"]', state: 'attached', timeout: 15000 }, r.tabId);
  if (waitInput.error) return text(`Upload dialog did not open: ${waitInput.error}`);
  const up = await ni.upload(r.sessionId, 'input[type="file"]', [args.filePath], undefined, r.tabId);
  if (up.error) notes.push(`File input step reported: ${up.error}. Checked the dialog to see whether the upload started anyway.`);

  // 3) Wait for the details form of THIS upload.
  const formReady = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'visible', timeout: up.error ? 90000 : 30000 }, r.tabId);
  if (formReady.error) {
    const s = await probe(r);
    noteId(s);
    const started = !!(s && s.dialogOpen && (s.formVisible || s.percent != null || s.id));
    return result({
      state: started ? 'draft' : 'upload_not_confirmed',
      draftReason: started ? 'details form did not finish loading; the upload dialog is still open' : null,
      videoRowExists: started ? true : 'unknown',
      notes: [...notes, `Details form did not appear: ${formReady.error}.`, started
        ? 'The upload started: do NOT upload again. Leave the tab on Studio and finish the draft there.'
        : 'No sign of the upload in the dialog. Check Studio → Content before any retry.'],
    });
  }
  await wait(800);
  noteId(await probe(r));

  // 4–6) Metadata.
  const titleOk = await fillStudio(r, '#title-textarea #textbox', title, 'Add a title that describes your video');
  if (!titleOk.ok) notes.push(`Could not set the title: ${titleOk.error}.`);
  if (args.description) await fillStudio(r, '#description-textarea #textbox', args.description, 'Tell viewers about your video');
  if (args.tags && args.tags.length) {
    await clickStudio(r, '#toggle-button', 'Show more');
    await wait(700);
    for (const tag of args.tags) {
      const t = tag.trim();
      if (!t) continue;
      const typed = await ni.type(r.sessionId, '#tags-container #text-input', `${t},`, undefined, r.tabId, 'Tags', 'insert');
      if (typed.error) break;
      await wait(150);
    }
    await ni.pressKey(r.sessionId, 'Enter', r.tabId);
    await wait(300);
  }

  // 7) Audience.
  const kidsName = args.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK';
  await clickStudio(r, `tp-yt-paper-radio-button[name="${kidsName}"]`, args.madeForKids ? 'Yes, it\'s made for kids' : 'No, it\'s not made for kids');
  await wait(400);

  // 8) Let the transfer itself finish before anything can close the dialog.
  const transfer = await waitForTransfer(r, limitMs);
  noteId(transfer.last);
  if (!transfer.finished) {
    const open = !!transfer.last?.dialogOpen;
    return result({
      state: open ? 'draft' : 'upload_not_confirmed',
      draftReason: open ? `file transfer still running after ${Math.round(limitMs / 60000)} min (${transfer.last?.progressText || 'no progress text'})` : null,
      videoRowExists: open ? true : 'unknown',
      notes: [...notes, open
        ? 'The upload is in progress: do NOT upload again and do not leave the Studio tab until it reaches 100%.'
        : 'The upload dialog closed before the transfer was confirmed. Check Studio → Content before any retry.'],
    });
  }

  // 9) Advance the wizard to Visibility.
  for (let step = 0; step < 3; step++) {
    const next = await clickStudio(r, '#next-button', 'Next');
    if (!next.ok) break;
    await wait(900);
  }
  const vis = requested.toUpperCase();
  const visReady = await ni.waitFor(r.sessionId, { selector: `tp-yt-paper-radio-button[name="${vis}"]`, state: 'visible', timeout: 12000 }, r.tabId);
  const visClick = visReady.error ? { ok: false, error: visReady.error } : await clickStudio(r, `tp-yt-paper-radio-button[name="${vis}"]`, vis.charAt(0) + vis.slice(1).toLowerCase());
  noteId(await probe(r));
  if (!visClick.ok) {
    return result({
      state: 'draft',
      draftReason: `publish step not reached: visibility ${vis} could not be selected (${visClick.error})`,
      videoRowExists: true,
      notes,
    });
  }
  await wait(500);

  // 10) Publish / Save, only when Studio enables the button (it stays
  // disabled while processing or checks run). Wait a bounded time for that.
  const enableDeadline = Date.now() + Math.min(limitMs, 10 * 60_000);
  let s = await probe(r);
  while (s && s.doneDisabled && Date.now() < enableDeadline) { await wait(3000); s = await probe(r); }
  noteId(s);
  if (!s || s.doneDisabled) {
    return result({
      state: 'draft',
      draftReason: 'processing or checks still running: the Publish/Save button stayed disabled',
      videoRowExists: true,
      notes,
    });
  }
  const done = await clickStudio(r, '#done-button', requested === 'public' ? 'Publish' : 'Save');
  if (!done.ok) {
    return result({ state: 'draft', draftReason: `publish step not completed: could not click Publish/Save (${done.error})`, videoRowExists: true, notes });
  }

  // 11) Confirmation: Studio's share dialog ("Video published" / "saved").
  let confirmed = false;
  let prechecks = false;
  const confirmDeadline = Date.now() + 30000;
  while (Date.now() < confirmDeadline) {
    await wait(1000);
    const c = await probe(r);
    if (!c) continue;
    noteId(c);
    if (c.shareOpen) { confirmed = true; if (c.id) videoId = c.id; break; }
    if (c.prechecksOpen) { prechecks = true; break; }
  }
  if (!confirmed) {
    return result({
      state: 'draft',
      draftReason: prechecks
        ? 'checks still running: Studio asked for confirmation before publishing; nothing was confirmed'
        : 'Publish/Save was clicked but Studio showed no confirmation (dialog closed or still saving)',
      videoRowExists: true,
      notes,
    });
  }
  return result({ state: 'published', draftReason: null, videoRowExists: true, notes });

  async function result(o: { state: UploadState; draftReason: string | null; videoRowExists: boolean | 'unknown'; notes: string[] }) {
    const idConfirmed = !!videoId;
    const hasIdentity = !!(args.game || args.igdbId != null || args.appid != null || args.sourceTrailerId);
    let recordedMemoryId: string | null = null;
    // A row exists (published or draft): record it so the trailer is not re-posted.
    if (o.videoRowExists === true && hasIdentity) {
      recordedMemoryId = await recordTrailerLedger({
        game: args.game, igdbId: args.igdbId, appid: args.appid, sourceTrailerId: args.sourceTrailerId,
        source: args.source, videoId, title,
        visibility: o.state === 'published' ? requested : 'draft',
      });
    }
    const summary = o.state === 'published'
      ? `Published as ${requested} and confirmed by Studio.`
      : o.state === 'draft'
        ? `Uploaded but NOT published (draft): ${o.draftReason}. Finish it in Studio (Edit draft → Visibility → Publish) once processing ends; do not upload again.`
        : 'Upload not confirmed. Check Studio → Content before any retry to avoid a duplicate.';
    return text(JSON.stringify({
      state: o.state,
      uploaded: o.videoRowExists === true,
      published: o.state === 'published',
      videoRowExists: o.videoRowExists,
      videoId,
      idConfirmed,
      visibility: o.state === 'published' ? requested : null,
      requestedVisibility: requested,
      draftReason: o.draftReason,
      title,
      recordedMemoryId,
      ledger: recordedMemoryId
        ? 'Recorded to youtube-videos (dedup ledger).'
        : (hasIdentity ? 'No confirmed video row — ledger NOT recorded.' : 'No game/igdbId/appid/sourceTrailerId passed — ledger NOT recorded.'),
      note: [summary, idConfirmed ? `Video id ${videoId} (read from this upload's dialog).` : 'No trustworthy video id could be read from this upload\'s dialog: videoId is null. Find it in Studio → Content (the draft\'s edit URL).', ...o.notes].join(' '),
    }, null, 2));
  }
}
