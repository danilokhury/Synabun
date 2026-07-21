/**
 * youtube_schedule — set a future publish time (or change visibility) on a video
 * via the Studio edit page's visibility dialog. Lets the autopilot drip trailers
 * out instead of publishing them all at once.
 *
 * Date/time entry is locale-aware: this channel runs in America/Sao_Paulo (pt-BR
 * Studio uses DD/MM/AAAA + 24h), so we pick the field format from the page locale
 * and read the picker back so a mis-parsed date is visible, not silent.
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate, clickStudio, fillStudio } from './helpers.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

export const youtubeScheduleSchema = {
  videoId: z.string().describe('YouTube video id.'),
  publishAt: z.string().optional().describe('Scheduled publish time, ISO ("2026-06-20T18:00") or "YYYY-MM-DD HH:MM". Required unless setting an immediate visibility.'),
  visibility: z.enum(['private', 'unlisted', 'public', 'schedule'] as const).optional().describe('Set immediate visibility, or "schedule" (default when publishAt is given).'),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubeScheduleDescription =
  'Schedule a video to go public at a future time (or set immediate visibility) via the Studio visibility dialog. ' +
  'Pass publishAt for scheduling. [mutating]. Locale-aware date entry (US + pt-BR); the response echoes the picker read-back as scheduledDisplay — verify it matches your intended slot.';

type DateTimeFormats = { dateUS: string; dateBR: string; time12: string; time24: string };

function buildDateTimeFormats(publishAt: string): DateTimeFormats | null {
  // Accept ISO or "YYYY-MM-DD HH:MM".
  const m = publishAt.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateUS = `${months[parseInt(mo, 10) - 1]} ${parseInt(d, 10)}, ${y}`; // "Jun 20, 2026"
  const dateBR = `${d}/${mo}/${y}`; // "20/06/2026"
  let h = parseInt(hh, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const time12 = `${h}:${mm} ${ampm}`; // "2:00 PM"
  const time24 = `${hh.padStart(2, '0')}:${mm}`; // "14:00"
  return { dateUS, dateBR, time12, time24 };
}

export async function handleYoutubeSchedule(args: {
  videoId: string;
  publishAt?: string;
  visibility?: 'private' | 'unlisted' | 'public' | 'schedule';
  sessionId?: string;
  tabId?: string;
}) {
  const wantsSchedule = args.visibility === 'schedule' || (!!args.publishAt && !args.visibility);
  if (wantsSchedule && !args.publishAt) return text('publishAt is required to schedule a video.');

  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  const nav = await safeNavigate(r, `${STUDIO_BASE}/video/${args.videoId}/edit`);
  if (nav.error) return text(`Navigation failed: ${nav.error}`);
  const authErr = await ensureAuth(r);
  if (authErr) return text(authErr);
  const ready = await ni.waitFor(r.sessionId, { selector: '#title-textarea', state: 'visible', timeout: 20000 }, r.tabId);
  if (ready.error) return text(`Edit page did not load: ${ready.error}`);
  await wait(600);

  // Detect the Studio UI language once (this channel runs pt-BR) so the element
  // fallbacks and date formats below use the right text hints.
  const langRes = await ni.evaluate(r.sessionId, `((document.documentElement && document.documentElement.lang) || navigator.language || '').toLowerCase()`, r.tabId);
  const isPt = String(langRes.result || '').startsWith('pt');

  // Open the visibility dialog (stable id → component → text fallback, for pt-BR Studio).
  let openVis = await clickStudio(r, '#visibility-container', isPt ? 'Visibilidade' : 'Visibility');
  if (!openVis.ok) openVis = await clickStudio(r, 'ytcp-video-visibility-select', isPt ? 'Visibilidade' : 'Visibility');
  if (!openVis.ok) openVis = await clickStudio(r, 'ytcp-video-metadata-visibility, #visibility-button', isPt ? 'Visibilidade' : 'Visibility');
  if (!openVis.ok) return text(`Could not open the visibility dialog: ${openVis.error}. Open it manually in the browser panel, then retry.`);
  await wait(900);

  let scheduledDisplay: string | null = null;
  let localeUsed: 'pt' | 'us' | undefined;

  if (wantsSchedule) {
    // Select Schedule (stable name= → class → text fallback, for pt-BR Studio
    // where the radio is sometimes replaced by an "Agendar" button).
    let sched = await clickStudio(r, 'tp-yt-paper-radio-button[name="SCHEDULE"]', isPt ? 'Agendar' : 'Schedule');
    if (!sched.ok) sched = await clickStudio(r, 'ytcp-button[class*="Schedule"], [test-id="SCHEDULE"]', isPt ? 'Agendar' : 'Schedule');
    if (!sched.ok) sched = await clickStudio(r, '[name="SCHEDULE"]', isPt ? 'Agendar' : 'Schedule');
    if (!sched.ok) return text(`Could not select the Schedule option: ${sched.error}. Set it manually in the browser panel.`);
    await wait(700);
    const dt = buildDateTimeFormats(args.publishAt!);
    if (!dt) return text(`Could not parse publishAt "${args.publishAt}". Use ISO or "YYYY-MM-DD HH:MM".`);

    // Pick the field format from the page locale (pt-BR → DD/MM/AAAA + 24h).
    localeUsed = isPt ? 'pt' : 'us';
    const dateStr = isPt ? dt.dateBR : dt.dateUS;
    const timeStr = isPt ? dt.time24 : dt.time12;

    // Date picker.
    await clickStudio(r, '#datepicker-trigger', 'Date');
    await wait(400);
    await fillStudio(r, '#datepicker-trigger #textbox', dateStr, 'Date');
    await ni.pressKey(r.sessionId, 'Enter', r.tabId);
    await wait(400);
    // Time field.
    await fillStudio(r, 'ytcp-datetime-picker #time-of-day-container #textbox', timeStr, 'Time');
    await ni.pressKey(r.sessionId, 'Enter', r.tabId);
    await wait(400);

    // Read the picker back (shadow-pierced) so a mis-parsed date is visible.
    const rb = await ni.evaluate(
      r.sessionId,
      `(() => {
        const out = [];
        const walk = (root) => {
          if (!root) return;
          root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
          root.querySelectorAll('#datepicker-trigger, ytcp-datetime-picker').forEach((n) => {
            const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
            if (t) out.push(t);
          });
        };
        try { walk(document); } catch {}
        return out.join(' | ').slice(0, 160) || null;
      })()`,
      r.tabId,
    );
    scheduledDisplay = (rb.result as string | null) || null;
  } else {
    const vis = (args.visibility || 'private').toUpperCase();
    const ok = await clickStudio(r, `tp-yt-paper-radio-button[name="${vis}"]`, vis.charAt(0) + vis.slice(1).toLowerCase());
    if (!ok.ok) return text(`Could not select visibility ${vis}: ${ok.error}.`);
    await wait(400);
  }

  // Save (the visibility dialog's Done/Save).
  const save = await clickStudio(r, '#save-button', wantsSchedule ? 'Schedule' : 'Save');
  if (!save.ok) {
    const alt = await clickStudio(r, '#done-button', 'Done');
    if (!alt.ok) return text(`Set the visibility but could not confirm/Save: ${save.error}. Confirm in the browser panel.`);
  }
  // Locale-tolerant confirm: match the success stems across en + pt-BR.
  const done = await pollFor(r, `(() => /Scheduled|Agendad|Programad|Published|Publicad|saved|Salv/i.test(document.body.innerText) ? true : null)()`, 12000, 500);

  return text(JSON.stringify({
    videoId: args.videoId,
    action: wantsSchedule ? 'scheduled' : 'visibility',
    publishAt: wantsSchedule ? args.publishAt : undefined,
    visibility: wantsSchedule ? 'scheduled→public' : (args.visibility || 'private'),
    localeUsed,
    scheduledDisplay,
    confirmed: !!done,
    note: wantsSchedule
      ? 'Verify scheduledDisplay matches your intended slot — if the day/month look swapped, the channel locale differs from what was detected; re-run with the date pre-formatted for that locale or fix it in the panel.'
      : undefined,
  }, null, 2));
}
