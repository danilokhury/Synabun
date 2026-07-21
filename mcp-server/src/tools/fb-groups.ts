import { z } from 'zod';
import { text } from './response.js';
import {
  getMemory, scrollMemories,
  importFbData, markFbGroup, selectFbWorklist, setFbAllowsPromo, setFbGroupFields, selectFbGroups, fbStats,
  recategorizeFbGroups,
} from '../services/sqlite.js';
import type { FbGroupUpsert, FbPostLogEntry } from '../services/sqlite.js';
import {
  normUrl, classifyGroupName, cleanName, regionForSeed, resolveClassification, REGION_BY_CURRENCY, COUNTRY_BY_CURRENCY,
} from '../services/fb-regions.js';

// ── fb_groups — structured Facebook group directory + per-group posting checklist ──
//
// Single source of truth for a managed Facebook group collection. Uses two SQLite
// tables: fb_groups (one row per group) and fb_post_log (one row per posting event).
// worklist provides an ordered region fetch and resume engine; mark records outcomes.
// Subcategories scanned (prose) when import is run with no explicit memory ids.
const DEFAULT_IMPORT_SUBCATEGORIES: Array<{ sub: string; source: string; forceExclude: boolean }> = [
  { sub: 'facebook-groups-targets', source: 'targets', forceExclude: false },
  { sub: 'facebook-groups-excluded', source: 'excluded', forceExclude: true },
  { sub: 'facebook-posting', source: 'run-log', forceExclude: false },
];

export const fbGroupsSchema = {
  action: z
    .enum(['worklist', 'mark', 'set', 'import', 'exclude', 'list', 'stats', 'recategorize'] as const)
    .describe('worklist: ordered groups still to post to (region/currency + offerSlug). mark: tick one group after posting. set: curate classification (region/lang/currency) for one or many groups. import: (re)build the directory from memories + a live extract. exclude: forbid promo in a group. list/stats: coverage. recategorize: re-derive region/lang/currency for every group and backfill allows_promo from history.'),
  region: z.string().optional().describe('UK | US | EU | Brazil | LatAm | Turkey | Australia | Canada | Unknown (case-insensitive). Alternative to currency for worklist/list/stats. LatAm = Spanish-speaking Latin America (posts the USD link).'),
  currency: z.string().optional().describe('GBP | USD | EUR | BRL | TRY | AUD | CAD. Preferred worklist filter (authoritative seed-queue currency). USD covers both US and LatAm — add lang:"es" to target LatAm groups specifically.'),
  offerSlug: z.string().optional().describe('Offer/campaign slug, e.g. "spring-sale". Required for worklist and mark.'),
  url: z.string().optional().describe('Group URL (normalized internally). Required for mark and exclude.'),
  status: z.string().optional().describe('mark status: posted/visible-post, pending/pending-approval (cooldown 48h, counts as success), failed/posting-failed, or skipped. Synonyms accepted.'),
  postUrl: z.string().optional().describe('mark: the resulting post URL, if known.'),
  note: z.string().optional().describe('mark: short note (e.g. skip reason or failure detail).'),
  sessionId: z.string().optional().describe('mark: loop/session id for provenance.'),
  reason: z.string().optional().describe('exclude: why promo is forbidden (group rules).'),
  lang: z.string().optional().describe('language code (pt/en/de/fr/es/tr/pl/it/nl). set: classify a group. worklist: narrow a currency bucket to one language (e.g. EUR + de for German-copy groups).'),
  country: z.string().optional().describe('descriptive country label. set: classify a group. worklist: narrow to one country.'),
  name: z.string().optional().describe('set: group display name.'),
  member_count: z.number().optional().describe('set: approximate member count.'),
  allows_promo: z.enum(['true', 'false', 'unknown'] as const).optional().describe('set: promo permission.'),
  groups: z.array(z.object({
    url: z.string(),
    region: z.string().optional(),
    lang: z.string().optional(),
    currency: z.string().optional(),
    country: z.string().optional(),
    name: z.string().optional(),
    member_count: z.number().optional(),
    allows_promo: z.enum(['true', 'false', 'unknown'] as const).optional(),
    note: z.string().optional(),
  })).optional().describe('set (bulk): array of group classifications to write in one call.'),
  limit: z.number().optional().describe('worklist max groups (default 20).'),
  includePending: z.boolean().optional().describe('worklist: include pending-approval / cooldown groups (default false).'),
  freshDays: z.number().optional().describe('worklist: skip groups already posted this offer within N days (default 14).'),
  reset: z.boolean().optional().describe('worklist: ignore prior posts for this offer (re-seed the whole region from scratch).'),
  cooldownHours: z.number().optional().describe('mark: hours a pending-approval group is held out of the worklist (default 48).'),
  fromMemoryIds: z.array(z.string()).optional().describe('import: specific memory ids to parse. Omit to scan the facebook-groups-* subcategories.'),
  fromExtract: z.any().optional().describe('import: a browser_extract_fb_groups JSON payload (object or JSON string) — the authority for currently-joined groups + region buckets.'),
};

export const fbGroupsDescription =
  'Structured Facebook group directory + per-group posting checklist (SQLite-backed; the single source of truth that replaces the free-text seed-queue). ' +
  'Actions: ' +
  'worklist {currency|region, offerSlug, limit?, freshDays?=14, includePending?=false, reset?} — returns the groups STILL to post to for this offer: joined, promo not forbidden, region/currency match, not pending/cooldown, not already posted for this offer within freshDays; never-posted first, then least-recently-posted, then largest. Re-call it to RESUME (it returns only what is left); a new offerSlug (or reset:true) starts FRESH. ' +
  'mark {url, offerSlug, currency, status, postUrl?, note?} — record ONE group right after posting (durable checklist; call after EACH group, never batch). status posted=visible-post, pending=pending-approval (success; engages a 48h cooldown so the worklist skips it), failed=posting-failed, skipped. ' +
  'import {fromMemoryIds?, fromExtract?} — (re)build the directory from the surviving memories and/or a live browser_extract_fb_groups payload (idempotent). ' +
  'set {url | groups:[…]} with region/lang/currency/country/name/member_count/allows_promo — curation: authoritatively classify one or many groups (currency must be a SUPPORTED deal currency: USD/GBP/EUR/BRL/TRY/CAD/AUD). ' +
  'exclude {url, reason} — mark a group promo-forbidden (permanently dropped from worklists). ' +
  'list/stats {region?} — coverage counts by region, pending/cooldown, last-posted per offer. ' +
  'recategorize {} — one-shot cleanup: re-derive region/lang/currency/country for every group from name + post history and backfill allows_promo from confirmed visible posts (idempotent). ' +
  'Region buckets: UK, US, EU, Brazil, LatAm, Turkey, Australia, Canada, Unknown.';

// ── parsing helpers (migration) ───────────────────────────────────────

function parseMemberCount(s?: string | null): number | null {
  if (!s) return null;
  const m = String(s).match(/([\d.,]+)\s*([kKmM])?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1e3;
  else if (suf === 'm') n *= 1e6;
  return Math.round(n);
}

const GROUP_URL_RE = /https?:\/\/(?:www\.)?facebook\.com\/groups\/[^\s|)\]>,"']+/gi;

// Pipe-delimited lines: seed-queue ("url | lang | currency | lastOffer | date") and the
// surviving ledger ("url | offerSlug | date"). Disambiguated per line by column shape.
function parsePipe(content: string): { groups: FbGroupUpsert[]; logs: FbPostLogEntry[] } {
  const groups: FbGroupUpsert[] = [];
  const logs: FbPostLogEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line.includes('|') || !/\/groups\//.test(line)) continue;
    const parts = line.split('|').map((p) => p.trim());
    const url = normUrl(parts[0].replace(/^[-*\d.\s]+/, ''));
    if (!/^https?:\/\//.test(url)) continue;
    const c1 = parts[1] || '';
    const c2 = parts[2] || '';
    if (/^\d{4}-\d{2}-\d{2}/.test(c2)) {
      // ledger: url | offerSlug | date
      logs.push({ group_url: url, offer_slug: c1 || 'unknown', status: 'visible-post', posted_at: c2.slice(0, 10) + 'T12:00:00Z', note: 'ledger-import' });
      groups.push({ url, joined: 1, source: 'run-log' });
    } else if (/^[A-Za-z]{2,3}$/.test(c1) && /^[A-Za-z]{3}$/.test(c2)) {
      // seed-queue: url | lang | currency [| lastOffer | date]
      const lang = c1.toLowerCase();
      const currency = c2.toUpperCase();
      groups.push({ url, lang, currency, region: regionForSeed(lang, currency), country: COUNTRY_BY_CURRENCY[currency], source: 'seed-queue' });
      const c3 = parts[3] || '';
      const c4 = parts[4] || '';
      if (c3 && /^\d{4}-\d{2}-\d{2}/.test(c4)) {
        logs.push({ group_url: url, offer_slug: c3, currency, status: 'visible-post', posted_at: c4.slice(0, 10) + 'T12:00:00Z', note: 'seed-queue-import' });
      }
    } else {
      groups.push({ url, joined: 1, source: 'seed-queue' });
    }
  }
  return { groups, logs };
}

// Prose memories (targets / excluded / run-logs): scrape group URLs and line-local metadata.
function parseProse(content: string, source: string, forceExclude: boolean): FbGroupUpsert[] {
  const out: FbGroupUpsert[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!/facebook\.com\/groups\//i.test(line)) continue;
    if (line.includes('|') && /\/groups\//.test(line)) continue; // pipe line — handled by parsePipe
    const urls = line.match(GROUP_URL_RE);
    if (!urls) continue;
    const memberM = line.match(/([\d.,]+\s*[kKmM]?)\s*members/i) || line.match(/members?\s*[:=]?\s*([\d.,]+\s*[kKmM]?)/i);
    const member_count = memberM ? parseMemberCount(memberM[1]) : null;
    const promoM = line.match(/promo(?:tion)?s?\s*(?:allowed)?\s*[:=-]*\s*(yes|no|sim|n[ãa]o)/i);
    let allows_promo: 'true' | 'false' | 'unknown' = forceExclude ? 'false' : 'unknown';
    if (!forceExclude && promoM) allows_promo = /^(yes|sim)$/i.test(promoM[1]) ? 'true' : 'false';
    const ccyM = line.match(/\b(GBP|USD|EUR|BRL|TRY|AUD|CAD)\b/);
    const currency = ccyM ? ccyM[1].toUpperCase() : null;
    for (const rawUrl of urls) {
      const url = normUrl(rawUrl);
      const slug = url.match(/\/groups\/([^/]+)/)?.[1] || '';
      // Only take a name from clean structured prose (targets/excluded). Run-log memories are
      // narrative ("Also posted X to <url>"), so a scraped name is a junk sentence fragment —
      // leave it blank and let the live browser_extract_fb_groups backfill the real name.
      let name: string | undefined;
      if (source !== 'run-log') {
        const cand = cleanName(line.slice(0, line.indexOf(rawUrl)));
        if (cand && cand.length <= 60 && !/^(also|posted|submitted|attempted|shared|tried|posting|created|seeded|successfully|failed|on|this|the|iteration|reflect|remember)\b/i.test(cand)) {
          name = cand;
        }
      }
      let region: string;
      let lang: string | null = null;
      let cur: string | null = currency;
      if (currency) {
        region = REGION_BY_CURRENCY[currency] || 'Unknown';
      } else {
        const c = classifyGroupName(name || '', slug);
        region = c.region; lang = c.lang; cur = c.currency;
      }
      out.push({
        url, name, region, lang: lang || undefined, currency: cur || undefined,
        country: cur ? COUNTRY_BY_CURRENCY[cur] : undefined,
        member_count, allows_promo, joined: 1, source,
      });
    }
  }
  return out;
}

// ── action handlers ───────────────────────────────────────────────────

function normStatus(s?: string): 'visible-post' | 'pending-approval' | 'posting-failed' | 'skipped' {
  const t = (s || '').toLowerCase().trim();
  if (['visible-post', 'posted', 'post', 'success', 'done', 'ok', 'sent'].includes(t)) return 'visible-post';
  if (['pending-approval', 'pending', 'approval', 'awaiting', 'queued', 'pending-approval.'].includes(t)) return 'pending-approval';
  if (['posting-failed', 'failed', 'fail', 'error'].includes(t)) return 'posting-failed';
  return 'skipped';
}

async function handleImport(args: { fromMemoryIds?: string[]; fromExtract?: unknown }) {
  const groups: FbGroupUpsert[] = [];
  const logs: FbPostLogEntry[] = [];

  const pushMemory = (content: string, source: string, forceExclude: boolean) => {
    const pipe = parsePipe(content);
    groups.push(...pipe.groups);
    logs.push(...pipe.logs);
    groups.push(...parseProse(content, source, forceExclude));
  };

  if (args.fromMemoryIds?.length) {
    for (const id of args.fromMemoryIds) {
      const m = await getMemory(id);
      if (!m?.payload?.content) continue;
      const sub = (m.payload.subcategory || '').toLowerCase();
      const forceExclude = sub.includes('excluded');
      const source = forceExclude ? 'excluded' : sub.includes('seed') ? 'seed-queue' : sub.includes('target') ? 'targets' : 'import';
      pushMemory(m.payload.content, source, forceExclude);
    }
  } else {
    for (const { sub, source, forceExclude } of DEFAULT_IMPORT_SUBCATEGORIES) {
      const res = await scrollMemories({ must: [{ key: 'subcategory', match: { value: sub } }] }, 50);
      for (const p of res.points) {
        if (p.payload?.content) pushMemory(p.payload.content, source, forceExclude);
      }
    }
  }

  if (args.fromExtract) {
    let ext: any = args.fromExtract;
    if (typeof ext === 'string') {
      try { ext = JSON.parse(ext); } catch { ext = null; }
    }
    if (ext && typeof ext === 'object') {
      const buckets = ext.byRegion ? Object.values(ext.byRegion as Record<string, any[]>).flat() : [];
      const all = [...buckets, ...((ext.unmatched as any[]) || [])];
      for (const g of all) {
        if (!g?.url) continue;
        // resolveClassification treats a stale 'Unknown' region as no-signal (the old
        // `g.region || …` kept currency-bearing groups stuck on Unknown) and applies the
        // full name/lang/currency precedence incl. the LatAm/Spain split.
        const r = resolveClassification({
          name: g.name || '', url: g.url,
          region: g.region || null, lang: g.lang || null, currency: g.currency || null,
        });
        groups.push({
          url: normUrl(g.url), name: g.name ? cleanName(g.name) : undefined,
          region: r.region, lang: r.lang || undefined, currency: r.currency || undefined,
          country: r.country || undefined,
          member_count: parseMemberCount(g.subtitle), joined: 1, source: 'live-extract',
        });
      }
    }
  }

  const res = importFbData(groups, logs);
  const stats = fbStats();
  return text(JSON.stringify({
    imported: res,
    sources: args.fromMemoryIds?.length ? 'explicit-ids' : 'default-seed+subcategories',
    usedExtract: !!args.fromExtract,
    directory: stats,
  }, null, 2));
}

export async function handleFbGroups(args: {
  action: string;
  region?: string;
  currency?: string;
  offerSlug?: string;
  url?: string;
  status?: string;
  postUrl?: string;
  note?: string;
  sessionId?: string;
  reason?: string;
  lang?: string;
  country?: string;
  name?: string;
  member_count?: number;
  allows_promo?: 'true' | 'false' | 'unknown';
  groups?: Array<{ url?: string; region?: string; lang?: string; currency?: string; country?: string; name?: string; member_count?: number; allows_promo?: 'true' | 'false' | 'unknown'; note?: string }>;
  limit?: number;
  includePending?: boolean;
  freshDays?: number;
  reset?: boolean;
  cooldownHours?: number;
  fromMemoryIds?: string[];
  fromExtract?: unknown;
}) {
  switch (args.action) {
    case 'worklist': {
      if (!args.offerSlug?.trim()) return text('Error: worklist requires offerSlug (the campaign slug, e.g. "spring-sale").');
      const items = selectFbWorklist({
        region: args.region || null,
        currency: args.currency || null,
        lang: args.lang || null,
        country: args.country || null,
        offerSlug: args.offerSlug.trim(),
        limit: args.limit,
        includePending: args.includePending,
        freshDays: args.freshDays,
        reset: args.reset,
      });
      return text(JSON.stringify({
        offerSlug: args.offerSlug.trim(),
        currency: args.currency || null,
        region: args.region || null,
        count: items.length,
        groups: items,
        note: items.length === 0
          ? 'No groups left for this offer in this region (all done/pending/cooldown). Try another currency, includePending:true to inspect walls, or reset:true to re-seed.'
          : undefined,
      }));
    }

    case 'mark': {
      if (!args.url?.trim()) return text('Error: mark requires url.');
      if (!args.offerSlug?.trim()) return text('Error: mark requires offerSlug.');
      const status = normStatus(args.status);
      const r = markFbGroup({
        url: normUrl(args.url.trim()),
        offerSlug: args.offerSlug.trim(),
        currency: args.currency ? args.currency.toUpperCase() : null,
        status,
        postUrl: args.postUrl || null,
        note: args.note || null,
        sessionId: args.sessionId || null,
        cooldownHours: args.cooldownHours,
      });
      return text(`Marked ${r.url} → ${status} for "${args.offerSlug.trim()}".` +
        (r.cooldown_until ? ` Cooldown until ${r.cooldown_until} (worklist will skip it).` : '') +
        (status === 'visible-post' ? ' Pending/cooldown cleared.' : ''));
    }

    case 'set': {
      const applyOne = (g: { url?: string; region?: string; lang?: string; currency?: string; country?: string; name?: string; member_count?: number; allows_promo?: 'true' | 'false' | 'unknown'; note?: string }): boolean => {
        if (!g.url) return false;
        setFbGroupFields(normUrl(g.url), {
          region: g.region,
          lang: g.lang ? g.lang.toLowerCase() : undefined,
          currency: g.currency ? g.currency.toUpperCase() : undefined,
          country: g.country,
          name: g.name !== undefined ? cleanName(g.name) : undefined,
          member_count: g.member_count,
          allows_promo: g.allows_promo,
          notes: g.note,
        });
        return true;
      };
      let n = 0;
      if (Array.isArray(args.groups) && args.groups.length) {
        for (const g of args.groups) if (applyOne(g)) n++;
      } else if (args.url) {
        applyOne({ url: args.url, region: args.region, lang: args.lang, currency: args.currency, country: args.country, name: args.name, member_count: args.member_count, allows_promo: args.allows_promo, note: args.note });
        n = 1;
      } else {
        return text('Error: set requires url (single) or groups[] (bulk).');
      }
      return text(`Set ${n} group(s). Coverage: ` + JSON.stringify(fbStats().byRegion));
    }

    case 'import':
      return handleImport(args);

    case 'exclude': {
      if (!args.url?.trim()) return text('Error: exclude requires url.');
      setFbAllowsPromo(normUrl(args.url.trim()), 'false', args.reason);
      return text(`Excluded ${normUrl(args.url.trim())} from seeding (allows_promo=false).${args.reason ? ' Reason: ' + args.reason : ''}`);
    }

    case 'list': {
      const rows = selectFbGroups(args.region);
      return text(JSON.stringify({ region: args.region || 'all', count: rows.length, groups: rows }));
    }

    case 'stats':
      return text(JSON.stringify(fbStats(args.region), null, 2));

    case 'recategorize': {
      const r = recategorizeFbGroups();
      return text(JSON.stringify({
        action: 'recategorize',
        ...r,
        note: 'Re-derived region/lang/currency/country for all groups (incl. LatAm/Spain split) and backfilled allows_promo from confirmed visible posts. Idempotent.',
      }, null, 2));
    }

    default:
      return text(`Unknown action "${args.action}". Use: worklist, mark, set, import, exclude, list, stats, recategorize.`);
  }
}
