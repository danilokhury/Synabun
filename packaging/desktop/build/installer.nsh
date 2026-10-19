; SynaBun — what the Windows installer does beyond electron-builder's own
; (included through nsis.include by packaging/lib/desktop.mjs).
;
; The installer is per user (no administrator rights) and installs into
; %LOCALAPPDATA%\Programs\SynaBun. User data lives in %APPDATA%\synabun and is
; never touched: not by an install, an update or the uninstaller
; (deleteAppDataOnUninstall stays false).
;
;   details  the install page lists every step as it happens, each with the
;            seconds since the start, the list open from the start
;            (electron-builder's assisted installer, with no page before the
;            install: per user, no folder to choose): what is being installed
;            (version, Node.js, npm and npx, the native modules, the packages),
;            the unpacking with its progress (synabun-extract.nsh), every part
;            that landed, the shortcuts, the entry in Settings > Apps and the
;            link handler. The uninstaller lists its steps too. A silent install
;            (the app's own update: --updated /S /D=<dir>) shows nothing, as
;            before. The numbers come from the build (synabun-installer-facts.nsh,
;            written by packaging/lib/desktop.mjs). The whole list is also written
;            to %TEMP%\SynaBun-install-<time>.log, named on the finish page: that
;            is how a slow install shows where the time went
;   stop     SynaBun is not one process — the window (SynaBun.exe), its server on
;            the bundled node.exe, synabun-cli.exe launchers and hooks, the
;            long-lived "synabun-cli mcp" stdio servers an AI tool started, the
;            bundled cloudflared.exe and the bundled Git Bash can each hold a file
;            in the install folder open, and closing the window leaves the server
;            running. Before anything is written or removed, synabun-stop.ps1
;            closes them all: first a graceful shutdown over the server's loopback
;            port (so SQLite and the children close cleanly and the supervisor
;            exits), then a forced close of whole process trees, then a wait until
;            the files are free. It only ever touches processes whose executable
;            path is inside this install folder (or an earlier desktop install
;            folder the registry names): a SynaBun installed by npm or Git runs
;            from elsewhere and is left alone. An interactive install asks once
;            before it closes a running SynaBun; a silent update does it quietly
;            (the app has already begun to quit by then)
;   earlier  a copy put there by the earlier SynaBun installer (before the
;            desktop app) is replaced as a whole, its uninstaller and shortcuts
;            removed, so one SynaBun is listed and nothing old stays behind
;   links    synabun:// starts the server through the headless entry, as the
;            app writes it itself on every start (lib/start-launcher.js)
;   git      the empty folders of Git for Windows' tree (resources\git, the Git
;            Bash Claude Code needs): an installer of files carries none, and
;            MSYS2 keeps /dev/shm and /dev/mqueue there. The list is `folders` of
;            neural-interface/lib/git-bash/pins.json (packaging/tests/git-bash.test.mjs)

; This file is included in electron-builder's shared header, before the main
; script pulls in MUI2 (and with it LogicLib). The functions below are compiled
; here, so ${if}/${ifNot}/${errors} must already exist: include LogicLib now.
; It guards itself, so the later include is a no-op.
!include "LogicLib.nsh"

!define SYNABUN_LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SynaBun"
!define SYNABUN_PROTOCOL_KEY "Software\Classes\synabun"

; What this build carries, for the install page (packaging/lib/desktop.mjs writes it beside this file).
!include /NONFATAL "synabun-installer-facts.nsh"
!define /ifndef SYNABUN_TARGET "Windows x64"
!define /ifndef SYNABUN_FILES "?"
!define /ifndef SYNABUN_SIZE_MB "?"
!define /ifndef SYNABUN_NODE_VERSION "?"
!define /ifndef SYNABUN_NPM_VERSION "?"
!define /ifndef SYNABUN_ELECTRON_VERSION "?"
!define /ifndef SYNABUN_NATIVES "?"
!define /ifndef SYNABUN_NI_PACKAGES "?"
!define /ifndef SYNABUN_MCP_PACKAGES "?"
!define /ifndef SYNABUN_EMBEDDING_MODEL ""
!define /ifndef SYNABUN_CLOUDFLARED_VERSION "?"
!define /ifndef SYNABUN_GIT_VERSION "?"
!define /ifndef SYNABUN_NPM_PREFIX "%APPDATA%\synabun\runtime\npm-global"

; The whole stop runs in at most this many seconds; the installer never hangs.
!define /ifndef SYNABUN_STOP_BUDGET "25"

; ── The installation log, every step with the seconds since the start ──
Var SynaLog        ; the log file's path (also named on the finish page)
Var SynaLogHandle  ; its open handle while the installer runs (0 when none)
Var SynaTick0      ; GetTickCount at the first step, to time the rest
Var SynaRoots      ; the install folder(s) the stop helper may close, joined with a bar
Var SynaProbe      ; the window executable, to test the files are free after the close

; Open the log once, in %TEMP%, and start the clock. Idempotent. The timestamp
; comes from GetLocalTime (not FileFunc's GetTime, whose artificial function does
; not cross the installer/uninstaller boundary this macro is inserted on).
!macro SynaOpenLog
  ${if} $SynaLog == ""
    StrCpy $SynaLogHandle 0
    System::Call 'kernel32::GetTickCount()i.s'
    Pop $SynaTick0
    System::Alloc 16
    Pop $R1
    System::Call 'kernel32::GetLocalTime(i R1)'
    System::Call '*$R1(&i2 .r2, &i2 .r3, &i2 .r4, &i2 .r5, &i2 .r6, &i2 .r7, &i2 .r8)' ; year month dow day hour min sec
    System::Free $R1
    !ifdef BUILD_UNINSTALLER
      StrCpy $SynaLog "$TEMP\SynaBun-uninstall-$2$3$5-$6$7$8.log"
    !else
      StrCpy $SynaLog "$TEMP\SynaBun-install-$2$3$5-$6$7$8.log"
    !endif
    ClearErrors
    FileOpen $SynaLogHandle "$SynaLog" w
    ${if} ${errors}
      StrCpy $SynaLogHandle 0
    ${else}
      FileWrite $SynaLogHandle "SynaBun ${VERSION} for ${SYNABUN_TARGET}$\r$\n"
      FileWrite $SynaLogHandle "started $2-$3-$5 $6:$7:$8, into $INSTDIR$\r$\n"
    ${endIf}
  ${endIf}
!macroend

; One step: the seconds since the start, the text, on the page and in the log.
!macro SynaPhase TEXT
  !insertmacro SynaOpenLog
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $R7
  IntOp $R7 $R7 - $SynaTick0
  IntOp $R7 $R7 / 1000
  SetDetailsPrint both
  DetailPrint "[+$R7s] ${TEXT}"
  ${if} $SynaLogHandle <> 0
    FileWrite $SynaLogHandle "+$R7s  ${TEXT}$\r$\n"
  ${endIf}
!macroend

!macro SynaCloseLog
  ${if} $SynaLogHandle <> 0
    FileClose $SynaLogHandle
    StrCpy $SynaLogHandle 0
  ${endIf}
!macroend

; The folders a close may touch, and the file to test for being free afterward.
; A macro (expanded late, where the registry keys and the executable name are
; defined), so the functions below can stay clear of those defines — a function
; body is compiled in the shared header, before multiUser.nsh/common.nsh define
; them. The folders are this install folder, plus an earlier desktop install
; folder the registry names (a copy that was moved, or the pre-desktop layout):
; a SynaBun outside these folders (an npm or Git install) is never touched.
!macro SynaSetTargets
  StrCpy $SynaRoots "$INSTDIR"
  ReadRegStr $R5 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R5 != ""
  ${andIf} $R5 != "$INSTDIR"
    StrCpy $SynaRoots "$SynaRoots|$R5"
  ${endIf}
  ReadRegStr $R5 HKCU "${SYNABUN_LEGACY_UNINSTALL_KEY}" InstallLocation
  ${if} $R5 != ""
  ${andIf} $R5 != "$INSTDIR"
    StrCpy $SynaRoots "$SynaRoots|$R5"
  ${endIf}
  StrCpy $SynaProbe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

; ── Close a running SynaBun ──
;
; Defined once for the installer and once (un.) for the uninstaller, so each can
; call it. SynaSetTargets has filled $SynaRoots and $SynaProbe; this writes the
; helper and runs it — detect first so a prompt comes before anything is closed,
; then the graceful-then-forced close, with Retry/Cancel if something is still
; holding the files. synabun-stop.ps1 does the real work; this decides what to say.
!macro SynaStopBody UN
Function ${UN}SynaStopExec
  ; A whole-helper timeout (60 s) so a hung PowerShell never stalls the install;
  ; a failed launch or a timeout pops a non-numeric code ("error"/"timeout"),
  ; which is not "0" and so counts as a failure below.
  nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\synabun-stop.ps1"'
  Pop $R7  ; "0" closed and files free · "3" still running / a file is locked · "2" could not look · "error"/"timeout" the helper did not run
  Pop $R8  ; the one-line summary, or nsExec's own text on a launch error / timeout
FunctionEnd

Function ${UN}SynaStopProc
  InitPluginsDir
  File "/oname=$PLUGINSDIR\synabun-stop.ps1" "${BUILD_RESOURCES_DIR}\synabun-stop.ps1"
  ; The folders travel in the environment: no path is ever on the command line.
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_STOP_ROOTS", t "$SynaRoots")i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_STOP_LOG", t "$SynaLog")i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_STOP_PROBE", t "$SynaProbe")i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_STOP_BUDGET", t "${SYNABUN_STOP_BUDGET}")i'

  ; 1. Look first (killing nothing), to decide whether to warn before closing.
  ;    Anything but a clean "nothing running" (0) warns in an interactive run —
  ;    a "busy" (3) or a helper that could not tell (2 / error / timeout): fail
  ;    closed, assume it is running.
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_STOP_DETECT", t "1")i'
  Call ${UN}SynaStopExec
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_STOP_DETECT", t "")i'
  StrCpy $R6 $R7   ; remember the look-first result for the final message
  ${ifNot} ${Silent}
    ${if} $R7 != "0"
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "SynaBun is running and will be closed to continue.$\r$\nOpen terminals and agent sessions will stop." /SD IDOK IDOK +2
      Quit
    ${endIf}
  ${endIf}

  ; 2. Close, and let the install go on ONLY when the helper reports everything
  ;    closed and the files free (exit 0). Every other result — still busy (3),
  ;    could not look (2), the helper did not run (error / timeout) — is a
  ;    failure: Retry/Cancel interactively (naming the process and path), and a
  ;    non-zero installer exit in a silent run, so nothing destructive follows
  ;    and the in-app updater rolls back.
synaStopLoop:
  !insertmacro SynaPhase "Closing SynaBun (window, server, agents, terminals)"
  Call ${UN}SynaStopExec
  StrCmp $R7 "0" synaClosed
  ${if} ${Silent}
    !insertmacro SynaPhase "SynaBun could not be closed ($R8); stopping without changing anything."
    SetErrorLevel 2
    Quit
  ${endIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "SynaBun could not be fully closed:$\r$\n$R8$\r$\n$\r$\nClose it and choose Retry, or Cancel to stop the installation." /SD IDCANCEL IDRETRY synaStopLoop
  SetErrorLevel 2
  Quit

synaClosed:
  ${if} $R6 == "0"
    !insertmacro SynaPhase "SynaBun is not running"
  ${else}
    !insertmacro SynaPhase "SynaBun is closed"
  ${endIf}
FunctionEnd
!macroend
; Define only the copy the current pass calls: the uninstaller build would warn
; (6010) about an unreferenced installer function, and the other way round.
!ifdef BUILD_UNINSTALLER
  !insertmacro SynaStopBody "un."
!else
  !insertmacro SynaStopBody ""
!endif

; Check the unpacked payload against the build-time manifest (synabun-verify.ps1,
; embedded). Used by synabun-extract.nsh right after unpacking, so a locked file
; or a full disk never leaves an incomplete install that only checked SynaBun.exe.
; $R7 = "0" complete · "3" missing/short files · "2"/"error"/"timeout" could not check.
!macro SynaVerifyPayload
  File "/oname=$PLUGINSDIR\synabun-verify.ps1" "${BUILD_RESOURCES_DIR}\synabun-verify.ps1"
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_VERIFY_DIR", t "$OUTDIR")i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_VERIFY_LOG", t "$SynaLog")i'
  nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\synabun-verify.ps1"'
  Pop $R7
  Pop $R8
!macroend

; The install and uninstall pages show their list of steps, open from the start
; (electron-builder's common.nsh says nevershow; this comes after it).
!macro customHeader
  ShowInstDetails show
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !endif
!macroend

!macro customCheckAppRunning
  ; electron-builder hides the list for its own steps; every step shows from here on.
  SetDetailsPrint both
  !insertmacro SynaOpenLog
  !ifdef BUILD_UNINSTALLER
    !insertmacro SynaPhase "Removing SynaBun ${VERSION} from $INSTDIR"
  !else
    !insertmacro SynaPhase "SynaBun ${VERSION} for ${SYNABUN_TARGET}: ${SYNABUN_FILES} files, ${SYNABUN_SIZE_MB} MB"
    !insertmacro SynaPhase "Installing for this Windows user, without administrator rights, into $INSTDIR"
    ; The unpacking, with its progress on the page (synabun-extract.nsh): electron-builder's macro is defined by now.
    !ifmacrodef extractUsing7za
      !include "synabun-extract.nsh"
    !endif
  !endif
  !insertmacro SynaPhase "Looking for a running SynaBun (window, server, agents, terminals)"
  !insertmacro SynaSetTargets
  !ifdef BUILD_UNINSTALLER
    Call un.SynaStopProc
  !else
    Call SynaStopProc
  !endif
!macroend

!macro customInit
  !insertmacro SynaOpenLog
  ReadRegStr $R5 HKCU "${SYNABUN_LEGACY_UNINSTALL_KEY}" "InstallLocation"
  ${if} $R5 != ""
  ${andIf} $R5 == "$INSTDIR"
  ${andIf} ${FileExists} "$R5\Uninstall.exe"
    ; The earlier installer's copy, in this same folder ($R5 == $INSTDIR): close it,
    ; then replace it as a whole. The folder is $INSTDIR from here.
    !insertmacro SynaSetTargets
    Call SynaStopProc
    !insertmacro SynaPhase "Replacing the earlier SynaBun in $INSTDIR"
    RMDir /r "$INSTDIR\resources"
    Delete "$INSTDIR\Uninstall.exe"
    Delete "$INSTDIR\LICENSE"
    Delete "$INSTDIR\NOTICE"
    Delete "$INSTDIR\THIRD-PARTY-LICENSES.md"
    Delete "$SMPROGRAMS\SynaBun\SynaBun.lnk"
    Delete "$SMPROGRAMS\SynaBun\Uninstall SynaBun.lnk"
    RMDir "$SMPROGRAMS\SynaBun"
    DeleteRegKey HKCU "${SYNABUN_LEGACY_UNINSTALL_KEY}"
    DeleteRegValue HKCU "Software\SynaBun" "InstallDir"
    DeleteRegKey /ifempty HKCU "Software\SynaBun"
  ${endIf}
!macroend

; One line per part that landed: what it is, and where.
!macro synabunInstalledPart FILE TEXT
  ${if} ${FileExists} "$INSTDIR\${FILE}"
    DetailPrint "  ${TEXT}"
  ${else}
    DetailPrint "  MISSING: ${FILE} (${TEXT}). Run the installer again."
  ${endIf}
!macroend

; Right after the unpacking: every part of SynaBun, in its place.
!macro customFiles_x64
  !insertmacro SynaPhase "Unpacked SynaBun into $INSTDIR:"
  !insertmacro synabunInstalledPart "SynaBun.exe" "SynaBun.exe: the SynaBun window (Electron ${SYNABUN_ELECTRON_VERSION})"
  !insertmacro synabunInstalledPart "synabun-cli.exe" "synabun-cli.exe: the command line entry MCP clients and Claude Code hooks run"
  !insertmacro synabunInstalledPart "resources\runtime\node.exe" "Node.js ${SYNABUN_NODE_VERSION}: resources\runtime\node.exe (SynaBun runs on its own Node.js)"
  !insertmacro synabunInstalledPart "resources\runtime\npm.cmd" "npm ${SYNABUN_NPM_VERSION}: resources\runtime\npm.cmd (global packages go to ${SYNABUN_NPM_PREFIX})"
  !insertmacro synabunInstalledPart "resources\runtime\npx.cmd" "npx ${SYNABUN_NPM_VERSION}: resources\runtime\npx.cmd"
  !insertmacro synabunInstalledPart "resources\app\neural-interface\server.js" "Neural Interface: ${SYNABUN_NI_PACKAGES} packages, with the native modules for Windows x64 (${SYNABUN_NATIVES})"
  !insertmacro synabunInstalledPart "resources\app\mcp-server\dist\index.js" "MCP server: ${SYNABUN_MCP_PACKAGES} packages, built"
  !if "${SYNABUN_EMBEDDING_MODEL}" != ""
    !insertmacro synabunInstalledPart "resources\app\mcp-server\node_modules\@huggingface\transformers\.cache\${SYNABUN_EMBEDDING_MODEL}\onnx\model.onnx" "Local embedding model: ${SYNABUN_EMBEDDING_MODEL}"
  !endif
  !insertmacro synabunInstalledPart "resources\cloudflared\cloudflared.exe" "cloudflared ${SYNABUN_CLOUDFLARED_VERSION}: the tunnel behind invite links and remote MCP"
  !insertmacro synabunInstalledPart "resources\git\bin\bash.exe" "Git for Windows ${SYNABUN_GIT_VERSION}: the Git Bash Claude Code needs"
!macroend

!macro customInstall
  !insertmacro SynaPhase "Registering the link handler synabun:// (HKCU\${SYNABUN_PROTOCOL_KEY})"
  WriteRegStr HKCU "${SYNABUN_PROTOCOL_KEY}" "" "URL:SynaBun Protocol"
  WriteRegStr HKCU "${SYNABUN_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${SYNABUN_PROTOCOL_KEY}\shell\open\command" "" '"$INSTDIR\synabun-cli.exe" "launcher" "--via=protocol" "--" "%1"'
  ${if} ${FileExists} "$INSTDIR\resources\git\bin\bash.exe"
    DetailPrint "Creating the empty folders of Git for Windows"
    CreateDirectory "$INSTDIR\resources\git\dev\mqueue"
    CreateDirectory "$INSTDIR\resources\git\dev\shm"
    CreateDirectory "$INSTDIR\resources\git\tmp"
  ${endIf}
  ${if} ${FileExists} "$newStartMenuLink"
    DetailPrint "Start menu shortcut: $newStartMenuLink"
  ${endIf}
  ${if} ${FileExists} "$newDesktopLink"
    DetailPrint "Desktop shortcut: $newDesktopLink"
  ${endIf}
  DetailPrint "Listed in Settings > Apps as SynaBun ${VERSION} (HKCU\${UNINSTALL_REGISTRY_KEY})"
  DetailPrint "Install folder recorded for updates (HKCU\${INSTALL_REGISTRY_KEY})"
  DetailPrint "Your SynaBun data (memories, settings, logs) is in %APPDATA%\synabun: installing never changes it."
  !insertmacro SynaPhase "SynaBun ${VERSION} is installed."
  ${if} $SynaLog != ""
    DetailPrint "A full log of this install, with the time of each step, was saved to:"
    DetailPrint "  $SynaLog"
  ${endIf}
  !insertmacro SynaCloseLog
!macroend

; Per user, always: the assisted installer skips its "for all users / only for me" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  ; Only while the link handler still points at this copy, and never during an update.
  ${ifNot} ${isUpdated}
    ReadRegStr $R5 HKCU "${SYNABUN_PROTOCOL_KEY}\shell\open\command" ""
    StrCpy $R3 '"$INSTDIR\synabun-cli.exe"'
    StrLen $R2 $R3
    StrCpy $R4 $R5 $R2
    ; NSIS compares strings without regard to case, as Windows compares paths.
    ${if} $R4 == $R3
      DetailPrint "Removing the link handler synabun:// (HKCU\${SYNABUN_PROTOCOL_KEY})"
      DeleteRegKey HKCU "${SYNABUN_PROTOCOL_KEY}"
    ${endIf}
  ${endIf}
  ; %APPDATA%\synabun (memories, settings, logs) stays where it is.
  DetailPrint "Removing the program files, shortcuts and the entry in Settings > Apps"
  DetailPrint "Your SynaBun data (memories, settings, logs) stays in %APPDATA%\synabun."
  !insertmacro SynaCloseLog
!macroend

; ── The finish page names the installation log, and can open it ──
!ifndef BUILD_UNINSTALLER
  !ifndef MUI_FINISHPAGE_SHOWREADME
    !define MUI_FINISHPAGE_SHOWREADME ""
    !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
    !define MUI_FINISHPAGE_SHOWREADME_TEXT "Open the installation log (shows where the time went)"
    !define MUI_FINISHPAGE_SHOWREADME_FUNCTION SynaOpenLogFile
  !endif
  Function SynaOpenLogFile
    ${if} $SynaLog != ""
      ExecShell "open" "$SynaLog"
    ${endIf}
  FunctionEnd
!endif
