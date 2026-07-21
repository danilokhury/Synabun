/**
 * GSC Settings + meta tools.
 * Tools: gsc_settings, gsc_crawl_stats, gsc_users, gsc_associations,
 *        gsc_disavow, gsc_shopping, gsc_extract_table, gsc_screenshot
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { GSC_BASE, encodeProperty, currentProperty, ensureAuth, resolve, wait, pollFor, safeNavigate, TABLE_EXTRACTOR_SCRIPT, readMetricTileScript } from './helpers.js';

const tabId = z.string().optional();

async function loadAndExtract(
  sessionId: string | undefined,
  tabIdArg: string | undefined,
  property: string | undefined,
  path: string,
) {
  const r = await resolve(sessionId, tabIdArg);
  if ('error' in r) return { err: r.error, r: null as never };
  const prop = property || (await currentProperty(r));
  if (!prop && !path.startsWith('http')) return { err: 'No active property.', r };
  const url = path.startsWith('http')
    ? `${path}${prop ? `?resource_id=${encodeProperty(prop)}` : ''}`
    : `${GSC_BASE}${path}?resource_id=${encodeProperty(prop || '')}`;
  const nav = await safeNavigate(r, url);
  if (nav.error) return { err: `Navigation failed: ${nav.error}`, r };
  const authErr = await ensureAuth(r);
  if (authErr) return { err: authErr, r };
  await pollFor(r, `(() => document.body.innerText.length > 200 ? true : null)()`, 20000, 500);
  await wait(700);
  return { err: null, r };
}

// ── gsc_settings ──────────────────────────────────────────────

export const gscSettingsSchema = {
  action: z.enum(['get', 'set_address', 'change_address'] as const).optional().describe('Default get. set_address sets the Change-of-address target. change_address opens flow.'),
  newProperty: z.string().optional().describe('Target property for change_address.'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscSettingsDescription =
  'Read or modify property settings — ownership/verification, users, address. action=get returns the settings page summary; action=set_address/change_address mutate.';

export async function handleGscSettings(args: { action?: string; newProperty?: string; property?: string; sessionId?: string; tabId?: string }) {
  const action = args.action || 'get';
  if (action === 'get') {
    const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/settings');
    if (err) return text(err);
    const data = await ni.evaluate(
      r.sessionId,
      `(() => {
        // Scope to [role="main"] / <main> so we don't leak the locale sidebar.
        const main = document.querySelector('[role="main"], main');
        const root = main || document.body;
        const txt = (main ? main.innerText : document.body.innerText) || '';
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const m = (re) => {
          const match = txt.match(re);
          if (!match) return null;
          for (let i = 1; i < match.length; i++) if (match[i]) return match[i];
          return null;
        };
        // Ownership: catch the canonical PT-BR sentence "Você é um proprietário verificado".
        let ownership = null;
        if (/Você é um proprietário verificado|You are a verified owner/i.test(txt)) ownership = 'verified-owner';
        else if (/Você é um proprietário|You are a property owner/i.test(txt)) ownership = 'owner';
        else if (/Você não é proprietário|not a verified owner/i.test(txt)) ownership = 'non-owner';
        else ownership = m(/(?:Ownership|Verificação de propriedade)(?:[\\s\\S]{0,160})?(Verified|Unverified|Verificado|N[aã]o verificado)/i);
        // Verification method — try labeled regex first, else derive from the
        // visible verification section (PT-BR pages show no discrete label).
        const headersList = Array.from(root.querySelectorAll('h2, h3, [role="heading"]'));
        const verifSection = headersList.find(h =>
          /Verification|Verifica[cç][aã]o de propriedade/i.test(h.textContent || ''));
        const verifText = verifSection?.parentElement?.innerText?.split(/\\n+/)
          .find(l => /verified|verificado|HTML|DNS|tag|domain|prefix/i.test(l)) || null;
        const verificationMethod =
          m(/(?:Verification method|M[ée]todo de verifica[cç][aã]o)\\s*[:：]?\\s*([^\\n]+)/i)
          || (verifText ? norm(verifText) : null);
        // Users section: collect listed names from the "Users and permissions"
        // / "Usuários e permissões" block.
        const userNames = [];
        const usersHeading = headersList.find(h => /Users\\s*and\\s*permissions|Usu[aá]rios\\s*e\\s*permiss[oõ]es/i.test(h.textContent || ''));
        if (usersHeading) {
          const sec = usersHeading.closest('section, [role="region"], div') || usersHeading.parentElement;
          if (sec) {
            const items = Array.from(sec.querySelectorAll('[role="listitem"], li, [class*="user" i] [class*="name" i]'));
            items.forEach(i => { const t = norm(i.textContent); if (t && t.length < 120) userNames.push(t); });
          }
        }
        return {
          ownership,
          verificationMethod,
          users: userNames.length > 0 ? userNames : null,
          fullText: txt.slice(0, 4000),
        };
      })()`,
      r.tabId,
    );
    return text(JSON.stringify(data.result, null, 2));
  }
  if (action === 'change_address' || action === 'set_address') {
    const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/settings/change-address');
    if (err) return text(err);
    if (action === 'set_address') {
      if (!args.newProperty) return text('newProperty required for set_address.');
      await ni.evaluate(
        r.sessionId,
        `(() => { const sel = document.querySelector('select, [role="combobox"]'); if (sel) sel.click(); })()`,
        r.tabId,
      );
      await wait(700);
      await ni.evaluate(
        r.sessionId,
        `(() => { const items = Array.from(document.querySelectorAll('[role="option"], option')); const t = items.find(i => i.textContent.includes(${JSON.stringify(args.newProperty)})); if (t) t.click(); })()`,
        r.tabId,
      );
      await wait(500);
      await ni.evaluate(
        r.sessionId,
        `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const sub = btns.find(b => /^(submit|enviar|validate|validar)$/i.test((b.textContent || '').trim())); if (sub) sub.click(); })()`,
        r.tabId,
      );
      return text(`Change of address requested → ${args.newProperty}. Validate via browser_snapshot.`);
    }
    return text('Change-of-address page opened. Use browser_snapshot to view validation steps.');
  }
  return text(`Unknown action: ${action}`);
}

// ── gsc_crawl_stats ───────────────────────────────────────────

export const gscCrawlStatsSchema = {
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscCrawlStatsDescription =
  'Read Crawl Stats — totals (requests, download size, response time) and breakdowns by host status, response code, file type, Googlebot type.';

export async function handleGscCrawlStats(args: { property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/settings/crawl-stats');
  if (err) return text(err);
  // Crawl Stats overview — read tiles first (locale-aware), then fall back
  // to body-text regex with strict unit anchors so we don't catch stray digits.
  const [tr, td, ar] = await Promise.all([
    ni.evaluate(r.sessionId, readMetricTileScript('totalRequests'), r.tabId),
    ni.evaluate(r.sessionId, readMetricTileScript('totalDownloadSize'), r.tabId),
    ni.evaluate(r.sessionId, readMetricTileScript('avgResponseTime'), r.tabId),
  ]);
  let scalar = {
    totalRequests: (tr.result as string | null) ?? null,
    totalDownloadSize: (td.result as string | null) ?? null,
    avgResponseTime: (ar.result as string | null) ?? null,
  };
  if (!scalar.totalRequests || !scalar.totalDownloadSize || !scalar.avgResponseTime) {
    const fallback = await ni.evaluate(
      r.sessionId,
      `(() => {
        const main = document.querySelector('[role="main"], main') || document.body;
        const txt = main.innerText || '';
        const m = (re) => {
          const match = txt.match(re);
          if (!match) return null;
          for (let i = 1; i < match.length; i++) if (match[i]) return match[i];
          return null;
        };
        return {
          totalRequests: m(/(\\d[\\d.,KMG]*)\\s*(?:total\\s*)?(?:crawl\\s*requests?|solicita[cç][oõ]es(?:\\s*de\\s*rastreamento)?)/i),
          // Require explicit unit (KB/MB/GB/byte/byte) to avoid stray "2".
          totalDownloadSize: m(/(\\d[\\d.,]*\\s*(?:KB|MB|GB|TB|byte|bytes|kilobytes?|megabytes?))(?:\\s|$)/i),
          avgResponseTime: m(/(\\d[\\d.,]*\\s*ms)/i),
        };
      })()`,
      r.tabId,
    );
    const fb = (fallback.result as { totalRequests: string | null; totalDownloadSize: string | null; avgResponseTime: string | null } | null)
      || { totalRequests: null, totalDownloadSize: null, avgResponseTime: null };
    scalar = {
      totalRequests: scalar.totalRequests ?? fb.totalRequests,
      totalDownloadSize: scalar.totalDownloadSize ?? fb.totalDownloadSize,
      avgResponseTime: scalar.avgResponseTime ?? fb.avgResponseTime,
    };
  }
  // Sections — find each known heading and extract the table beneath it.
  const sections = await ni.evaluate(
    r.sessionId,
    `(() => {
      const main = document.querySelector('[role="main"], main') || document.body;
      const headings = Array.from(main.querySelectorAll('h2, h3, [role="heading"]'));
      const sectionRe = /Por status do host|Por c[oó]digo de resposta|Por tipo de arquivo|Por tipo de Googlebot|By host status|By response code|By file type|By Googlebot type/i;
      const out = [];
      for (const h of headings) {
        const heading = (h.textContent || '').trim();
        if (!sectionRe.test(heading)) continue;
        const sec = h.closest('section, [role="region"], div') || h.parentElement;
        if (!sec) continue;
        const rows = Array.from(sec.querySelectorAll('[role="row"], tr, [role="listitem"], li')).map(r => {
          const cells = Array.from(r.querySelectorAll('[role="gridcell"], [role="cell"], td, span')).map(c => (c.textContent || '').trim().replace(/\\s+/g, ' '));
          return cells.filter(Boolean);
        }).filter(r => r.length > 0).slice(0, 20);
        out.push({ heading, rows });
      }
      return out;
    })()`,
    r.tabId,
  );
  return text(JSON.stringify({ ...scalar, sections: sections.result || [] }, null, 2));
}

// ── gsc_users ─────────────────────────────────────────────────

export const gscUsersSchema = {
  action: z.enum(['list', 'add', 'remove', 'change_role'] as const),
  email: z.string().optional(),
  role: z.enum(['owner', 'full', 'restricted'] as const).optional(),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscUsersDescription =
  'Manage property users. list returns email + role. add invites a user (mutating). remove revokes (mutating). change_role updates permissions (mutating).';

export async function handleGscUsers(args: { action: string; email?: string; role?: string; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/users');
  if (err) return text(err);

  if (args.action === 'list') {
    // Users page renders mat-list cards; the shared TABLE_EXTRACTOR list-mode
    // fallback handles those, but we also do a structured pass for {name,email,role}
    // to give callers a useful object shape.
    const structured = await ni.evaluate(
      r.sessionId,
      `(() => {
        const items = Array.from(document.querySelectorAll('[role="listitem"], mat-list-item, li, [role="row"], tr'));
        const out = [];
        for (const li of items) {
          // Skip the column-header row (rendered as [role="row"] but with
          // [role="columnheader"] children).
          if (li.querySelector('[role="columnheader"]')) continue;
          const txt = (li.innerText || li.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!txt || txt.length > 300) continue;
          // Skip header-text echoes (PT-BR / EN).
          if (/^\\s*(Name|Nome)\\s+(Email|E-?mail)\\s+(Permission|Permiss[aã]o|Role|Fun[cç][aã]o)\\s*$/i.test(txt)) continue;
          const emailMatch = txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
          const roleMatch = txt.match(/(Owner|Propriet[aá]rio|Full|Total|Restricted|Restrito)/i);
          // A real user row must contain at least an email or a role keyword.
          if (!emailMatch && !roleMatch) continue;
          out.push({
            text: txt,
            email: emailMatch ? emailMatch[0] : null,
            role: roleMatch ? roleMatch[0] : null,
          });
        }
        return out.filter(o => o.text.length > 0);
      })()`,
      r.tabId,
    );
    const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table, [role="list"]'), r.tabId);
    return text(JSON.stringify({ users: structured.result || [], raw: tableRes.result || null }, null, 2));
  }

  if (args.action === 'add') {
    if (!args.email) return text('email required for add.');
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const a = btns.find(b => /add\\s*user|adicionar\\s*usuário/i.test(b.textContent || '')); if (a) a.click(); })()`,
      r.tabId,
    );
    await wait(900);
    await ni.evaluate(
      r.sessionId,
      `(() => { const i = document.querySelector('input[type="email"], input[type="text"]'); if (i) { i.focus(); i.value = ${JSON.stringify(args.email)}; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`,
      r.tabId,
    );
    if (args.role) {
      await wait(300);
      const roleRe = args.role === 'owner' ? /owner|proprietário/i : args.role === 'full' ? /full|total/i : /restricted|restrito/i;
      await ni.evaluate(
        r.sessionId,
        `(() => { const sel = document.querySelector('select, [role="combobox"]'); if (sel) sel.click(); })()`,
        r.tabId,
      );
      await wait(500);
      await ni.evaluate(
        r.sessionId,
        `(() => { const items = Array.from(document.querySelectorAll('[role="option"], option')); const t = items.find(i => ${roleRe.toString()}.test(i.textContent || '')); if (t) t.click(); })()`,
        r.tabId,
      );
    }
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const add = btns.find(b => /^(add|adicionar)$/i.test((b.textContent || '').trim())); if (add) add.click(); })()`,
      r.tabId,
    );
    return text(`Add user requested: ${args.email}${args.role ? ` (${args.role})` : ''}.`);
  }

  if (args.action === 'remove' || args.action === 'change_role') {
    if (!args.email) return text('email required.');
    const click = await ni.evaluate(
      r.sessionId,
      `(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
        const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(args.email)}));
        if (!row) return false;
        const more = row.querySelector('[aria-label*="more" i], button[aria-haspopup]');
        if (more) more.click();
        return true;
      })()`,
      r.tabId,
    );
    if (!click.result) return text(`User not found: ${args.email}`);
    await wait(500);
    if (args.action === 'remove') {
      await ni.evaluate(
        r.sessionId,
        `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"], button')); const d = items.find(i => /remove|excluir|remover/i.test(i.textContent || '')); if (d) d.click(); })()`,
        r.tabId,
      );
      await wait(700);
      await ni.evaluate(
        r.sessionId,
        `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const conf = btns.find(b => /^(remove|excluir|remover)$/i.test((b.textContent || '').trim())); if (conf) conf.click(); })()`,
        r.tabId,
      );
      return text(`Remove user requested: ${args.email}.`);
    }
    if (!args.role) return text('role required for change_role.');
    const roleRe = args.role === 'owner' ? /owner|proprietário/i : args.role === 'full' ? /full|total/i : /restricted|restrito/i;
    await ni.evaluate(
      r.sessionId,
      `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"], button')); const c = items.find(i => /change\\s*role|alterar\\s*função/i.test(i.textContent || '')); if (c) c.click(); })()`,
      r.tabId,
    );
    await wait(700);
    await ni.evaluate(
      r.sessionId,
      `(() => { const items = Array.from(document.querySelectorAll('[role="option"], option, [role="menuitem"]')); const t = items.find(i => ${roleRe.toString()}.test(i.textContent || '')); if (t) t.click(); })()`,
      r.tabId,
    );
    return text(`Change role requested for ${args.email} → ${args.role}.`);
  }

  return text(`Unknown action: ${args.action}`);
}

// ── gsc_associations ──────────────────────────────────────────

export const gscAssociationsSchema = {
  action: z.enum(['list', 'add', 'remove'] as const),
  service: z.enum(['google_analytics', 'merchant_center', 'google_ads', 'play_store', 'youtube', 'actions_on_google', 'chrome_web_store'] as const).optional(),
  identifier: z.string().optional().describe('Service-specific ID (e.g. GA4 measurement ID, Merchant Center account ID).'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscAssociationsDescription =
  'Manage Associations (Analytics / Merchant / Ads / Play / YouTube / Actions / Chrome Web Store). list returns existing associations; add/remove mutate.';

export async function handleGscAssociations(args: { action: string; service?: string; identifier?: string; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/settings/associations');
  if (err) return text(err);
  if (args.action === 'list') {
    const data = await ni.evaluate(
      r.sessionId,
      `(() => {
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        // The Associations page has up to two tables: active associations and
        // pending requests. Use heading text to discriminate.
        const headings = Array.from(document.querySelectorAll('h2, h3, [role="heading"]'));
        const findSection = (re) => {
          const h = headings.find(x => re.test(norm(x.textContent)));
          return h ? (h.closest('section, [role="region"], div') || h.parentElement) : null;
        };
        const activeSec = findSection(/Active|Ativ[ao]s|Associated|Associa[cç][oõ]es associadas/i);
        const pendingSec = findSection(/Pending|Pendente/i);
        const rowsIn = (sec) => {
          if (!sec) return [];
          const trs = Array.from(sec.querySelectorAll('[role="row"], tr, [role="listitem"], mat-list-item, li'));
          return trs.map(tr => {
            const cells = Array.from(tr.querySelectorAll('[role="gridcell"], [role="cell"], td, span'));
            const text = norm(tr.innerText || tr.textContent || '');
            // Skip header-only rows ("Service / Account / URL").
            if (/^(Service|Servi[cç]o)\\s+(Account|Conta)/i.test(text)) return null;
            return cells.length > 0
              ? { service: norm(cells[0]?.textContent), account: norm(cells[1]?.textContent), text }
              : { text };
          }).filter(Boolean).filter(r => r.text && r.text.length > 0 && r.text.length < 300);
        };
        return {
          active: rowsIn(activeSec),
          pending: rowsIn(pendingSec),
        };
      })()`,
      r.tabId,
    );
    return text(JSON.stringify(data.result, null, 2));
  }
  if (args.action === 'add') {
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const a = btns.find(b => /associate|associar|connect|conectar/i.test(b.textContent || '')); if (a) a.click(); })()`,
      r.tabId,
    );
    return text(`Association add flow opened (service=${args.service || 'unspecified'}). Service-specific verification requires user interaction.`);
  }
  if (args.action === 'remove') {
    if (!args.identifier) return text('identifier required for remove.');
    await ni.evaluate(
      r.sessionId,
      `(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"], tr, [role="listitem"], li'));
        const row = rows.find(r => (r.textContent || '').includes(${JSON.stringify(args.identifier)}));
        if (!row) return false;
        const more = row.querySelector('[aria-label*="more" i], button[aria-haspopup], button');
        if (more) more.click();
        return true;
      })()`,
      r.tabId,
    );
    await wait(500);
    await ni.evaluate(
      r.sessionId,
      `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"], button')); const d = items.find(i => /disassociate|disconnect|remover|desassociar/i.test(i.textContent || '')); if (d) d.click(); })()`,
      r.tabId,
    );
    return text(`Remove association requested: ${args.identifier}.`);
  }
  return text(`Unknown action: ${args.action}`);
}

// ── gsc_disavow ───────────────────────────────────────────────

export const gscDisavowSchema = {
  action: z.enum(['download', 'upload', 'delete'] as const),
  filePath: z.string().optional().describe('Absolute path of disavow .txt file (action=upload).'),
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscDisavowDescription =
  '[mutating for upload/delete — affects how Google trusts links to your site] Manage the Disavow Links file. download exports current; upload replaces (use sparingly).';

export async function handleGscDisavow(args: { action: string; filePath?: string; property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, 'https://search.google.com/search-console/disavow-links');
  if (err) return text(err);

  if (args.action === 'download') {
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"], a')); const d = btns.find(b => /download|baixar|export/i.test(b.textContent || '')); if (d) d.click(); })()`,
      r.tabId,
    );
    return text('Disavow file download triggered. File saved to browser default download dir.');
  }

  if (args.action === 'upload') {
    if (!args.filePath) return text('filePath required for upload.');
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const r = btns.find(b => /replace|substituir|upload|carregar/i.test(b.textContent || '')); if (r) r.click(); })()`,
      r.tabId,
    );
    await wait(800);
    const up = await ni.upload(r.sessionId, 'input[type="file"]', [args.filePath], undefined, r.tabId);
    if (up.error) return text(`Upload failed: ${up.error}`);
    await wait(1000);
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const sub = btns.find(b => /^(submit|enviar|done|concluir)$/i.test((b.textContent || '').trim())); if (sub) sub.click(); })()`,
      r.tabId,
    );
    return text(`Disavow file uploaded: ${args.filePath}.`);
  }

  if (args.action === 'delete') {
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const d = btns.find(b => /delete\\s*list|excluir\\s*lista|remove/i.test(b.textContent || '')); if (d) d.click(); })()`,
      r.tabId,
    );
    await wait(700);
    await ni.evaluate(
      r.sessionId,
      `(() => { const btns = Array.from(document.querySelectorAll('button, [role="button"]')); const conf = btns.find(b => /^(delete|excluir|remove)$/i.test((b.textContent || '').trim())); if (conf) conf.click(); })()`,
      r.tabId,
    );
    return text('Disavow list deletion requested.');
  }
  return text(`Unknown action: ${args.action}`);
}

// ── gsc_shopping ──────────────────────────────────────────────

export const gscShoppingSchema = {
  property: z.string().optional(),
  sessionId: z.string().optional(),
  tabId,
};

export const gscShoppingDescription =
  'Read Shopping/Merchant Listings report — counts and per-issue example URLs.';

export async function handleGscShopping(args: { property?: string; sessionId?: string; tabId?: string }) {
  const { err, r } = await loadAndExtract(args.sessionId, args.tabId, args.property, '/r/merchant-listings');
  if (err) return text(err);
  const noData = await ni.evaluate(
    r.sessionId,
    `(() => /Nenhum dado|No data|No merchant listings|Sem listagens|This report isn't available|Este relat[oó]rio n[aã]o est[aá] dispon[ií]vel/i.test(document.body.innerText))()`,
    r.tabId,
  );
  const tableRes = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT('[role="grid"], [role="table"], table'), r.tabId);
  if (!tableRes.result && noData.result) {
    return text(JSON.stringify({ headers: [], rows: [], status: 'no_data' }, null, 2));
  }
  return text(JSON.stringify(tableRes.result || { headers: [], rows: [], status: 'no_data' }, null, 2));
}

// ── gsc_extract_table ─────────────────────────────────────────

export const gscExtractTableSchema = {
  selector: z.string().optional().describe('CSS scope selector (default: [role="grid"]).'),
  sessionId: z.string().optional(),
  tabId,
};

export const gscExtractTableDescription =
  'Generic GSC grid → JSON extractor. Useful when no specific gsc_*_report tool covers a panel.';

export async function handleGscExtractTable(args: { selector?: string; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId, false);
  if ('error' in r) return text(r.error);
  const sel = args.selector || '[role="grid"], [role="table"], table';
  const res = await ni.evaluate(r.sessionId, TABLE_EXTRACTOR_SCRIPT(sel), r.tabId);
  if (res.error) return text(`Extract failed: ${res.error}`);
  return text(JSON.stringify(res.result, null, 2));
}

// ── gsc_screenshot ────────────────────────────────────────────

export const gscScreenshotSchema = {
  sessionId: z.string().optional(),
  tabId,
};

export const gscScreenshotDescription =
  'Capture a full-page screenshot of the active GSC tab. Saved via SynaBun image staging.';

export async function handleGscScreenshot(args: { sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId, false);
  if ('error' in r) return text(r.error);
  const res = await ni.screenshot(r.sessionId, r.tabId);
  if (res.error) return text(`Screenshot failed: ${res.error}`);
  return text('Screenshot captured.');
}
