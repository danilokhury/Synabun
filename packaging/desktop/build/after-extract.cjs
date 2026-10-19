// electron-builder's afterExtract hook (packaging/lib/desktop.mjs builderConfig).
//
// The window is made from the pinned Electron archive (pins.json electron),
// handed to electron-builder as a custom electronDist. electron-builder then
// keeps the archive exactly as it is, where for its own download it removes
// Electron's demo app (default_app.asar) and the version file. They are
// removed here the same way, right after the archive is unpacked and before
// anything is copied in or signed.

const { readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

async function afterExtract(context) {
  const out = context.appOutDir;
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
    for (const name of readdirSync(out).filter((entry) => entry.endsWith('.app'))) {
      rmSync(join(out, name, 'Contents', 'Resources', 'default_app.asar'), { force: true });
    }
    return;
  }
  rmSync(join(out, 'resources', 'default_app.asar'), { force: true });
  rmSync(join(out, 'version'), { force: true });
}

module.exports = afterExtract;
module.exports.default = afterExtract;
