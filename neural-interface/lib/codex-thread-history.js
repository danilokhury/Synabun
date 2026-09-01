const CODEX_HISTORY_PAGE_TIMEOUT_MS = 15000;
const CODEX_TURN_PAGE_SIZE = 100;
const CODEX_ITEM_PAGE_SIZE = 500;

function codexErrorText(error) {
  if (!error) return '';
  const parts = [
    typeof error === 'string' ? error : error.message,
    typeof error === 'object' && error.data != null
      ? (typeof error.data === 'string' ? error.data : JSON.stringify(error.data))
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}

function historyProtocolError(message) {
  const error = new Error(message);
  error.code = 'CODEX_HISTORY_PROTOCOL_ERROR';
  return error;
}

export function isCodexItemsPaginationUnsupported(error) {
  if (!error) return false;
  if (Number(error.code) === -32601) return true;
  return /(?:method not found|unsupported[- ]method|not supported(?: yet)?|does not support item pagination)/i
    .test(codexErrorText(error));
}

export function isCodexHistoryUnavailableBeforeFirstTurn(error) {
  return /(?:not materialized yet|unavailable before first user message)/i.test(codexErrorText(error));
}

async function paginateCodexHistory(request, method, baseParams, {
  timeoutMs = CODEX_HISTORY_PAGE_TIMEOUT_MS,
} = {}) {
  const data = [];
  const seenCursors = new Set();
  let cursor = null;

  do {
    const params = cursor == null ? baseParams : { ...baseParams, cursor };
    const result = await request(method, params, timeoutMs);
    if (!Array.isArray(result?.data)) {
      throw historyProtocolError(`${method} returned an invalid page`);
    }
    data.push(...result.data);

    const nextCursor = result.nextCursor ?? null;
    if (nextCursor == null) break;
    if (typeof nextCursor !== 'string' || !nextCursor) {
      throw historyProtocolError(`${method} returned an invalid nextCursor`);
    }
    if (seenCursors.has(nextCursor)) {
      throw historyProtocolError(`${method} repeated pagination cursor ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (true);

  return data;
}

async function listCodexTurns(request, threadId, itemsView, options) {
  return paginateCodexHistory(request, 'thread/turns/list', {
    threadId,
    limit: options.turnPageSize ?? CODEX_TURN_PAGE_SIZE,
    sortDirection: 'asc',
    itemsView,
  }, options);
}

async function listCodexItems(request, threadId, options) {
  return paginateCodexHistory(request, 'thread/items/list', {
    threadId,
    limit: options.itemPageSize ?? CODEX_ITEM_PAGE_SIZE,
    sortDirection: 'asc',
  }, options);
}

function mergeCodexItemsIntoTurns(turns, itemEntries) {
  const hydratedTurns = turns.map((turn) => {
    if (!turn || typeof turn !== 'object' || !turn.id) {
      throw historyProtocolError('thread/turns/list returned a turn without an id');
    }
    return { ...turn, items: [], itemsView: 'full' };
  });
  const turnsById = new Map();
  const seenItemIds = new Set();
  for (const turn of hydratedTurns) {
    const turnId = String(turn.id);
    if (turnsById.has(turnId)) {
      throw historyProtocolError(`thread/turns/list returned duplicate turn ${turnId}`);
    }
    turnsById.set(turnId, turn);
  }

  for (const entry of itemEntries) {
    const turnId = entry?.turnId == null ? '' : String(entry.turnId);
    const turn = turnsById.get(turnId);
    const itemId = entry?.item?.id == null ? '' : String(entry.item.id);
    if (!turnId || !turn || !itemId || !entry?.item || typeof entry.item !== 'object') {
      throw historyProtocolError('thread/items/list returned an item without a matching turn');
    }
    if (seenItemIds.has(itemId)) {
      throw historyProtocolError(`thread/items/list returned duplicate item ${itemId}`);
    }
    seenItemIds.add(itemId);
    turn.items.push(entry.item);
  }

  return hydratedTurns;
}

export async function hydrateCodexThreadHistory(request, threadId, options = {}) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  const targetThreadId = String(threadId || '');
  if (!targetThreadId) throw new Error('No thread provided');

  let turns;
  try {
    turns = await listCodexTurns(request, targetThreadId, 'notLoaded', options);
  } catch (error) {
    if (isCodexHistoryUnavailableBeforeFirstTurn(error)) {
      return { turns: [], source: 'unmaterialized' };
    }
    throw error;
  }

  try {
    const items = await listCodexItems(request, targetThreadId, options);
    return {
      turns: mergeCodexItemsIntoTurns(turns, items),
      source: 'items-pagination',
    };
  } catch (error) {
    if (!isCodexItemsPaginationUnsupported(error)) throw error;
    return {
      turns: await listCodexTurns(request, targetThreadId, 'full', options),
      source: 'turns-full-fallback',
    };
  }
}
