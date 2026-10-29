// The Neural Interface offers only the 3D memory map. The 2D implementation is deprecated, kept on disk.
import { KEYS } from './constants.js';

export function resolveViewVariant(_requested) { return '3d'; }

/** Preserve other URL state, including memory anchors, when retiring a 2D address. Shared with the server. */
export function normalizeViewUrl(input) {
  const url = new URL(input, 'http://localhost');
  if (url.pathname.toLowerCase() === '/index2d.html') url.pathname = '/';
  if (url.searchParams.has('variant')) url.searchParams.set('variant', resolveViewVariant(url.searchParams.get('variant')));
  const hash = url.hash.slice(1);
  if (hash === '2d') url.hash = '3d';
  else {
    const start = hash.includes('?') ? hash.indexOf('?') + 1 : 0;
    const params = new URLSearchParams(hash.slice(start));
    if (params.has('variant')) {
      params.set('variant', resolveViewVariant(params.get('variant')));
      url.hash = hash.slice(0, start) + params.toString();
    }
  }
  return url.pathname + url.search + url.hash;
}

/** Optional legacy config fields are normalized without changing Focus Mode, glass or accent settings. */
export function normalizeViewConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const next = { ...config };
  for (const key of ['variant', 'viewVariant']) {
    if (Object.hasOwn(next, key)) next[key] = resolveViewVariant(next[key]);
  }
  return next;
}

/** Retain archived 2D coordinates, but never reinterpret their x/y positions as 3D positions. */
export function normalizeWorkspaceVariant(workspace) {
  if (workspace?.variant !== '2d') return workspace;
  return {
    ...workspace,
    variant: '3d',
    nodePositions2d: workspace.nodePositions2d || workspace.nodePositions || {},
    nodePositions3d: workspace.nodePositions3d || {},
  };
}

/** Rewrite persisted preferences at boot, in both the hydrated server store and any browser-local copy. */
export function migrateViewPreferences(...stores) {
  for (const store of new Set(stores.filter(Boolean))) {
    // A refused read/write or malformed old value must not stop the supported view from booting.
    try {
      if (store.getItem(KEYS.VIEW_VARIANT) !== '3d') store.setItem(KEYS.VIEW_VARIANT, '3d');
    } catch {}
    for (const [key, normalize] of [
      [KEYS.INTERFACE_CONFIG, normalizeViewConfig],
      [KEYS.WORKSPACES, (list) => Array.isArray(list) ? list.map(normalizeWorkspaceVariant) : list],
    ]) {
      try {
        const raw = store.getItem(key);
        if (!raw) continue;
        const value = JSON.parse(raw);
        const next = normalize(value);
        if (JSON.stringify(next) !== JSON.stringify(value)) store.setItem(key, JSON.stringify(next));
      } catch {}
    }
  }
  return resolveViewVariant();
}
