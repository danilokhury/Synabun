import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the shared db layer at a throwaway file BEFORE importing it — getDb()
// resolves SQLITE_DB_PATH on first call and caches the handle for the process.
// node --test gives each test file its own child process, so this is file-local.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'synabun-fbbudget-'));
process.env.SQLITE_DB_PATH = join(TMP_DIR, 'memory.db');

const {
  getDb, closeDb,
  getFbActionBudget, getFbEngagementTier,
  getXActionBudget,
  FB_ACTION_TYPES, FB_ENGAGEMENT_TIERS, FB_DEFAULT_TIER,
} = await import('../lib/db.js');

const db = getDb();
let seq = 0;

// The MCP server owns this table; a fresh Neural Interface database may not have it.
// The budget must read 0 without it (covered below) and count it when present.
const FB_POST_LOG_DDL = `CREATE TABLE IF NOT EXISTS fb_post_log (
  id TEXT PRIMARY KEY, group_url TEXT NOT NULL, offer_slug TEXT NOT NULL, currency TEXT,
  status TEXT NOT NULL, post_url TEXT, session_id TEXT, posted_at TEXT NOT NULL, note TEXT)`;

// Every Facebook lane writes one memory per Page-identity action, tagged "fb-action"
// + "action:<type>" (+ optional "count:<n>" for invite batches). That tag shape is
// the whole contract this module reads for page_post / comment / invite / join.
function seedAction({ action, acct = 'acme-games', ago = 0, extraTags = [] }) {
  const id = `m${++seq}`;
  const when = new Date(Date.now() - ago).toISOString();
  const tags = [
    'facebook', 'acme', 'fb-action',
    ...(acct ? [`acct:${acct}`] : []),
    ...(action ? [`action:${action}`] : []),
    ...extraTags,
  ];
  db.prepare(
    `INSERT INTO memories (id, vector, content, category, project, tags, created_at, updated_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, new Uint8Array(4), `${action} on facebook`, 'social-interactions', 'acme-games', JSON.stringify(tags), when, when, when);
  return id;
}

function seedGroupPost({ status, ago = 0, group = 'https://www.facebook.com/groups/x/', offer = 'some-game' }) {
  db.exec(FB_POST_LOG_DDL);
  const id = `p${++seq}`;
  const when = new Date(Date.now() - ago).toISOString();
  db.prepare(
    `INSERT INTO fb_post_log (id, group_url, offer_slug, currency, status, post_url, session_id, posted_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, group + id, offer, 'USD', status, null, null, when, null);
  return id;
}

function seedCaps(content, { ago = 0 } = {}) {
  const id = `caps${++seq}`;
  const when = new Date(Date.now() - ago).toISOString();
  const tags = ['facebook', 'acme', 'critpix-fb-engagement-caps'];
  db.prepare(
    `INSERT INTO memories (id, vector, content, category, project, tags, created_at, updated_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, new Uint8Array(4), content, 'social-interactions', 'acme-games', JSON.stringify(tags), when, when, when);
  return id;
}

function reset() {
  db.exec('DELETE FROM memories');
  try { db.exec('DELETE FROM fb_post_log'); } catch { /* table not created yet */ }
}

const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();

test.after(() => {
  closeDb();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── getFbActionBudget ──

test('page_post / comment / invite / join are counted from fb-action memories, one per row', () => {
  reset();
  seedAction({ action: 'page_post' });
  seedAction({ action: 'page_post' });
  seedAction({ action: 'comment' });
  seedAction({ action: 'comment' });
  seedAction({ action: 'comment' });
  seedAction({ action: 'join' });

  const spent = getFbActionBudget({ sinceIso: hourAgo() });
  assert.equal(spent.page_post, 2);
  assert.equal(spent.comment, 3);
  assert.equal(spent.join, 1);
  assert.equal(spent.invite, 0);
  assert.equal(spent.group_post, 0, 'no ledger table yet must read 0, not throw');
  assert.equal(spent.total, 6);
  assert.equal(spent.error, undefined);
});

test('an invite batch memory charges its count: tag instead of 1', () => {
  reset();
  seedAction({ action: 'invite', extraTags: ['count:7'] });
  seedAction({ action: 'invite' });                          // legacy single invite
  seedAction({ action: 'invite', extraTags: ['count:0'] });  // nonsense count -> 1
  seedAction({ action: 'invite', extraTags: ['count:abc'] });

  const spent = getFbActionBudget({ sinceIso: hourAgo() });
  assert.equal(spent.invite, 10);
  assert.equal(spent.total, 10);
});

test('group_post comes from the fb_groups ledger: visible + pending count, skipped + failed do not', () => {
  reset();
  seedGroupPost({ status: 'visible-post' });
  seedGroupPost({ status: 'pending-approval' });
  seedGroupPost({ status: 'posted' });   // un-normalised synonym still a submission
  seedGroupPost({ status: 'skipped' });
  seedGroupPost({ status: 'posting-failed' });
  seedGroupPost({ status: 'visible-post', ago: 30 * 3600_000 }); // yesterday

  const spent = getFbActionBudget({ sinceIso: hourAgo() });
  assert.equal(spent.group_post, 3);
  assert.equal(spent.total, 3);
});

test('REGRESSION: yesterday\'s actions do not eat today\'s budget', () => {
  reset();
  seedAction({ action: 'page_post', ago: 26 * 3600_000 });
  seedAction({ action: 'comment', ago: 30 * 3600_000 });
  seedAction({ action: 'page_post' });

  // The launcher passes the start of the LOCAL day, not a rolling 24h window.
  const startOfDay = new Date(Date.now() - 8 * 3600_000).toISOString();
  const spent = getFbActionBudget({ sinceIso: startOfDay });
  assert.equal(spent.page_post, 1);
  assert.equal(spent.comment, 0);
});

test('a blocked outcome, an unknown action and a legacy row without action tag are not charged', () => {
  reset();
  seedAction({ action: 'blocked' });
  seedAction({ action: 'like' });     // not a budgeted Facebook type
  seedAction({ action: null });
  seedAction({ action: 'comment' });

  const spent = getFbActionBudget({ sinceIso: hourAgo() });
  assert.equal(spent.total, 1);
  assert.equal(spent.comment, 1);
});

test('a row is charged once even when it carries a second action tag', () => {
  reset();
  seedAction({ action: 'comment', extraTags: ['action:invite'] });
  const spent = getFbActionBudget({ sinceIso: hourAgo() });
  assert.equal(spent.total, 1, 'one ledger memory is one action');
  assert.equal(spent.comment, 1);
});

test('trashed ledger rows stop counting', () => {
  reset();
  const id = seedAction({ action: 'comment' });
  seedAction({ action: 'comment' });
  db.prepare('UPDATE memories SET trashed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  assert.equal(getFbActionBudget({ sinceIso: hourAgo() }).comment, 1);
});

test('the Facebook ledger and the X ledger do not leak into each other', () => {
  reset();
  seedAction({ action: 'comment' });
  // An X reply tagged the X way must not be charged to Facebook, and vice versa.
  const when = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, vector, content, category, project, tags, created_at, updated_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('x1', new Uint8Array(4), 'reply', 'social-interactions', 'acme-games',
    JSON.stringify(['acme', 'twitter', 'x-engaged', 'acct:acme_games', 'action:reply']), when, when, when);

  assert.equal(getFbActionBudget({ sinceIso: hourAgo() }).total, 1);
  assert.equal(getXActionBudget({ account: 'acme_games', sinceIso: hourAgo() }).total, 1);
  assert.equal(getXActionBudget({ account: 'acme_games', sinceIso: hourAgo() }).reply, 1);
});

test('every budgeted action type is present on a zero result', () => {
  reset();
  const spent = getFbActionBudget({ sinceIso: new Date().toISOString() });
  for (const t of FB_ACTION_TYPES) assert.equal(spent[t], 0, `${t} must be present and zero`);
  assert.equal(spent.total, 0);
});

// ── getFbEngagementTier ──

test('reads the tier from the canonical caps memory', () => {
  reset();
  seedCaps('critpix-fb-engagement-caps\ntier: 2\ntierSince: 2026-09-15\ncleanDayCount: 7');
  const { tier, caps, source } = getFbEngagementTier();
  assert.equal(tier, 2);
  assert.equal(source, 'memory');
  assert.deepEqual(caps, FB_ENGAGEMENT_TIERS[2]);
});

test('the newest caps memory wins', () => {
  reset();
  seedCaps('tier: 1', { ago: 3 * 86400_000 });
  seedCaps('tier: 3', { ago: 86400_000 });
  seedCaps('tier: 2');
  assert.equal(getFbEngagementTier().tier, 2);
});

test('caps ceilings widen monotonically with the tier and page_post never exceeds 4', () => {
  for (const t of FB_ACTION_TYPES) {
    assert.ok(FB_ENGAGEMENT_TIERS[1][t] <= FB_ENGAGEMENT_TIERS[2][t], `tier 2 must not narrow ${t}`);
    assert.ok(FB_ENGAGEMENT_TIERS[2][t] <= FB_ENGAGEMENT_TIERS[3][t], `tier 3 must not narrow ${t}`);
  }
  // The Page cadence that replaced the 20-hour cap: never back to burst posting.
  for (const tier of Object.keys(FB_ENGAGEMENT_TIERS)) assert.ok(FB_ENGAGEMENT_TIERS[tier].page_post <= 4);
  assert.equal(FB_DEFAULT_TIER, 1);
});

test('an unreadable ledger narrows the budget instead of widening it', () => {
  reset();
  const missing = getFbEngagementTier();
  assert.equal(missing.tier, FB_DEFAULT_TIER);
  assert.equal(missing.source, 'default');
  assert.deepEqual(missing.caps, FB_ENGAGEMENT_TIERS[FB_DEFAULT_TIER]);

  for (const content of ['caps: see the weekly review', 'tier: 9', 'tier: banana']) {
    reset();
    seedCaps(content);
    const got = getFbEngagementTier();
    assert.equal(got.tier, FB_DEFAULT_TIER, `"${content}" must fall back to the conservative tier`);
    assert.equal(got.source, 'default');
  }
});

test('the X caps memory does not select the Facebook tier', () => {
  reset();
  const when = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, vector, content, category, project, tags, created_at, updated_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('xcaps', new Uint8Array(4), 'tier: 3', 'social-interactions', 'acme-games',
    JSON.stringify(['acme', 'twitter', 'acme-x-engagement-caps']), when, when, when);
  assert.equal(getFbEngagementTier().tier, FB_DEFAULT_TIER);
});

// ── failure containment ──

test('a broken database never throws and never invents budget headroom', () => {
  reset();
  closeDb();
  // A regular FILE where the db directory should be: the parent exists (so the env
  // path is honoured, not replaced by the default) but nothing can be opened inside it.
  const original = process.env.SQLITE_DB_PATH;
  const blocker = join(TMP_DIR, 'blocker');
  writeFileSync(blocker, 'not a directory');
  process.env.SQLITE_DB_PATH = join(blocker, 'memory.db');

  const spent = getFbActionBudget({ sinceIso: new Date().toISOString() });
  for (const t of FB_ACTION_TYPES) assert.equal(spent[t], 0);
  assert.equal(spent.total, 0);

  const tierResult = getFbEngagementTier();
  assert.equal(tierResult.tier, FB_DEFAULT_TIER);
  assert.deepEqual(tierResult.caps, FB_ENGAGEMENT_TIERS[FB_DEFAULT_TIER]);

  process.env.SQLITE_DB_PATH = original;
  closeDb();
});
