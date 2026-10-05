import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function key(accountId, threadId) {
  if (typeof accountId !== 'string' || !accountId || typeof threadId !== 'string' || !threadId) throw error('Plan account and thread are required.');
  return createHash('sha256').update(JSON.stringify([accountId, threadId])).digest('hex');
}

/** Local host-owned storage, with compare-and-swap updates and immutable revision files. */
export function createCodexPlanStore(root) {
  const directory = (accountId, threadId) => join(root, key(accountId, threadId));
  function read(accountId, threadId) {
    try { return JSON.parse(readFileSync(join(directory(accountId, threadId), 'plan.json'), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  function save({ document, expectedRevision = 0, expectedPlanId = null }) {
    if (!document || typeof document.id !== 'string' || !document.id || typeof document.markdown !== 'string'
      || !document.markdown.trim() || document.markdown.length > 2_000_000
      || !Number.isSafeInteger(document.revision) || document.revision < 1
      || !['draft', 'complete'].includes(document.status)) throw error('Invalid plan document.');
    const dir = directory(document.accountId, document.threadId);
    const current = read(document.accountId, document.threadId);
    const old = current?.document;
    const same = old?.id === document.id && old.revision === document.revision && old.markdown === document.markdown;
    if (same && old.approvedRevision === document.approvedRevision) {
      // Reopening an editor always receives the canonical revision, even if a
      // generic file editor or external program previously changed its file.
      let text;
      try { text = readFileSync(current.path, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (text !== document.markdown) {
        const temporary = `${current.path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, document.markdown, 'utf8');
        renameSync(temporary, current.path);
      }
      return current;
    }
    if ((old?.revision || 0) !== expectedRevision || (old?.id || null) !== expectedPlanId) {
      throw error('The saved plan changed in another window. Reopen the current revision before saving.', 409);
    }
    if (old && (old.id !== document.id || document.revision < old.revision || (document.revision === old.revision && !same))) {
      throw error('The plan revision is stale.', 409);
    }
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `revision-${document.revision}.md`);
    // Regenerate this host-owned file if an external editor altered it.
    const temporaryMarkdown = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryMarkdown, document.markdown, 'utf8');
    renameSync(temporaryMarkdown, path);
    const history = old && !same ? [...(current.history || []), old].slice(-20) : (current?.history || []);
    const result = { document, history, path };
    const temporary = join(dir, `${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(result), 'utf8');
    renameSync(temporary, join(dir, 'plan.json'));
    return result;
  }
  return { read, save };
}

export function registerCodexPlanRoutes(app, root) {
  const store = createCodexPlanStore(root);
  app.get('/api/codex/plans', (req, res) => {
    try { res.json({ ok: true, ...store.read(req.query.accountId, req.query.threadId) }); }
    catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message }); }
  });
  app.post('/api/codex/plans', (req, res) => {
    try { res.json({ ok: true, ...store.save(req.body || {}) }); }
    catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message }); }
  });
}
