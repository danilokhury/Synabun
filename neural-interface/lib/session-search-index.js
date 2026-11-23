// FTS5 does not index equality on an UNINDEXED column. The original session_chunks
// triggers deleted by id, scanning the entire text corpus inside every writer's
// transaction. This optional B-tree indexes only FTS rowids and ids. It owns no
// transcripts. Install the three equivalent journal/FTS triggers atomically, then
// fill the lookup in small committed pages, on the indexing worker only.
const FINISHED = '9223372036854775807';

function indexTrigger(action, original) {
  const alias = action === 'delete' ? 'old' : 'new';
  const name = 'session_chunks_' + action;
  const header = `CREATE TRIGGER ${name} AFTER ${action.toUpperCase()} ON session_chunks BEGIN`;
  const journal = `INSERT INTO memory_changes(entity,id) VALUES('session_chunks',${alias}.id);`;
  const insert = action === 'delete' ? '' : 'INSERT INTO chunk_search(id,content,summary,project,files) VALUES(new.id,new.content,new.summary,new.project,new.files_modified);';
  const compact = sql => sql?.replace(/\s+/g, ' ').trim();
  if (compact(original) !== compact(`${header} ${journal} DELETE FROM chunk_search WHERE id=${alias}.id; ${insert} END`)) return null;
  return `DROP TRIGGER ${name}; ${header}
    ${journal}
    DELETE FROM chunk_search WHERE rowid IN (SELECT docid FROM chunk_search_lookup WHERE id=${alias}.id) AND id=${alias}.id;
    DELETE FROM chunk_search_lookup WHERE id=${alias}.id;
    DELETE FROM chunk_search WHERE rowid > (SELECT cursor FROM chunk_search_lookup_progress) AND id=${alias}.id;
    ${insert}
    ${insert ? 'INSERT INTO chunk_search_lookup(docid,id) VALUES(last_insert_rowid(),new.id);' : ''}
    END;`;
}

function install(db) {
  const installed = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='chunk_search_lookup_progress'");
  if (installed.get()) return true;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!installed.get()) {
      // Never replace an unknown trigger (e.g. a newer schema). This is a
      // derived index only. The original triggers remain valid without it.
      const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?");
      const replacements = ['insert', 'update', 'delete'].map(action =>
        indexTrigger(action, sql.get('session_chunks_' + action)?.sql));
      if (replacements.includes(null)) {
        db.exec('ROLLBACK');
        return false;
      }
      db.exec(`CREATE TABLE chunk_search_lookup(docid INTEGER PRIMARY KEY,id TEXT NOT NULL);
        CREATE INDEX chunk_search_lookup_id ON chunk_search_lookup(id);
        CREATE TABLE chunk_search_lookup_progress(cursor INTEGER NOT NULL);
        INSERT INTO chunk_search_lookup_progress VALUES(0);`);
      db.exec(replacements.join('\n'));
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function warmChunkSearchLookup(db) {
  if (!install(db)) return;
  const cursor = db.prepare('SELECT CAST(cursor AS TEXT) AS pos FROM chunk_search_lookup_progress');
  const page = db.prepare('SELECT CAST(rowid AS TEXT) AS docid,id FROM chunk_search WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid LIMIT 128');
  // Read the potentially cold FTS pages BEFORE taking the write lock. A trigger
  // can change a row between the two phases, so copy its current id by rowid.
  const put = db.prepare('INSERT OR REPLACE INTO chunk_search_lookup SELECT rowid,id FROM chunk_search WHERE rowid > ? AND rowid <= ?');
  const advance = db.prepare('UPDATE chunk_search_lookup_progress SET cursor=? WHERE cursor=?');
  let slice = performance.now();
  for (;;) {
    const { pos } = cursor.get();
    if (pos === FINISHED) return;
    const rows = page.all(pos);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Other workers may advance the same index. Its cursor only moves forward.
      if (cursor.get().pos === pos) {
        if (rows.length) put.run(pos, rows.at(-1).docid);
        advance.run(rows.length < 128 ? FINISHED : rows.at(-1).docid, pos);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (performance.now() - slice >= 8) {
      await new Promise(done => setTimeout(done, 3));
      slice = performance.now();
    }
  }
}
