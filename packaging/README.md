# Building SynaBun applications

`packaging/` turns this repository into an application people install without
Node or npm: the existing server and browser interface, a Node runtime of its
own, the dependencies for one platform, and a small native executable in front.
It is a development tool. Nothing in this folder is published to npm.

The native launcher starts or reuses the server in the background, without a
terminal window, and opens the browser-owned installed PWA. There is no tray
or login service. Closing the PWA leaves the backend running.

## Targets

| Target | Command | Built on | Artifact | State |
|---|---|---|---|---|
| `macos-arm64` | `npm run build:mac:arm` | macOS on Apple Silicon | `.dmg` (or `.zip`) | builds |
| `macos-x64` | `npm run build:mac:intel` | macOS on Intel, or Apple Silicon with Rosetta 2 | `.dmg` (or `.zip`) | builds |
| `linux-x64` | `npm run build:linux:x64` | Linux x64 with glibc; macOS or Linux with `--cross` | AppImage (or portable `.tar.gz`) | builds |
| `windows-x64` | `npm run build:windows:x64` | Windows x64; macOS or Linux with `--cross` | NSIS installer (or `.zip`) | builds |
| `windows-x86` | `npm run build:windows:x86` | nowhere | none | **not supported**, see below |

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
- **AppImage.** `appimagetool` only runs on Linux. `mksquashfs` and the same
  pinned runtime make the image, which is then read back: the runtime's mark,
  the file system behind it, and the number of files in it. The image carries
  no embedded MD5 digest, which `appimagetool` would add.
- **Smoke run.** Not possible. The build report says `not run`, and the bundle
  has to be started on the target before it is relied on.

The Windows installer is made by the same `installer.nsi`. NSIS installers are
32-bit programs whatever they install; what this one installs is 64-bit.

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
```

| Option | Meaning |
|---|---|
| `--cross` | build `linux-x64` or `windows-x64` on macOS or Linux; checked, never run |
| `--out <dir>` | where artifacts go (default `build/out`) |
| `--work <dir>` | staging folder, emptied first (default `build/stage`) |
| `--cache <dir>` | downloads and npm cache, kept between builds (default `build/cache`) |
| `--artifact <kinds>` | from the target's list, comma separated (default: the first) |
| `--no-fallback` | fail when the first-choice artifact cannot be made |
| `--no-embedding-model` | leave the local embedding model out |
| `--update-model-pins` | record the downloaded model's checksums in `pins.json` |
| `--no-tool-downloads` | never download a packaging tool, even a pinned one |
| `--skip-smoke` | do not run the finished bundle (it is still audited) |
| `--keep-work` | keep the staging folder |

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
   copied from the checkout's `node_modules` or from a data folder.
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
7. **Bundle.** Runtime, application, bootstrap, manifest, and the native entry
   compiled from `launcher/launcher.c`.
8. **Audit.** Required files, the processor of every native binary, execute
   permissions, no private file, and no external tool: not its package, not its
   command, not its executable, not an entry in a lockfile of the bundle.
9. **Smoke run.** In a throwaway home, on a port nothing uses, with none of the
   external tools in reach: the version, a real pseudo-terminal, the embedding
   runtime, and an MCP conversation over stdio. Running must not change a file
   of the bundle.
10. **Artifact.** With its SHA-256 and a `build-report.json`.

A cross build does the same ten steps with the replacements listed under
[Cross builds](#cross-builds); step 9 is recorded as not run.

## How a packaged application runs

```
SynaBun                 start/reuse the background server and open the installed PWA
SynaBun start           run the server in this terminal
SynaBun mcp             the MCP server on stdio, for an AI tool
SynaBun diagnostics     what this build is (--json, --natives)
SynaBun version | doctor | profile | migrate-data | restore-backup
```

- **First desktop launch.** If no matching installed PWA is found, the default
  browser opens `/install-app.html`. Choose **Install as App** (Chrome/Edge), or
  **File → Add to Dock** in Safari on macOS. Browser confirmation is required
  once; no browser or PWA is silently installed. Keep the app name **SynaBun**.
  Continue to SynaBun to complete onboarding. After installation, reopen the
  native launcher to use the installed PWA.
- **Later launches.** The launcher waits for SynaBun's healthy API, then opens
  the matching Safari/Chrome/Edge application bundle on macOS, Chrome/Edge
  Start Menu or Desktop shortcut on Windows, or Chrome/Edge desktop entry on
  Linux. Matching uses the configured loopback port and browser app identity;
  no browser profile database is read. A removed, renamed or unsupported
  shortcut falls back to the installation guide. Chromium `--app=URL` is never
  used as a substitute for an installed PWA.
- **Backend lifetime.** Closing the PWA does not stop the server. Use
  **Apps → Stop Server** before an update/uninstall or when you want it stopped.
  There is no terminal window to keep open. Logs remain in the user-data
  `data/server-stdout.log`, `data/server-stderr.log` and `data/launcher.log`.
  The browser's own PWA icon cannot start a stopped backend itself: use the
  native launcher, or the offline page's **Start Server** protocol bridge.
- **Entry.** `SynaBun.app/Contents/MacOS/SynaBun`, `SynaBun.exe`, or `AppRun`
  (`synabun` in the portable bundle). It runs the bundled Node directly, never a
  shell and never a Node from `PATH`, and puts the bundled `node`, `npm` and
  `npx` first on `PATH` for everything the application starts by name.
- **Data** stays where it always was (`~/.synabun`, `%APPDATA%\synabun`, or
  `SYNABUN_DATA_HOME`). Installing, upgrading and uninstalling never touch it,
  and running never writes inside the application.
- **MCP.** Clients are registered with `<entry> mcp`. Nothing but MCP messages
  goes to stdout. The copy-and-paste snippets in Settings and in the setup
  wizard show the same command.
- **Claude Code hooks** are registered as `"<entry>" claude-hook <script>`
  (`lib/claude-hooks.js`). The entry runs the handler with the bundled Node and
  prints nothing of its own, so the person needs no Node and the IDE needs
  nothing on its `PATH`. No `SYNABUN_HOOK_ROOT` is written. Handlers left by an
  npm install, or by a copy of the application that has since moved, are
  replaced on the next start.
- **Starting it by hand.** The offline page shows `<entry> start`.
- **`synabun://` links** use the existing handler registration, written on
  first start, pointing at `<entry> launcher`. The Windows installer writes the
  same registry value at install time.
- **AppImage.** Registrations name the image file (`$APPIMAGE`), not the mount,
  which is gone when the process that opened it exits. Desktop and protocol
  starts re-execute the original image in a detached process with a fresh mount,
  kept alive for the entire supervisor lifetime; a
  hook is a new run too, mounted for as long as its handler works.
- **A copy macOS runs from a temporary path** (a quarantined download opened
  before it was moved to Applications) writes no hooks: its path is gone when
  it closes. Turning the hooks on says so. A project added from such a copy is
  registered without hooks; they are written once the hooks are turned on from
  the installed copy.
- **Updates.** The in-app updater never changes a packaged application: it
  reports that a newer build has to be installed over this one. There is no
  update feed yet.
- **Not included.** The Playwright browser is downloaded on first start, as with
  the npm install. Claude Code, Codex, OpenCode and Gemini CLI are never
  included: see [External tools](#external-tools).

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
  only reports); `packaging/tests/external-tools.test.mjs` fails until it is.
- **An install** removes any that arrived anyway: the Neural Interface's
  `postinstall`, and the server at start.
- **A build** removes them from what it stages (step 4) and its audit refuses a
  bundle that holds one (step 8). `<entry> diagnostics --natives` on an
  installed application reports `externalTools`, which fails if one is inside.

At run time every SDK call is told which executable to start, and none is left
to search its own packages:

| Tool | Found by | Handed to |
| --- | --- | --- |
| Claude Code | `lib/claude-executable.js`: the command from Settings > Terminal, else the first `claude` on PATH, never one inside SynaBun or from a `node_modules/.bin` folder. On Windows an npm `claude.cmd` is followed to the `claude.exe` (or `cli.js`) it runs | `pathToClaudeCodeExecutable`, for the side panel, the Assistant, native loops and session titles; the same file answers the model list |
| Codex | `getCodexBin` / `getNativeCodexBin` in `server.js`, `lib/codex-runtime-path.js`: the trusted global installation, on Windows the native `codex.exe` of the global npm package | `codexPathOverride`; the side panel and the model list start that executable themselves |
| OpenCode | the command from Settings > Terminal, started through the user's shell | `opencode serve`, which `@opencode-ai/sdk` then talks to over HTTP |
| Gemini CLI | the command from Settings > Terminal | a terminal tab |

PATH here is the process's PATH plus the folders the installers use
(`~/.local/bin`, Homebrew, the npm prefix, `%APPDATA%\npm`, `~/.opencode/bin`
and others: `lib/augmented-path.js`). `SYNABUN_TOOL_DISCOVERY=path` limits the
search to the PATH the process was given; the smoke run sets it, so a build is
always run as a first start on a machine that has none of the tools.

A tool that is not installed is an ordinary state. The server starts, Settings
and the side panels say that it is not installed and how to install it, the
model lists fall back or stay empty, and everything that does not need the
tool works. A Claude session without Claude Code is refused with "Claude CLI
not found", the phrase the panel shows its install help on; a loop fails
before it starts, with the same reason.

## Prerequisites

- **All:** Node 22.19 or newer to run the builder, and network access to
  nodejs.org, the npm registry and huggingface.co.
- **macOS:** Xcode command line tools (`clang`, `hdiutil`, `codesign`).
- **Linux:** `cc`, `g++`, `make`, `python3`, `tar`. `appimagetool` is downloaded
  (pinned) unless one is installed or `APPIMAGETOOL` names one.
- **Windows:** Visual Studio 2022 C++ build tools (or MinGW-w64 for the target's
  processor). NSIS 3 for the installer; without `makensis` the build is a zip
  and says so.
- **Cross builds:** `zig` 0.17 (`ZIG` may name it), and a `tar` that reads zip
  archives for the Windows target (macOS has one; elsewhere `bsdtar`). For the
  AppImage, `mksquashfs` with zstd (`MKSQUASHFS` may name it); without it the
  build is the portable archive. For the installer, `makensis`. On macOS those
  three are `brew install zig squashfs makensis`.

## Pinned inputs

`pins.json` holds the SHA-256 of everything downloaded that is not covered by a
lockfile: the Node archives, `appimagetool` and the AppImage runtime, and the
embedding model files. A download that does not match is deleted and the build
stops.

To move to another Node version, change `node.version` and `node.baseUrl` and
copy the five checksums from that release's `SHASUMS256.txt`; keep it equal to
the version in `.github/workflows/ci.yml`. To accept new model files, build
once with `--update-model-pins` and review the change. When a native dependency
is upgraded, check `nativeModules` against the new version's binaries.

## Signing

Builds are **not signed** unless credentials are given in the environment.
Nothing is uploaded anywhere. The build report says what was signed.

| Variable | Use |
|---|---|
| `SYNABUN_MAC_SIGN_IDENTITY` | `Developer ID Application: ...`; `-` for an ad hoc signature |
| `SYNABUN_MAC_NOTARY_PROFILE` | a `notarytool` keychain profile |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | notarization without a profile |
| `SYNABUN_WIN_SIGN_THUMBPRINT` | a certificate in the Windows store |
| `SYNABUN_WIN_SIGN_PFX`, `SYNABUN_WIN_SIGN_PASSWORD` | a certificate file |
| `SYNABUN_WIN_TIMESTAMP_URL`, `SYNABUN_SIGNTOOL` | optional overrides |

An unsigned macOS build is stopped by Gatekeeper after a download and has to be
allowed by hand; an unsigned Windows installer shows the SmartScreen warning.
The signing and notarization steps have not been run with real credentials.

## CI

`.github/workflows/build-apps.yml` is started by hand. It builds each requested
target on that target's runner, runs these tests there, and keeps the result as
a workflow artifact. It creates no release and publishes nothing.

## Tests

```
npm run test:packaging
```

`builder.test.mjs` covers the decisions (targets, refusals, private files,
pins). `external-tools.test.mjs` holds the [external tools](#external-tools)
rule: the real lockfiles, the list, an installed tree being cleared, staging,
and the audit refusing a bundle that carries one. `cross.test.mjs` covers what
a cross build checks instead of running:
the package selection, what a compiled file asks of the target, the AppImage,
the Windows command files. `entry.test.mjs` compiles the native entry and runs it and the bootstrap
against stand-ins, with spaces and non-ASCII characters in every path.
`bundle.test.mjs` runs a finished bundle and is skipped unless
`SYNABUN_BUNDLE_ENTRY` names one; `SYNABUN_BUNDLE_LIVE=1` also starts the real
server from it on an unused port in a throwaway home, where none of the
external tools can be found: each has to be reported as not installed, with
how to install it, and the server has to keep answering.

The parts of the application that change for a packaged install are tested with
the rest of it, in `neural-interface/tests/packaged-runtime.test.mjs`; finding
the user's Claude Code and handing it to the SDK, in
`neural-interface/tests/claude-executable.test.mjs` and
`claude-bridge-executable.test.mjs`.

## Verified so far

- `macos-arm64`: built, audited, run, tested with `bundle.test.mjs` including
  the live start. Unsigned.
- `macos-x64`: built and run on Apple Silicon through Rosetta 2, tested with
  `bundle.test.mjs` without the live start. Unsigned.
- `linux-x64` and `windows-x64`: cross-built on macOS (Apple Silicon) into an
  AppImage and an NSIS installer, with every check under
  [Cross builds](#cross-builds) passing. Neither is started by its build, so
  what only a run shows is unverified there: the terminal module compiled with
  zig loading in Node, the Windows half of the native entry, the installer's
  pages. Unsigned.
- Not run at all: a native build on Linux or on Windows, the CI workflow,
  signing and notarization. Treat the first run of each as its first test.

Native builds leave development files and dependencies intact. Local agent instructions are excluded from the disposable package stage; other private files still block a build. External CLI dependency edges are stripped from staged lockfile copies before npm runs, and executable payloads are removed only from that stage.
