// Authoritative card binding comes from app-server history, never view params.
export function findCodexAppCard(thread, originCallId) {
  for (const turn of thread?.turns || []) {
    const item = turn.items?.find(item => item?.id === originCallId && item.type === 'mcpToolCall');
    const uri = item?.mcpAppUi?.resourceUri || item?.mcpAppResourceUri;
    if (item && typeof item.server === 'string' && typeof uri === 'string' && uri.startsWith('ui://')) return { server: item.server, uri };
  }
  throw Object.assign(new Error('Embedded app card was not found in this thread.'), { code: -32602 });
}

// One instance per sidepanel connection, retained with its orphan transport.
export function createCodexAppBoundary({ now = Date.now, interval = 10000, connectionLimit = 30, cardLimit = 10 } = {}) {
  let thread = null, generation = 0, hits = [];
  const cards = new Map(), bindings = new Map();
  const invalidate = () => { generation++; bindings.clear(); };
  return {
    invalidate,
    setThread(id) { if (thread !== id) { thread = id; invalidate(); } },
    consume(threadId, callId) {
      const time = now();
      hits = hits.filter(hit => time - hit < interval);
      for (const [key, times] of cards) {
        const fresh = times.filter(hit => time - hit < interval);
        if (fresh.length) cards.set(key, fresh); else cards.delete(key);
      }
      const key = JSON.stringify([threadId, callId]);
      const cardHits = cards.get(key) || [];
      if (hits.length >= connectionLimit || cardHits.length >= cardLimit) {
        throw Object.assign(new Error('Embedded app bridge rate limit reached.'), { code: -32000 });
      }
      hits.push(time); cardHits.push(time); cards.set(key, cardHits);
    },
    async resolve(threadId, callId, read) {
      this.setThread(threadId);
      const ticket = generation, key = JSON.stringify([threadId, callId]);
      if (!bindings.has(key)) {
        if (bindings.size >= 128) bindings.delete(bindings.keys().next().value);
        const binding = Promise.resolve().then(read).then(history => Object.freeze(findCodexAppCard(history?.thread, callId)));
        bindings.set(key, binding);
        binding.catch(() => { if (bindings.get(key) === binding) bindings.delete(key); });
      }
      const binding = await bindings.get(key);
      if (ticket !== generation) throw Object.assign(new Error('App card binding changed.'), { code: -32602 });
      return binding;
    },
  };
}
