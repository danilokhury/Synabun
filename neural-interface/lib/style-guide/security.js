import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const inside = (child, root) => {
  const rel = relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Resolve existing ancestors too: a missing leaf under an escaping symlink is still outside.
function physicalPath(path) {
  try { return realpathSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A dangling symlink must fail closed rather than be treated as a missing file.
    try { if (lstatSync(path).isSymbolicLink()) throw error; } catch (statError) {
      if (statError.code !== 'ENOENT') throw statError;
      if (statError === error) throw error;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physicalPath(parent), relative(parent, path));
  }
}

/** Physical containment, with optional refusal of all links below the root for writes/assets. */
export function containedPath(root, target, { noSymlinks = false } = {}) {
  root = resolve(root);
  target = resolve(target);
  if (!inside(target, root)) return false;
  try {
    if (!inside(physicalPath(target), physicalPath(root))) return false;
    if (noSymlinks) {
      let at = target;
      while (at !== root) {
        try { if (lstatSync(at).isSymbolicLink()) return false; } catch (error) { if (error.code !== 'ENOENT') return false; }
        at = dirname(at);
      }
    }
    return true;
  } catch { return false; }
}

export const LOGO_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,115}\.(?:svg|png|jpg|jpeg|webp)$/i;
export const safeLogoFile = (file) => typeof file === 'string' && LOGO_FILE_RE.test(file) && !file.includes('..');
