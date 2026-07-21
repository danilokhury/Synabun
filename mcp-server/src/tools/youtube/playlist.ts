/**
 * youtube_playlist — create a playlist, add a video to a playlist, or list
 * playlists. Browser-driven through Studio (the Content → Playlists section and
 * the video edit page's Playlists dropdown).
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate, clickStudio, fillStudio, DEEP_TEXT_SCRIPT, type Resolved } from './helpers.js';
import { channelId } from './navigate.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

export const youtubePlaylistSchema = {
  action: z.enum(['list', 'create', 'add'] as const).describe('list = enumerate playlists; create = make a new playlist; add = add a video to a playlist.'),
  name: z.string().optional().describe('Playlist name (required for create/add).'),
  videoId: z.string().optional().describe('Video id to add (required for action=add).'),
  visibility: z.enum(['public', 'unlisted', 'private'] as const).optional().describe('New playlist visibility (create). Default public.'),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubePlaylistDescription =
  'Manage playlists. action=list enumerates them; action=create makes a new playlist; action=add adds a video to an existing playlist (by name). [mutating for create/add].';

async function gotoPlaylists(r: Resolved): Promise<string | null> {
  let cid = await channelId(r);
  if (!cid) {
    await safeNavigate(r, STUDIO_BASE);
    await pollFor(r, `(() => /\\/channel\\/UC/.test(location.href) ? true : null)()`, 12000, 400);
    cid = await channelId(r);
  }
  if (!cid) return 'Could not resolve the active channel.';
  const nav = await safeNavigate(r, `${STUDIO_BASE}/channel/${cid}/playlists`);
  if (nav.error) return `Navigation failed: ${nav.error}`;
  const authErr = await ensureAuth(r);
  if (authErr) return authErr;
  await wait(1200);
  return null;
}

export async function handleYoutubePlaylist(args: {
  action: 'list' | 'create' | 'add';
  name?: string;
  videoId?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  sessionId?: string;
  tabId?: string;
}) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  if (args.action === 'list') {
    const err = await gotoPlaylists(r);
    if (err) return text(err);
    const res = await ni.evaluate(
      r.sessionId,
      `(() => {
        const out = new Set();
        const walk = (root) => {
          if (!root) return;
          root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
          root.querySelectorAll('#playlist-title, a#title, .playlist-title, [id="title"]').forEach(n => {
            const t = (n.textContent || '').trim();
            if (t && t.length < 120) out.add(t);
          });
        };
        try { walk(document); } catch {}
        return Array.from(out);
      })()`,
      r.tabId,
    );
    const names = (res.result as string[]) || [];
    return text(JSON.stringify({ count: names.length, playlists: names }, null, 2));
  }

  if (args.action === 'create') {
    if (!args.name) return text('name is required for action=create.');
    const err = await gotoPlaylists(r);
    if (err) return text(err);
    const open = await clickStudio(r, '#create-playlist-button', 'New playlist');
    if (!open.ok) {
      const alt = await clickStudio(r, 'ytcp-button:has-text("New playlist")', 'New playlist');
      if (!alt.ok) return text(`Could not open the New Playlist dialog: ${open.error}.`);
    }
    await wait(900);
    const titled = await fillStudio(r, '#create-playlist-form #textbox', args.name, 'Title');
    if (!titled.ok) {
      await fillStudio(r, 'textarea#textbox', args.name, 'Title');
    }
    await wait(400);
    // Visibility dropdown (optional — defaults to public).
    if (args.visibility && args.visibility !== 'public') {
      await clickStudio(r, '#visibility-select', 'Visibility');
      await wait(400);
      await clickStudio(r, `tp-yt-paper-item:has-text("${args.visibility}")`, args.visibility);
      await wait(300);
    }
    const create = await clickStudio(r, '#create-button', 'Create');
    if (!create.ok) return text(`Filled the playlist title but could not click Create: ${create.error}.`);
    await wait(1000);
    return text(JSON.stringify({ created: args.name, visibility: args.visibility || 'public' }, null, 2));
  }

  // action === 'add'
  if (!args.name || !args.videoId) return text('name and videoId are required for action=add.');
  const nav = await safeNavigate(r, `${STUDIO_BASE}/video/${args.videoId}/edit`);
  if (nav.error) return text(`Navigation failed: ${nav.error}`);
  const authErr = await ensureAuth(r);
  if (authErr) return text(authErr);
  const ready = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'visible', timeout: 20000 }, r.tabId);
  if (ready.error) return text(`Edit page did not load: ${ready.error}`);
  await wait(600);

  const open = await clickStudio(r, '#playlists-dropdown-trigger', 'Playlists');
  if (!open.ok) {
    const alt = await clickStudio(r, 'ytcp-text-dropdown-trigger:has-text("Playlists")', 'Playlists');
    if (!alt.ok) return text(`Could not open the Playlists dropdown: ${open.error}.`);
  }
  await wait(900);
  // Check the playlist by name.
  const check = await clickStudio(r, `ytcp-checkbox-group #items tp-yt-paper-checkbox:has-text("${args.name}")`, args.name);
  if (!check.ok) {
    const alt = await clickStudio(r, `tp-yt-paper-checkbox:has-text("${args.name}")`, args.name);
    if (!alt.ok) return text(`Could not find playlist "${args.name}" in the dropdown. Create it first with action=create.`);
  }
  await wait(400);
  await clickStudio(r, '.done-button, #done-button', 'Done');
  await wait(400);
  const save = await clickStudio(r, '#save', 'Save');
  void DEEP_TEXT_SCRIPT; // (reserved for richer confirmation parsing)
  return text(JSON.stringify({ videoId: args.videoId, addedTo: args.name, saved: save.ok }, null, 2));
}
