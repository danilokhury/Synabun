import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the shared db layer at a throwaway file BEFORE importing it — getDb()
// resolves SQLITE_DB_PATH on first call and caches the handle for the process.
// node --test gives each test file its own child process, so this is file-local.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'synabun-xbudget-'));
process.env.SQLITE_DB_PATH = join(TMP_DIR, 'memory.db');

const {
  getDb, closeDb,
  getXActionBudget, getXEngagementTier,
  getRecentXEngagements,
  X_ACTION_TYPES, X_ENGAGEMENT_TIERS, X_DEFAULT_TIER,
} = await import('../lib/db.js');

const db = getDb();
let seq = 0;

// Every X lane writes one memory per action, tagged with the account, the target and
// the action type. That tag shape is the whole contract this module reads.
function seedEngagement({ action, handle = 'someone', status = null, acct = 'crit_pix', ago = 0, extraTags = [] }) {
  const id = `m${++seq}`;
  const when = new Date(Date.now() - ago).toISOString();
  const tags = [
    'critpix', 'twitter', 'x-engaged',
    `acct:${acct}`,
    `handle:${handle}`,
    ...(status ? [`status:${status}`] : []),
    ...(action ? [`action:${action}`] : []),
    ...extraTags,
  ];
  db.prepare(
    `INSERT INTO memories (id, vector, content, category, project, tags, created_at, updated_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, new Uint8Array(4), `${action} -> @${handle}`, 'social-interactions', 'criticalpixel', JSON.stringify(tags), when, when, when);
  return id;
}

function seedCaps(content, { ago = 0, acct = null } = {}) {
  const id = `caps${++seq}`;
  const when = new Date(Date.now() - ago).toISOString();
  const tags = ['critpix', 'twitter', 'critpix-x-engagement-caps', ...(acct ? [`acct:${acct}`] : [])];
  db.prepare(
    `INSERT INTO memories (id, vector, content, category, project, tags, created_at, updated_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, new Uint8Array(4), content, 'social-interactions', 'criticalpixel', JSON.stringify(tags), when, when, when);
  return id;
}

function reset() {
  db.exec('DELETE FROM memories');
}

test.after(() => {
  closeDb();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── getXActionBudget ──

test('counts one action per ledger memory, bucketed by type', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'a' });
  seedEngagement({ action: 'reply', handle: 'b' });
  seedEngagement({ action: 'like', handle: 'c' });
  seedEngagement({ action: 'like', handle: 'd' });
  seedEngagement({ action: 'like', handle: 'e' });
  seedEngagement({ action: 'follow', handle: 'f' });

  const spent = getXActionBudget({ account: 'Crit_Pix', sinceIso: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(spent.reply, 2);
  assert.equal(spent.like, 3);
  assert.equal(spent.follow, 1);
  assert.equal(spent.quote, 0);
  assert.equal(spent.repost, 0);
  assert.equal(spent.total, 6);
  assert.equal(spent.error, undefined);
});

test('a leading @ and mixed case on the account still match the acct: tag', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'a' });
  for (const account of ['crit_pix', 'Crit_Pix', '@Crit_Pix', '  @CRIT_PIX  ']) {
    const spent = getXActionBudget({ account, sinceIso: new Date(Date.now() - 3600_000).toISOString() });
    assert.equal(spent.reply, 1, `account "${account}" should resolve to the same ledger`);
  }
});

test('the ledger is account-scoped — another handle does not spend our budget', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'a', acct: 'crit_pix' });
  seedEngagement({ action: 'reply', handle: 'b', acct: 'synabunai' });
  seedEngagement({ action: 'reply', handle: 'c', acct: 'synabunai' });

  const since = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(getXActionBudget({ account: 'Crit_Pix', sinceIso: since }).reply, 1);
  assert.equal(getXActionBudget({ account: 'SynabunAI', sinceIso: since }).reply, 2);
  // No account given = every lane on the box, which is the cross-account total.
  assert.equal(getXActionBudget({ sinceIso: since }).reply, 3);
});

test('REGRESSION: yesterday\'s actions do not eat today\'s budget', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'old1', ago: 26 * 3600_000 });
  seedEngagement({ action: 'reply', handle: 'old2', ago: 30 * 3600_000 });
  seedEngagement({ action: 'reply', handle: 'today' });

  // The launcher passes the start of the LOCAL day, not a rolling 24h window —
  // a rolling window would carry last night's replies into the morning run and
  // silently halve the day's quota.
  const startOfDay = new Date(Date.now() - 8 * 3600_000).toISOString();
  assert.equal(getXActionBudget({ account: 'crit_pix', sinceIso: startOfDay }).reply, 1);
});

test('a blocked-by-them memory is an outcome, not an action we spent', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'a' });
  seedEngagement({ action: 'blocked', handle: 'hostile' });

  const spent = getXActionBudget({ account: 'crit_pix', sinceIso: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(spent.total, 1, 'action:blocked must not be counted as a spent action');
  assert.equal(spent.reply, 1);
});

test('adding action: tags does not corrupt the existing skip-list contract', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'engaged_one', status: '111' });
  seedEngagement({ action: 'quote', handle: 'engaged_two', status: '222' });
  seedEngagement({ action: 'blocked', handle: 'hostile' });

  // getRecentXEngagements predates this module; "action:reply" must not be picked
  // up by its `tags LIKE '%action:blocked%'` blocklist probe.
  const { handles, statusIds, blocked } = getRecentXEngagements({ account: 'crit_pix', days: 7 });
  assert.deepEqual(handles.sort(), ['engaged_one', 'engaged_two']);
  assert.deepEqual(statusIds.sort(), ['111', '222']);
  assert.deepEqual(blocked, ['hostile']);
});

test('an unknown or missing action tag is ignored rather than miscounted', () => {
  reset();
  seedEngagement({ action: 'bookmark', handle: 'a' });   // not a budgeted type
  seedEngagement({ action: null, handle: 'b' });          // legacy row, no action tag
  seedEngagement({ action: 'reply', handle: 'c' });

  const spent = getXActionBudget({ account: 'crit_pix', sinceIso: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(spent.total, 1);
  assert.equal(spent.reply, 1);
});

test('a row is charged once even when it carries a second action tag', () => {
  reset();
  seedEngagement({ action: 'reply', handle: 'a', extraTags: ['action:like'] });

  const spent = getXActionBudget({ account: 'crit_pix', sinceIso: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(spent.total, 1, 'one ledger memory is one action');
});

test('trashed ledger rows stop counting', () => {
  reset();
  const id = seedEngagement({ action: 'reply', handle: 'a' });
  seedEngagement({ action: 'reply', handle: 'b' });
  db.prepare('UPDATE memories SET trashed_at = ? WHERE id = ?').run(new Date().toISOString(), id);

  const spent = getXActionBudget({ account: 'crit_pix', sinceIso: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(spent.reply, 1);
});

test('every budgeted action type is present on a zero result', () => {
  reset();
  const spent = getXActionBudget({ account: 'crit_pix', sinceIso: new Date().toISOString() });
  for (const t of X_ACTION_TYPES) assert.equal(spent[t], 0, `${t} must be present and zero`);
  assert.equal(spent.total, 0);
});

// ── getXEngagementTier ──

test('reads the tier from the canonical caps memory', () => {
  reset();
  seedCaps('critpix-x-engagement-caps\ntier: 2\ntierSince: 2026-09-04\ncleanDayCount: 7');
  const { tier, caps, source } = getXEngagementTier({ account: 'crit_pix' });
  assert.equal(tier, 2);
  assert.equal(source, 'memory');
  assert.deepEqual(caps, X_ENGAGEMENT_TIERS[2]);
});

test('the newest caps memory wins', () => {
  reset();
  seedCaps('tier: 1', { ago: 3 * 86400_000 });
  seedCaps('tier: 3', { ago: 86400_000 });
  seedCaps('tier: 2');
  assert.equal(getXEngagementTier({ account: 'crit_pix' }).tier, 2);
});

test('caps ceilings widen monotonically with the tier', () => {
  for (const t of X_ACTION_TYPES) {
    assert.ok(X_ENGAGEMENT_TIERS[1][t] <= X_ENGAGEMENT_TIERS[2][t], `tier 2 must not narrow ${t}`);
    assert.ok(X_ENGAGEMENT_TIERS[2][t] <= X_ENGAGEMENT_TIERS[3][t], `tier 3 must not narrow ${t}`);
  }
  // Tier 1 is the post-shadow-ban restart: no quoting until the account proves clean.
  assert.equal(X_ENGAGEMENT_TIERS[1].quote, 0);
});

test('an unreadable ledger narrows the budget instead of widening it', () => {
  reset();
  // No caps memory at all.
  const missing = getXEngagementTier({ account: 'crit_pix' });
  assert.equal(missing.tier, X_DEFAULT_TIER);
  assert.equal(missing.source, 'default');
  assert.deepEqual(missing.caps, X_ENGAGEMENT_TIERS[X_DEFAULT_TIER]);

  // Present but unparseable, and present but naming a tier that does not exist.
  for (const content of ['engagement caps: see the weekly review', 'tier: 9', 'tier: banana']) {
    reset();
    seedCaps(content);
    const got = getXEngagementTier({ account: 'crit_pix' });
    assert.equal(got.tier, X_DEFAULT_TIER, `"${content}" must fall back to the conservative tier`);
    assert.equal(got.source, 'default');
  }
});

test('an account-scoped caps memory beats none, and unscoped caps still apply', () => {
  reset();
  seedCaps('tier: 3', { acct: 'crit_pix' });
  assert.equal(getXEngagementTier({ account: 'crit_pix' }).tier, 3);

  reset();
  seedCaps('tier: 3', { acct: 'synabunai' });
  assert.equal(
    getXEngagementTier({ account: 'crit_pix' }).tier,
    X_DEFAULT_TIER,
    'another account\'s caps must not raise our ceiling',
  );
});

// ── failure containment ──

test('a broken database never throws and never invents budget headroom', () => {
  closeDb();
  // Force the next getDb() to fail by pointing at a path that cannot be opened.
  const original = process.env.SQLITE_DB_PATH;
  process.env.SQLITE_DB_PATH = join(TMP_DIR, 'no-such-dir', 'nested', 'memory.db');

  const spent = getXActionBudget({ account: 'crit_pix', sinceIso: new Date().toISOString() });
  for (const t of X_ACTION_TYPES) assert.equal(spent[t], 0);
  assert.equal(spent.total, 0);

  const tierResult = getXEngagementTier({ account: 'crit_pix' });
  assert.equal(tierResult.tier, X_DEFAULT_TIER);
  assert.deepEqual(tierResult.caps, X_ENGAGEMENT_TIERS[X_DEFAULT_TIER]);

  process.env.SQLITE_DB_PATH = original;
  closeDb();
});
