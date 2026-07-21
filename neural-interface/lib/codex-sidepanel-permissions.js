import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const STORE_VERSION = 1;
export const CODEX_SIDEPANEL_APPROVAL_POLICY = 'on-request';

function emptyStore() {
  return {
    version: STORE_VERSION,
    filesystem: { read: [], write: [] },
  };
}

export function normalizeCodexPermissionPath(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) return '';
  try { return resolve(value.trim()); } catch { return ''; }
}

export function normalizeCodexFilesystemPermissions(permissions) {
  const filesystem = permissions?.fileSystem || permissions?.filesystem || {};
  const normalizeList = (values) => [...new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeCodexPermissionPath)
      .filter(Boolean),
  )];
  return {
    read: normalizeList(filesystem.read),
    write: normalizeList(filesystem.write),
  };
}

export function sanitizeCodexPermissionResponse(requestedPermissions, response) {
  const requested = requestedPermissions && typeof requestedPermissions === 'object'
    ? requestedPermissions
    : {};
  const granted = response?.permissions && typeof response.permissions === 'object'
    ? response.permissions
    : {};
  return {
    permissions: Object.keys(granted).length ? requested : {},
    scope: response?.scope === 'session' ? 'session' : 'turn',
  };
}

function normalizeStore(value) {
  const filesystem = normalizeCodexFilesystemPermissions({
    fileSystem: value?.filesystem || value?.fileSystem || {},
  });
  return {
    version: STORE_VERSION,
    filesystem,
  };
}

export class CodexSidepanelPermissionStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  list() {
    try {
      if (!existsSync(this.filePath)) return emptyStore();
      return normalizeStore(JSON.parse(readFileSync(this.filePath, 'utf-8')));
    } catch {
      return emptyStore();
    }
  }

  grant(permissions) {
    const requested = normalizeCodexFilesystemPermissions(permissions);
    if (!requested.read.length && !requested.write.length) {
      throw new Error('Codex did not request a filesystem folder that can be saved');
    }
    const current = this.list();
    const next = {
      version: STORE_VERSION,
      filesystem: {
        read: [...new Set([...current.filesystem.read, ...requested.read])],
        write: [...new Set([...current.filesystem.write, ...requested.write])],
      },
    };
    this.save(next);
    return { store: next, granted: requested };
  }

  revoke(access, value) {
    if (access !== 'read' && access !== 'write') throw new Error('Unknown filesystem permission type');
    const target = normalizeCodexPermissionPath(value);
    if (!target) throw new Error('A valid absolute folder path is required');
    const next = this.list();
    next.filesystem[access] = next.filesystem[access].filter((entry) => entry !== target);
    this.save(next);
    return next;
  }

  save(value) {
    const next = normalizeStore(value);
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    renameSync(tmp, this.filePath);
  }
}
