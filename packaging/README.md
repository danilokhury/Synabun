# Building SynaBun applications

`packaging/` turns this repository into the SynaBun desktop app: SynaBun's own
window (Electron) around the existing server and interface, a Node runtime of
its own, the dependencies for one platform, [cloudflared](#cloudflared) for the
public address, on Windows [Git for Windows](#git-for-windows) for the Git Bash
Claude Code needs there, and a small native executable for everything that runs
without a window (MCP, hooks, diagnostics). Installed copies update themselves from
GitHub Releases ([Updates](#updates); `docs/desktop-app.md` is the user side).
It is a development tool. Nothing in this folder is published to npm, and an
npm or Git install keeps working, and updating, exactly as before.

The app opens its own window. It never opens a browser or a browser-installed
PWA, and the PWA install offers are hidden inside it.

## Targets

| Target | Command | Built on | Artifacts | State |
|---|---|---|---|---|
| `macos-arm64` | `npm run build:mac:arm` | macOS on Apple Silicon | `.dmg` + `.zip` | builds |
| `macos-x64` | `npm run build:mac:intel` | macOS on Intel, or Apple Silicon with Rosetta 2 | `.dmg` + `.zip` | builds |
| `linux-x64` | `npm run build:linux:x64` | Linux x64 with glibc; macOS or Linux with `--cross` | `.AppImage` | builds |
| `windows-x64` | `npm run build:windows:x64` | Windows x64; macOS or Linux with `--cross` | per-user NSIS `-setup.exe` | builds |
| `windows-x86` | `npm run build:windows:x86` | nowhere | none | **not supported**, see below |

Every build also writes the blockmaps and its part of the update feed
(`latest-mac.yml`, `latest.yml`, `latest-linux.yml`) and `SHA256SUMS`; see
[Update feed](#update-feed).

`npm run build:targets` prints this for the machine it runs on, with the reason
a target cannot be built there. Add `-- --cross` to see what it can cross-build.

### Native builds

A target is built on its own operating system. The build downloads that
target's Node, uses it to install the dependencies (so npm picks that
platform's packages), compiles what has no prebuilt binary, and then runs the
result once before packaging it. `macos-x64` on Apple Silicon counts as native:
Rosetta 2 runs the x64 Node for real.

Without `--cross` a machine only builds what it can also run, and refuses the
rest with exit code 2.

### Cross builds

`linux-x64` and `windows-x64` can also be built on macOS or on Linux:

```
npm run build:linux:x64 -- --cross
npm run build:windows:x64 -- --cross
```

A cross build cannot run what it makes, so each thing a native build learns by
running is replaced by a check:

- **Node.** The target's Node is identified by its file header. The pinned Node
  of the build machine, checked against the same `pins.json`, runs npm.
- **Dependencies.** npm is told the target's `os`, `cpu` and `libc`. Afterwards
  every per-platform package on disk is compared with the lockfiles: the
  target's have to be there, and one for any other system stops the build.
- **Compiling.** `zig` builds the native entry for the target and, for Linux,
  `node-pty` from its own source against the headers in the target's Node
  archive. What those two files ask of a Linux system is read back from them:
  only glibc, nothing newer than glibc 2.28 (what Node 22 itself needs), and
  only functions the bundled Node exports.
- **Windows commands.** npm links package commands as symbolic links on macOS
  and Linux. They are rewritten as the `.cmd` and `.ps1` files npm writes on
  Windows, with npm's own `cmd-shim`.
- **Embedding model.** Each file is downloaded from the model's repository and
  checked against its pin, instead of being fetched by the application's
  installer (which loads the target's embedding runtime).
- **AppImage.** Made the way electron-builder makes one, from its own
  AppImage toolset (pinned in `pins.json` `tools.appimage-tools`): its
  `mksquashfs` for the build machine, the type 2 runtime (the same file as the
  pinned `tools.appimage-runtime`, checked against that pin too) and the
  libraries every Electron AppImage carries. The native entry is the image's
  `AppRun`. The image is read back: the runtime's mark, the file system behind
  it, the number of files in it, and the blockmap embedded at its end.
- **Windows installer.** electron-builder's NSIS, which runs on macOS and Linux
  too, with `installer.nsh` from `desktop/build/` (see
  [How the desktop app runs](#how-the-desktop-app-runs)). The window
  executable's icon and version are set with resedit; no Wine is needed.
- **Smoke run.** Not possible. The build report says `not run`, and the build
  has to be started on the target before it is relied on.

NSIS installers are 32-bit programs whatever they install; what this one
installs is 64-bit.

### 32-bit Windows

SynaBun for Windows is 64-bit only. That was decided on 2026-10-08, and
`windows-x86` is refused whatever its dependencies publish. The target and its
command remain so that asking for it explains why.

`windows-x86` would be a real 32-bit application (`ia32`), not a 32-bit
installer around the 64-bit one. These dependencies are not published for
32-bit Windows:

- `onnxruntime-node`: local embeddings (Windows x64 and arm64 only)
- `playwright-core`: the managed browser (64-bit browsers only)

`node-pty` has no 32-bit prebuilt binary either; compiling it with the 32-bit
MSVC tools has not been verified. Node itself does ship for 32-bit Windows.

The list is read from the lockfiles on every run, so it stays accurate. It does
not lift the refusal: supporting 32-bit Windows would be a new decision, made in
`lib/targets.mjs`.

## Commands

```
node packaging/build.mjs targets [--json] [--verbose] [--cross]
node packaging/build.mjs preflight --target <id> [--cross]
node packaging/build.mjs build --target <id> [options]
node packaging/build.mjs feed [--out <dir>]
node packaging/build.mjs release-plan [--out <dir>] [--tag <tag>] [--installed <version>] [--json]
```

| Option | Meaning |
|---|---|
| `--cross` | build `linux-x64` or `windows-x64` on macOS or Linux; checked, never run |
| `--out <dir>` | where artifacts go (default `build/out`) |
| `--work <dir>` | staging folder, emptied first (default `build/stage`) |
| `--cache <dir>` | downloads, the npm cache and the desktop tools, kept between builds (default `build/cache`) |
| `--artifact <kinds>` | from the target's list, comma separated (default: all of them) |
| `--release-notes <file>` | the text the apps show as the release's notes (CI passes the release's description) |
| `--version <x.y.z>` | test builds only: the version written into the staged application; the source `package.json` is never changed. This is how an "X+1" for an update test is made |
| `--no-embedding-model` | leave the local embedding model out |
| `--update-model-pins` | record the downloaded model's checksums in `pins.json` |
| `--no-tool-downloads` | never download a packaging tool, even a pinned one |
| `--skip-smoke` | do not run the finished bundle (it is still audited) |
| `--keep-work` | keep the staging folder |
| `--no-fallback` | accepted for older command lines; there is no fallback artifact any more |

`feed` merges the feed parts (`*.feed.json`) of every build in a folder into
the three feed files and `SHA256SUMS`: what CI runs once it has collected the
four builds. `release-plan` is a release of that folder as a dry run (see
[Updates](#updates)): exit `0` when everything agrees, `1` when it does not.

Exit codes: `0` done, `1` failed, `2` this machine cannot build that target,
`3` a dependency has no build for that target, `4` tools are missing, `64` bad
command line. A refused build stops before anything is downloaded, staged or
removed.

## What a build does

1. **Preflight.** Host, tools and lockfiles. Stops here when the target cannot work.
2. **Node.** Downloads the pinned Node for the target and checks its SHA-256
   against `pins.json`. Then runs it: a machine that cannot run it cannot build it.
3. **Application.** `npm pack`: exactly the files the npm package publishes
   (`files` in `package.json`), checked again for anything private. Nothing is
   copied from the checkout's `node_modules` or from a data folder. The build
   report records the source version and whether the checkout had changes.
4. **Dependencies.** `npm ci` from the lockfiles, by the target's own npm, in the
   staging folder, with lifecycle scripts off and an empty npm configuration.
   The MCP server is compiled from source there; its build tools are then pruned.
   The lockfiles name none of the [external tools](#external-tools), so none is
   downloaded; one that came anyway is removed here and named in the build report.
5. **Native modules.** `node-pty` is compiled where it has no prebuilt binary
   (Linux), so the terminal works. Binaries for other platforms are removed.
   Execute permissions are restored on the bundled executables and `bin` scripts.
6. **Embedding model.** The public `Xenova/all-MiniLM-L6-v2` files are fetched by
   the application's own installer and checked against their pins.
7. **cloudflared, and on Windows Git for Windows.** Cloudflare's release file
   for the target is downloaded and checked against the application's own pins,
   the binary is taken out of it and checked against its own, and placed with its
   execute bit. See [cloudflared](#cloudflared). A Windows target also gets Git
   for Windows' release file, checked against its pin, unpacked by the
   application's own reader and checked file by file. See
   [Git for Windows](#git-for-windows).
8. **Payload.** Runtime (with Node.js's own npm and npx: on macOS and Linux `bin/npm` and `bin/npx` are
   wrappers that run them with the Node beside them whatever PATH says, on Windows Node's `npm.cmd`, `npx.cmd`,
   `.ps1` and sh shims beside `node.exe`; npm's builtin `npmrc` sends `npm i -g` to
   `~/.synabun/runtime/npm-global`, `%APPDATA%\synabun\runtime\npm-global` on Windows, never into the app:
   `lib/packaged-runtime.js` `bundledNpmrc`), application, cloudflared, Git for Windows (Windows), bootstrap, the manifest
   (`synabun-package.json`, with `shell: { kind: 'electron' }`), `synabun-shell`
   (where the window executable is, for the native entry) and `app-update.yml`;
   the native entry is compiled from `launcher/launcher.c`.
9. **Window.** The desktop tools (`desktop/package.json` and its lockfile:
   electron-builder, pinned) are installed into `build/cache/desktop-tools/`,
   never globally and never into the source tree. The window's own code
   (`desktop/src`) and its two runtime packages (`electron-updater`, `js-yaml`)
   are staged, and electron-builder makes the app from the pinned Electron
   archive (`pins.json` `electron`, checked by SHA-256), with the payload as
   extra resources beside the window's `app.asar`, never inside it: the server
   keeps running on SynaBun's own Node, so no native module is rebuilt for
   Electron. Electron's fuses are set (no `ELECTRON_RUN_AS_NODE`, no
   `NODE_OPTIONS`, no inspector arguments, app code only from the asar). An
   unsigned macOS app is signed ad hoc, which Apple Silicon needs to run it.
10. **Audit.** Required files (the window, `app.asar`, `synabun-shell`,
    `app-update.yml`), the processor of every native binary, execute
    permissions, no private file, and no external tool: not its package, not its
    command, not its executable, not an entry in a lockfile of the bundle. And
    the one program that has to be there: the pinned cloudflared of the target,
    in its one place, and no other cloudflared anywhere. A Windows bundle carries
    the pinned Git for Windows tree too, file for file; no other bundle carries
    one. npm and npx (`verify.mjs` `auditBundledNpm`): npm's files, the shims or
    wrappers that start them, and its builtin `npmrc`; where this machine runs
    the target's Node (every build but a cross build), `npm --version` and
    `npx --version` must answer npm's version with that runtime alone (no Node
    on PATH, a throwaway home and cache). A cross build checks the files.
11. **Smoke run.** In a throwaway home, on a port nothing uses, with none of the
    external tools in reach: the version, a real pseudo-terminal, the embedding
    runtime, the application finding its own cloudflared and asking it for its
    version, an MCP conversation over stdio, the bundled Git Bash and git
    starting (Windows), and the window executable handing a command line to the
    entry (`SynaBun version`). Running must not change a file of the bundle.
12. **Artifacts.** macOS: a disk image (`.dmg`, with an Applications link) and
    the zip the updater installs, each with a blockmap. Windows: the per-user
    installer and its blockmap: electron-builder's assisted installer, whose
    install page lists every step (`desktop/build/installer.nsh`, with this
    build's facts in `synabun-installer-facts.nsh`), and whose unpacking shows
    its progress (`desktop/build/synabun-extract.nsh`, electron-builder's own
    macro with `Nsis7z::ExtractWithDetails`: the build refuses to make the
    installer when electron-builder's macro is not that one). Linux: the
    AppImage, its blockmap embedded.
    Then this build's part of the feed (`<artifact>.feed.json`), the feed files
    for what is in `--out`, `SHA256SUMS`, and a `build-report.json`.

A cross build does the same twelve steps with the replacements listed under
[Cross builds](#cross-builds); step 11 is recorded as not run.

## How the desktop app runs

```
SynaBun.app · SynaBun.exe · synabun-desktop   the window (Electron)
synabun-cli · synabun-cli.exe · the AppImage   the native entry, no window:
  <entry>                 open the window (the app's own start)
  <entry> mcp             the MCP server on stdio, for an AI tool
  <entry> claude-hook …   a Claude Code hook handler
  <entry> app-backend     start or reuse the window's server (JSON lines; the window runs it)
  <entry> start           run the server in this terminal
  <entry> diagnostics     what this build is (--json, --natives)
  <entry> version | doctor | profile | migrate-data | restore-backup
```

The entry is `SynaBun.app/Contents/MacOS/synabun-cli`, `synabun-cli.exe` next
to `SynaBun.exe`, or the AppImage file itself (its `AppRun`). Started with
nothing to do it opens the window; anything else it runs headless with the
bundled Node, never a shell and never a Node from `PATH`. What it starts gets the
caller's `PATH` first, then the bin folder of npm's global prefix (as npm settles
it: `lib/child-path.js`), then the bundled runtime last: the entry appends the
runtime, and the bootstrap, the hook handler and `mcp-server/run.mjs` put npm's
global bin before it (`lib/packaged-runtime.js` `packagedChildEnv`).

- **Start.** The window shows a status page (SynaBun's own loading screen, with
  the launcher's steps as they are reported) and runs `<entry> app-backend
  --json --prefer-port <last port>`. That reuses a server of this install that
  already runs, replaces one of this install from before an update, and
  otherwise starts the server through the Start Server launcher and its
  supervisor (`lib/desktop-app.js`, `lib/start-launcher.js`). When the server
  answers completely, the window loads it. A server of another SynaBun install
  on the same data home, or one too old to say which data home it uses (every
  server from before 2026-10-17), is never stopped or adopted: the window says
  where it runs. Another program on the port moves this one to the next free port, and
  the window says so. Failures show the reason, **Try again** and **Open logs**.
- **Close and Quit.** Closing the window leaves SynaBun running: the Dock icon
  on macOS, a tray icon on Windows and Linux (**Open SynaBun**, **Check for
  updates**, **Quit SynaBun**). Quit (the menu, the tray, ⌘Q, or **Apps → Quit
  SynaBun** in the interface, which is Stop Server elsewhere) stops the server
  the app started and ends the app. **Restart Server** goes through the
  supervisor, as in every install. One app per data home: opening it again
  shows the window that is there.
- **The window.** Context isolation, the sandbox, no Node integration. The
  preload gives the app's own server pages one small object,
  `window.synabunDesktop` (version, system, the updater, Quit); nothing else
  gets it. Navigation stays on the server's origin; a link elsewhere opens in
  the default browser; the server's own pop-ups open as app windows. The
  window remembers its size and place, and macOS gets the usual Edit menu.
- **Where its files are.** The window's profile is
  `<data home>/runtime/desktop` and its log `<data home>/data/desktop.log`,
  beside `launcher.log`, `server-stdout.log` and `server-stderr.log`.
  **Open logs** shows them.
- **Data** stays where it always was (`~/.synabun`, `%APPDATA%\synabun`, or
  `SYNABUN_DATA_HOME`). Installing, updating and uninstalling never touch it,
  and running never writes inside the application.
- **MCP.** Clients are registered with `<entry> mcp`. Nothing but MCP messages
  goes to stdout. The copy-and-paste snippets in Settings and in the setup
  wizard show the same command. A registration made by an earlier build names
  `SynaBun.app/Contents/MacOS/SynaBun` (the entry's old name, now the window):
  the window hands such a command line to the entry, so it keeps working.
- **Claude Code hooks** are registered as `"<entry>" claude-hook <script>`
  (`lib/claude-hooks.js`). The entry runs the handler with the bundled Node and
  prints nothing of its own, so the person needs no Node and the IDE needs
  nothing on its `PATH`. No `SYNABUN_HOOK_ROOT` is written. Handlers left by an
  npm install, or by a copy of the application that has since moved, are
  replaced on the next start.
- **`synabun://` links** use the existing handler registration, written on
  first start, pointing at `<entry> launcher`. The Windows installer writes the
  same value at install time and removes it on uninstall when it still points
  at that copy.
- **Windows.** The installer is per user (`%LOCALAPPDATA%\Programs\SynaBun`, no
  administrator), unsigned unless credentials are given. It is electron-builder's
  assisted installer with no page before the install (`oneClick: false`,
  `customInstallMode` forces the current user, no folder to choose): its install
  page shows its list of steps from the start (`customHeader`: `ShowInstDetails
  show`, `ShowUninstDetails show`), each with the seconds since the start
  (`SynaPhase`), and the whole list is written to
  `%TEMP%\SynaBun-install-<timestamp>.log`, named and openable on the finish
  page (`SynaOpenLog` / `SynaOpenLogFile`). Its finish page also opens SynaBun. A
  silent run (the app's own update: `--updated /S /D=<dir>`) shows nothing and
  asks nothing. An install over an existing one keeps that one's folder
  (electron-builder reads it from the registry): the one-click test builds before
  2026-10-18 used `%LOCALAPPDATA%\Programs\synabun-desktop`. Installing over a
  running copy closes it and its server first (`installer.nsh`
  `customCheckAppRunning` → `SynaStopProc` → `desktop/build/synabun-stop.ps1`,
  embedded in the installer): it asks each SynaBun server to shut down gracefully
  (`POST /api/server/shutdown` on the loopback port it finds by the owning
  process, so SQLite and the children close cleanly and `setup.js`'s supervisor
  exits), then force-closes whatever is left in whole trees (`taskkill /T /F`) in
  a respawn-proof loop, then waits until the files are free — only processes
  whose executable is under the install folder (or an earlier desktop install
  folder the registry names: `SynaSetTargets` builds `$SynaRoots`), never a bare
  image name, never an npm/Git SynaBun from elsewhere. An interactive install
  asks once before it closes anything; a silent update closes quietly. The
  install goes on only when the helper reports everything closed and the files
  free (exit 0); any other result — still running, could-not-check, the helper
  failed to launch, or a timeout (the helper runs under an nsExec `/TIMEOUT`) —
  is a failure: Retry/Cancel interactively (naming the process and path), a
  non-zero installer exit in a silent update so the in-app updater rolls back.
  The helper checks the files are free even when no process is visible (an
  elevated SynaBun, or an unrelated holder: reported, never killed), and
  compares folder and process paths by their real filesystem path
  (`GetFinalPathNameByHandle`), so a short name or a junction cannot hide a
  running install. The application unpacks straight into the install folder
  (`desktop/build/synabun-extract.nsh`: `Nsis7z::ExtractWithDetails` into
  `$OUTDIR`, no temporary copy — the running copy is already closed, so a second
  full write of the payload is avoided), checked by `extractMacroMatches` in
  `lib/desktop.mjs`, and then verified against a build-time manifest
  (`writePayloadManifest` → `resources\synabun-payload.manifest`,
  `desktop/build/synabun-verify.ps1`): the install is "done" only when the whole
  payload is present at its size, not on `SynaBun.exe` alone, so a locked file or
  a full disk cannot leave an incomplete install (silent runs exit non-zero and
  the updater keeps the old version). It removes an earlier SynaBun installer's
  copy in the same folder; the uninstaller leaves the data home alone.
- **The window's title bar** is the app's own (`desktop/src/titlebar.mjs`): the
  native title bar is hidden (`titleBarStyle: 'hidden'`), the Window Controls
  Overlay is on (`titleBarOverlay`, 48 px: DESIGN.md's nav-bar), the caption
  buttons of Windows and Linux take the bar's colours (the page reports them,
  `setTitleBarOverlay`), the traffic lights of macOS are centred in it, and the
  menu bar of Windows and Linux is hidden with its accelerators kept (the page's
  menu button opens it: `Menu.popup`). The page side is
  `neural-interface/public/shared/desktop-titlebar.js`.
- **AppImage.** Registrations name the image file (`$APPIMAGE`), not the mount,
  which is gone when the process that opened it exits. Desktop and protocol
  starts re-execute the original image in a detached process with a fresh mount,
  kept alive for the entire supervisor lifetime; a hook is a new run too,
  mounted for as long as its handler works. Where the system forbids the
  sandbox's user namespaces (Ubuntu 24.04's AppArmor rule, a disabled
  `unprivileged_userns_clone`), the entry starts the window with `--no-sandbox`.
- **A copy macOS runs from a temporary path**, or from the disk image it came
  in, writes no hooks: its path is gone when it closes. Turning the hooks on
  says so, and the app offers to move itself to Applications. A project added
  from such a copy is registered without hooks; they are written once the
  hooks are turned on from the installed copy.
- **Not included.** The Playwright browser is downloaded on first start, as with
  the npm install. Claude Code, Codex, OpenCode and Gemini CLI are never
  included: see [External tools](#external-tools).
- **Included: the tunnel program.** The public address (invite links, remote
  MCP) works without a download: see [cloudflared](#cloudflared).

## Updates

The installed app updates itself from the public GitHub Releases of
`danilokhury/Synabun`, through electron-updater's generic provider at
`https://github.com/danilokhury/Synabun/releases/latest/download`. The latest
release without desktop files is "no update", quietly. The user side is
`docs/desktop-app.md`; the code is `desktop/src/updater/`.

- **When.** 30 seconds after the app opens, then every 6 hours, and whenever
  the person asks: the app menu, the tray, and the interface (the update badge,
  **Apps → Check for updates**, **Notifications → Updates**), which ask the app
  through `window.synabunDesktop.updates`, never `/api/system/run-update`
  (refused for every packaged install). `/api/system/version` offers the app
  no npm or GitHub update (`desktopManaged: true`).
- **What is newer** is decided by SynaBun's own rule
  (`neural-interface/lib/synabun-version.js`, copied into the window's code and
  kept equal by a test): a date-style version (`2026.9.8`, development builds
  from before SynaBun moved to semver on 2026-10-17) is older than every `2.x`
  release. electron-updater's plain semver comparison would never
  offer `2.x` to such a build, so its own check is replaced by this one.
- **The flow** (`desktop/src/updater/controller.mjs`). A check that finds a
  newer version downloads it at once. The downloaded update installs itself
  when SynaBun is idle: the app asks the server every 5 seconds
  (`GET /api/system/activity`, `neural-interface/lib/system-activity.js`:
  Assistant runs and dispatches, isolated agents, the three side panels'
  turns, Claude Code sessions with a prompt in the last 10 minutes, loops,
  the schedule queue, backups, reindexing, session indexing, CLI installs,
  storage clears; a counter that throws, no answer, or a server that is still
  starting is "not idle"), then shows a 60-second countdown in the interface
  (and a system notification when the window is not shown) with **Later**
  (no countdown for an hour). Work that starts during the countdown stops it.
  The update also installs when the app quits, and a copy that starts with
  one downloaded (`update-state/pending.json`) installs it before its server.
  **Install now** skips the countdown, never the wait for running work.
  Before installing, the app stops the server it started and writes how its
  window was (`relaunch.json`); the new copy opens it the same way and says
  once that it updated. Its first start takes SynaBun's verified pre-update
  snapshot of the data home (`backups/updates/synabun-pre-update-*.zip`)
  before its server, and so any migration, runs; when the snapshot fails, it
  does not start (`lib/first-launch-protection.js`).
- **Failures.** Anything that fails keeps the version that runs: an error with
  a link to the releases page, and the version is installed automatically
  again only at a check 3 hours or more later, 3 times at most
  (`update-state/attempts.json`); Try again and Install now still work.
- **Windows** (electron-updater's `NsisUpdater` downloads and checks the
  installer; `desktop/src/updater/windows.mjs` + `win-swap.mjs` install it):
  the app copies SynaBun's `node.exe` and the watchdog script into
  `update-state/swap/`, starts it detached (its parameters in the environment)
  and quits. The watchdog waits for the app to end, stops whatever still runs
  from the install folder (an MCP server or a hook of an AI tool), moves the
  folder aside (`<folder>.previous`), runs the installer as
  `--updated /S /D=<folder>` (per user, never elevated; no `publisherName`, so
  an unsigned build installs), checks that the folder holds exactly the new
  version, opens it with `--synabun-updated`, and removes the old copy once
  the new one writes `started`. A folder in use is left alone (nothing is
  installed); a failed installer, a wrong version or a new copy that does not
  start within 3 minutes puts the old copy back and opens it.
- **Linux** (electron-updater, `AppImageUpdater`): the new image takes the old
  one's place under the same path, so registrations keep working, and opens;
  the old image waits beside it (`.<name>.previous`, a hard link) until the new
  one runs, and comes back if it does not within 3 minutes.
- **macOS** (SynaBun's own, signed or not): the zip for this Mac's processor
  (Apple Silicon for an Intel copy under Rosetta) is downloaded and checked
  against `latest-mac.yml` (size and SHA-512), unpacked beside the app and
  checked (bundle id, version, processor, `codesign --verify --deep
  --strict`). After the app quits, a small detached script moves the new copy
  into place, opens it, and keeps the old one until the new one says it runs;
  if it does not within three minutes, or the move fails, the old copy is put
  back. A copy started from the disk image, or one macOS runs from a temporary
  path, is offered **Move to Applications** first; a copy in a folder it cannot
  write to downloads the disk image into Downloads and shows it.
- **Test feed.** `SYNABUN_DESKTOP_UPDATE_FEED=<url>` in the app's environment
  replaces the feed (https, or http on this machine only), and the dialog says
  that a test feed is in use. It cannot be set from the interface. This is how
  an update is proven against a local server: build X, build X+1 with
  `--version`, serve X+1's `--out` folder, and start X with the variable. With
  `SYNABUN_DESKTOP_TEST_DIR`, a file named `busy` there holds the update back.
- **A release, as a dry run.** `node packaging/build.mjs release-plan --out
  <folder> [--tag v.X.Y.Z] [--installed <version>]` lists what the workflow
  would upload to which release (installers first, the feed last), prints
  each `latest*.yml`, and checks that every file a feed names is there with
  its size and SHA-512, that one version is everywhere and matches the tag,
  and warns about a version the installed apps would never take (a
  date-style one, or one not newer than `--installed`). It uploads nothing.
- **Signing** is optional (see [Signing](#signing)); the same update path works
  for signed and unsigned builds.

## Update feed

Each build writes its part (`<artifact>.feed.json`); `build` and `feed` merge
the parts in the output folder:

| File | For | Lists |
|---|---|---|
| `latest-mac.yml` | macOS | both processors' `.zip` and `.dmg`, with `arch`, size and SHA-512 |
| `latest.yml` | Windows | the `-setup.exe`, size and SHA-512 |
| `latest-linux.yml` | Linux | the `.AppImage`, size and SHA-512 |
| `SHA256SUMS` | people | every installer, archive, blockmap and feed file |

A release is complete when it has all four builds and the three feed files; CI
uploads the installers first and the feed last, so an app never reads a feed
whose files are not there yet.

## cloudflared

The public address is a Cloudflare quick tunnel, opened by `cloudflared`
(`docs/tunnel.md`). An npm install downloads it into the data home the first
time a tunnel is started. An application build carries it, so that an installed
SynaBun downloads nothing for it. It is the one program of somebody else's that
a build contains, and not an [external tool](#external-tools): those are the
user's own installations and stay out.

- **One place knows which cloudflared.** `neural-interface/lib/cloudflared/pins.json`
  holds the version, Cloudflare's own release file for each platform, and two
  SHA-256 checksums for each (the file, and the binary inside it), with where
  each comes from. It ships with the application, which checks its copy against
  it at run time. A build reads that same file **from the application it
  staged**, and unpacks and checks with the application's own code
  (`lib/cloudflared/install.js`): an installer cannot carry a cloudflared the
  application would not have fetched itself. `pins.json` in this folder only
  points there.
- **Staging** (`lib/stage.mjs` `provisionCloudflared`). The release file for the
  target is downloaded into `build/cache/cloudflared/<version>/` and compared
  with its pin before anything reads it. The macOS files are archives: the one
  entry named `cloudflared` is read out, by SynaBun's own reader. The binary is
  compared with its own pin, has to be a program of the target's system and
  processor by its header, and gets its execute bit. A file that fails any of
  it stops the build; nothing is placed.
- **In the bundle** (`lib/bundle.mjs` `placeCloudflared`). `<resources>/cloudflared/cloudflared`
  (`cloudflared.exe` on Windows), beside `runtime/` and `app/`: where the
  application looks for the copy that came with it
  (`lib/cloudflared/pins.js` `bundledCloudflaredPath`). The manifest records its
  version and SHA-256.
- **The audit** refuses a bundle without it, with a cloudflared of another
  system or processor, with one that is not the pinned binary byte for byte,
  with one that may not run, with another file in its folder, or with a second
  cloudflared anywhere else in the bundle.
- **At run time** the application uses that copy and never downloads. If the
  copy is not the pinned binary any more, it is not run and not touched
  (running never writes inside the application): the pinned one is then
  fetched into the data home, as after an npm install.
- **Signing.** On macOS the bundled cloudflared is left as it is: Cloudflare
  signs it (Developer ID, hardened runtime, a secure timestamp). Signing it
  again would make it another file than the pinned one.

To move to another cloudflared release, change the pins (the header of
`lib/cloudflared/pins.js` says how), then run
`node scripts/verify-cloudflared-pins.mjs --all`: every pinned file is
downloaded for real into a scratch folder and both checksums are checked.

cloudflared is Apache-2.0 software by Cloudflare, Inc. `NOTICE` and
`THIRD-PARTY-LICENSES.md`, which every bundle carries, name it.

## Git for Windows

Claude Code on Windows runs its Bash tool and every hook through Git Bash; on a
PC without one it falls back to PowerShell, where the hooks an installed SynaBun
registers do not even parse. The Windows x64 installer carries a private copy of
Git for Windows, which SynaBun uses only on a PC that has no Git Bash of its own
(`docs/git-bash.md`). An npm install on Windows downloads the same file on first
need. macOS and Linux builds carry none.

- **One place knows which.** `neural-interface/lib/git-bash/pins.json`: the
  release (`v2.56.0.windows.2`), its Windows x64 file (`Git-2.56.0.2-64-bit.tar.bz2`,
  a full Git Bash with its Unix tools, not MinGit), the SHA-256 and size GitHub
  publishes for it, and what it holds once unpacked: the tree's digest (every
  file's path, size and SHA-256), the files SynaBun starts, the five links into
  `/proc` it leaves out and the empty folders it keeps. The build reads it, and
  unpacks and checks with the application's own code (`lib/git-bash/install.js`,
  `bzip2.js`), from the application it staged. `pins.json` here only points there.
- **Fetched by one script.** `lib/git-bash.mjs` `fetchGitBashArchive` downloads
  the file from Git for Windows' own GitHub release into
  `build/cache/git-for-windows/<version>/` and compares it with its pin; a file
  that does not match is removed and the build stops. `node
  packaging/fetch-git-for-windows.mjs [--cache <dir>] [--json]` runs the same
  function; **Build applications** runs it before a Windows build (into the
  build's cache, `C:\sbc`) and puts what it checked in the step summary.
- **Staging** (`lib/git-bash.mjs` `provisionGitBash`, Windows targets only). The
  file is unpacked by the application's own reader (no tar program: what one
  can read differs between build machines and Windows versions), the tree is
  compared with its pin file by file, and `LICENSE.txt` (Git's `COPYING` and
  `LGPL-2.1` of the pinned tag), `SOURCE.txt` and the marker `synabun-git.json`
  are added. A tree that differs stops the build; nothing is placed.
- **In the bundle** (`lib/bundle.mjs` `placeGitBash`). `<resources>/git`, beside
  `runtime/`. The manifest records its version, SHA-256 and tree. electron-builder
  copies files only, so the tree's empty folders (`dev/mqueue`, `dev/shm`, `tmp`)
  are made by the installer (`desktop/build/installer.nsh` `customInstall`, the
  list of the pins' `folders`).
- **The audit** refuses a Windows bundle without it, with a tree that is not the
  pinned one, without its license, source or marker, or whose `bin/bash.exe` or
  `cmd/git.exe` is not a Windows x64 program, and any other bundle that has a
  `resources/git`. Its own files are checked as that one tree, not one by one:
  90 .NET assemblies are marked for any processor, and MSYS2's
  `usr/libexec/getprocaddr32.exe` is 32-bit on purpose.
- **Signing.** electron-builder signs every `.exe` it copies into `resources`
  when a certificate is given, which would make the Git tree (and cloudflared)
  other files than the pinned ones. Builds are unsigned so far; a signed build
  needs both folders kept out of signing first.

To move to another release, see `docs/git-bash.md` → Moving to another release.
Git for Windows is GPL-2.0 software (Git) with components under their own
licenses; `THIRD-PARTY-LICENSES.md` names it.

## External tools

Claude Code, Codex, OpenCode and Gemini CLI are programs of their own. The user
installs them, each the way its publisher documents; SynaBun finds what is
installed and talks to it. No application build contains one, and SynaBun never
installs or updates one on its own (the update buttons in Settings act only
when pressed, and on the user's installation).

What a build does contain is the JavaScript client of each tool that has one:
`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`. As
published, the first brings the Claude Code executable as a per-platform
optional package and the second depends on the whole Codex CLI. npm cannot
express "the client without the program", so the rule lives in one list,
`lib/external-tools.js`, read in three places:

- **The lockfiles** hold none of those packages and no dependency edge to one,
  so `npm ci` and `npm install` never download them. After an `npm install`
  that touched an SDK, run `node scripts/strip-external-tools.mjs` (`--check`
  only reports); the external-tools test fails until it is.
- **An install** removes any that arrived anyway: the Neural Interface's
  `postinstall`, and the server at start.
- **A build** removes them from what it stages (step 4) and its audit refuses a
  bundle that holds one (step 9). `<entry> diagnostics --natives` on an
  installed application reports `externalTools`, which fails if one is inside.

At run time every SDK call is told which executable to start, and none is left
to search its own packages:

| Tool | Found by | Handed to |
| --- | --- | --- |
| Claude Code | `lib/cli-resolver.js` (through `getClaudeBin()`): the path in Settings > Terminal, else the first `claude` on PATH or the OS PATH, else a known install folder; never one inside SynaBun or from a `node_modules/.bin` folder. On Windows an npm `claude.cmd` is followed to the `claude.exe` (or `cli.js`) it runs (`lib/claude-executable.js`) | `pathToClaudeCodeExecutable`, for the side panel, the Assistant, native loops and session titles; the same file answers the model list |
| Codex | `lib/cli-resolver.js` (through `getCodexBin` / `getNativeCodexBin` in `server.js`), on Windows the native `codex.exe` of the global npm package (`lib/codex-runtime-path.js`) | `codexPathOverride`; the side panel and the model list start that executable themselves |
| OpenCode | `lib/cli-resolver.js` (through `opencodeServeLaunch` in `server.js`), started through the user's login shell by its full path (on Windows the `.exe` directly) | `opencode serve`, which `@opencode-ai/sdk` then talks to over HTTP |
| Gemini CLI | the command from Settings > Terminal | a terminal tab |

PATH here is the process's PATH, then the OS PATH a new terminal would have
(`lib/os-path.js`: the registry on Windows, the login shell and `/etc/paths` on
macOS and Linux), then the folders the installers use (`~/.local/bin`,
Homebrew, the npm prefix, `%APPDATA%\npm`, `~/.opencode/bin`, nvm, fnm, Volta,
Scoop, WinGet and others: `lib/augmented-path.js`). `SYNABUN_TOOL_DISCOVERY=path`
limits the search to the PATH the process was given; the smoke run sets it, so
a build is always run as a first start on a machine that has none of the tools.

A tool that is not installed is an ordinary state. The server starts, Settings
and the side panels say that it is not installed and how to install it, the
model lists fall back or stay empty, and everything that does not need the
tool works. A Claude session without Claude Code is refused with "Claude CLI
not found", the phrase the panel shows its install help on; a loop fails
before it starts, with the same reason.

## Prerequisites

- **All:** Node 22.19 or newer to run the builder, and network access to
  nodejs.org, the npm registry, huggingface.co and github.com (Electron, the
  AppImage toolset and electron-builder's NSIS, cloudflared's release files).
- **macOS:** Xcode command line tools (`clang`, `hdiutil`, `ditto`,
  `codesign`; `sips` and `iconutil` for the icon).
- **Linux:** `cc`, `g++`, `make`, `python3`, `tar`. The AppImage toolset is
  downloaded (pinned); `MKSQUASHFS` may name another `mksquashfs`.
- **Windows:** Visual Studio 2022 C++ build tools (or MinGW-w64 for the target's
  processor), and `tar.exe`. NSIS comes with electron-builder.
- **Cross builds:** `zig` 0.17 (`ZIG` may name it) and a `tar` that reads zip
  archives for the Windows target (macOS has one; elsewhere `bsdtar`). Nothing
  else to install: the AppImage toolset and NSIS are downloaded into the build
  cache. On macOS, stage a Linux build on a case-sensitive volume (`--work` on a
  case-sensitive APFS image), as some packages hold names that differ only in
  case.

## Pinned inputs

`pins.json` holds the SHA-256 of everything downloaded that is not covered by a
lockfile: the Node archives, the Electron archives, the AppImage toolset and
runtime, and the embedding model files. A download that does not match is
deleted and the build stops. cloudflared is pinned the same way, in the
application's own file (`neural-interface/lib/cloudflared/pins.json`): see
[cloudflared](#cloudflared). So is Git for Windows, for the Windows build
(`neural-interface/lib/git-bash/pins.json`): see [Git for Windows](#git-for-windows). electron-builder, electron-updater and js-yaml are
pinned by `desktop/package-lock.json`; electron-builder checks its own NSIS
download.

To move to another Node version, change `node.version` and `node.baseUrl` and
copy the five checksums from that release's `SHASUMS256.txt`; keep it equal to
the version in `.github/workflows/ci.yml`. To move to another Electron, change
`electron` in `pins.json` (the four archives' checksums from that release's
`SHASUMS256.txt`) and the `electron` version in `desktop/package.json` and its
lockfile. To accept new model files, build once with `--update-model-pins` and
review the change. When a native dependency is upgraded, check `nativeModules`
against the new version's binaries.

## Signing

Builds are **not signed** unless credentials are given in the environment. An
unsigned macOS app is signed ad hoc. Nothing is uploaded anywhere. The build
report says what was signed.

| Variable | Use |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | a `.p12` certificate (path, https address or base64): Developer ID on macOS, code signing on Windows |
| `CSC_NAME`, or `SYNABUN_MAC_SIGN_IDENTITY` | a Developer ID identity already in the keychain |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization with an Apple ID |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | notarization with an App Store Connect key |
| `APPLE_KEYCHAIN_PROFILE` (or `SYNABUN_MAC_NOTARY_PROFILE`), `APPLE_KEYCHAIN` | notarization with a `notarytool` keychain profile |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (or `SYNABUN_WIN_SIGN_PFX`, `SYNABUN_WIN_SIGN_PASSWORD`) | a Windows certificate file |
| `SYNABUN_WIN_SIGN_THUMBPRINT` | a certificate in the Windows store (a Windows build machine) |

The certificate auto-discovery of electron-builder is off: only a certificate
the environment names is used. An unsigned macOS build is stopped by
Gatekeeper after a download and has to be allowed by hand (right-click →
**Open**, or System Settings → Privacy & Security); an unsigned Windows
installer shows the SmartScreen warning. Signing and notarization have not been
run with real credentials.

## CI

`.github/workflows/build-apps.yml` is started by hand. It builds each requested
target on that target's own runner and keeps the builds as workflow artifacts:
a check of the builder on every system. It runs no tests, never runs on a
release and attaches nothing to one; it creates no release or tag, pushes
nothing and publishes nothing, and it only reads the repository.

A release's files come from one place: the four builds are made from the
release commit on the release machine, audited from the files themselves, the
feed and `SHA256SUMS` written over them, and all of it is attached to the
GitHub Release while it is still a draft, which is published (as Latest) once
it is complete. An installed app never reads a release whose files are still
uploading, and a release never gets a second set of files.

## Tests

The builder's tests are not published with this repository.

## Verified so far

The Electron app (checked on 2026-10-17 with 2026.9.8 builds, unsigned):

- **macOS arm64**: built natively, audited from the disk image and the zip
  (identical trees), and run in throwaway homes, data folders and ports: the
  window, the server starting with the app and stopping on Quit, MCP over stdio
  through `synabun-cli`, close and reopen, Restart Server, the localized menus.
  The update 2026.9.8 → 2026.9.9 from a local test feed (`--version` build),
  from the interface and from a native menu click: verified download, swap
  after quit, relaunch on the new payload, data intact, pre-update snapshot.
  A read-only folder gets the disk image in Downloads; a copy on its disk image
  is offered Move to Applications, writes no hooks and still owns its server.
  Next to a server that answers like the pre-desktop code on the same data
  home, it shows the conflict screen, starts nothing and asks the other server
  for nothing but its health; after the other one stops, Try again starts it.
  The bundle test with the live start passes against the build.
- **macOS x64**: built natively through Rosetta 2, audited, and run on Apple
  Silicon through Rosetta (the bundle test with the live start; the update
  of an Intel copy under Rosetta to the Apple Silicon build). Never run on an
  Intel Mac.
- **linux-x64** and **windows-x64**: cross-built on macOS and audited from the
  artifacts themselves (the AppImage's file system and the NSIS installer's
  payload extracted: every binary x64, the pinned runtime, the fuses, no
  external tool, no private string, our executables unsigned). Never started:
  not the window, not the backend, not the installer or the uninstaller, not
  an update. Treat the first run of each as its first test.
- Not run at all: the CI workflow, signing and notarization, an update from a
  real GitHub Release (the latest release has no desktop files; the app's
  automatic check reads it as "no update", which was seen live).

Native builds leave development files and dependencies intact. Local agent instructions are excluded from the disposable package stage; other private files still block a build. External CLI dependency edges are stripped from staged lockfile copies before npm runs, and executable payloads are removed only from that stage.
