; SynaBun - what the Windows installer does beyond electron-builder's own
; (included through nsis.include by packaging/lib/desktop.mjs).
;
; Keep this file, and every file it includes or embeds, ASCII. makensis reads
; these as UTF-8, but the PowerShell helpers it embeds are read by Windows
; PowerShell 5.1 in the ANSI code page, where a UTF-8 em dash becomes three other
; characters and the last one ends a string: SynaBun 2.0.7's synabun-verify.ps1
; never parsed, and every install failed after unpacking.
; packaging/tests/windows-scripts.test.mjs refuses any byte outside ASCII.
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
;            to %TEMP%\SynaBun-install-<yyyymmdd-hhmmss>.log, named on the finish
;            page, with the helpers' own lines and what each answered (the log is
;            closed while a helper runs: NSIS opens it without sharing writes):
;            that is how a slow or failed install shows where the time went
;   stop     SynaBun is not one process: the window (SynaBun.exe), its server on
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
;            folder the registry names, or the synabun-desktop folder earlier
;            test builds used): a SynaBun installed by npm or Git runs
;            from elsewhere and is left alone. An interactive install asks once
;            before it closes a running SynaBun; a silent update does it quietly
;            (the app has already begun to quit by then)
;   replace  the copy installed in this folder is moved aside in one rename
;            (SynaMoveAside, through synabun-upgrade.nsh) instead of running its
;            uninstaller, which renames and deletes its 25,000 files one by one;
;            so is a complete copy an install left there unregistered (it failed
;            before writing its uninstaller).
;            It goes into this installer's temporary folder and is removed with
;            it when the installer closes; when the install cannot finish it is
;            put back (SynaRestoreEarlier). The app's own update has already
;            moved the copy aside (win-swap.mjs), and finds nothing to move
;   check    after unpacking, the whole payload is compared with the build's
;            manifest (synabun-verify.ps1); a check that cannot run falls back to
;            the files SynaBun starts, at their sizes from the build (SynaKeyFiles)
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

; -- The installation log, every step with the seconds since the start --
Var SynaLog        ; the log file's path (also named on the finish page)
Var SynaLogHandle  ; its open handle while the installer runs (0 when none)
Var SynaTick0      ; GetTickCount at the first step, to time the rest
Var SynaRoots      ; the install folder(s) the stop helper may close, joined with a bar
Var SynaProbe      ; the window executable, to test the files are free after the close
!ifndef BUILD_UNINSTALLER
  Var SynaRecorded ; the install folder the registry records for the installed copy ("" when none)
  Var SynaAside    ; where the installed copy was moved for this install ("" when it was not)
!endif

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
    ; Two digits each, so the names sort by time (2.0.7 wrote 20261019-3432 for 03:04:32).
    IntFmt $3 "%02u" $3
    IntFmt $5 "%02u" $5
    IntFmt $6 "%02u" $6
    IntFmt $7 "%02u" $7
    IntFmt $8 "%02u" $8
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
; The helpers append their own lines to the same file, so every write goes to
; its end (FileSeek), never over them. Uses $R7: never name $R7 in TEXT.
!macro SynaPhase TEXT
  !insertmacro SynaOpenLog
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $R7
  IntOp $R7 $R7 - $SynaTick0
  IntOp $R7 $R7 / 1000
  SetDetailsPrint both
  DetailPrint "[+$R7s] ${TEXT}"
  ${if} $SynaLogHandle <> 0
    FileSeek $SynaLogHandle 0 END
    FileWrite $SynaLogHandle "+$R7s  ${TEXT}$\r$\n"
  ${endIf}
!macroend

!macro SynaCloseLog
  ${if} $SynaLogHandle <> 0
    FileClose $SynaLogHandle
    StrCpy $SynaLogHandle 0
  ${endIf}
!macroend

; The helpers (synabun-stop.ps1, synabun-verify.ps1) append their own lines to
; the log. NSIS holds it open without sharing writes, so their appends failed
; and nothing they wrote ever reached it (2.0.7): the log is closed while a
; helper runs and opened again after it (append; every write seeks to the end).
!macro SynaLogPause
  ${if} $SynaLogHandle <> 0
    FileClose $SynaLogHandle
    StrCpy $SynaLogHandle 0
  ${endIf}
!macroend

!macro SynaLogResume
  ${if} $SynaLogHandle == 0
  ${andIf} $SynaLog != ""
    ClearErrors
    FileOpen $SynaLogHandle "$SynaLog" a
    ${if} ${errors}
      StrCpy $SynaLogHandle 0
    ${endIf}
  ${endIf}
!macroend

; A line in the log only (no time, not on the page): what a helper answered.
; Leaves every register alone, $R7 included.
!macro SynaLogLine TEXT
  ${if} $SynaLogHandle <> 0
    FileSeek $SynaLogHandle 0 END
    FileWrite $SynaLogHandle "      ${TEXT}$\r$\n"
  ${endIf}
!macroend

; The folders a close may touch, and the file to test for being free afterward.
; A macro (expanded late, where the registry keys and the executable name are
; defined), so the functions below can stay clear of those defines: a function
; body is compiled in the shared header, before multiUser.nsh/common.nsh define
; them. The folders are this install folder, plus an earlier desktop install
; folder the registry names (a copy that was moved, or the pre-desktop layout):
; a SynaBun outside these folders (an npm or Git install) is never touched.
!macro SynaSetTargets
  StrCpy $SynaRoots "$INSTDIR"
  ReadRegStr $R5 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !ifndef BUILD_UNINSTALLER
    StrCpy $SynaRecorded $R5
  !endif
  ${if} $R5 != ""
  ${andIf} $R5 != "$INSTDIR"
    StrCpy $SynaRoots "$SynaRoots|$R5"
  ${endIf}
  ReadRegStr $R5 HKCU "${SYNABUN_LEGACY_UNINSTALL_KEY}" InstallLocation
  ${if} $R5 != ""
  ${andIf} $R5 != "$INSTDIR"
    StrCpy $SynaRoots "$SynaRoots|$R5"
  ${endIf}
  !ifndef BUILD_UNINSTALLER
    ; The folder test builds before 2026-10-18 installed into: a copy left there
    ; (registered or not) runs on the same data, so it is closed too.
    StrCpy $R5 "$LOCALAPPDATA\Programs\synabun-desktop"
    ${if} $R5 != "$INSTDIR"
    ${andIf} ${FileExists} "$R5\${APP_EXECUTABLE_FILENAME}"
      StrCpy $SynaRoots "$SynaRoots|$R5"
    ${endIf}
  !endif
  StrCpy $SynaProbe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

; -- Close a running SynaBun --
;
; Defined once for the installer and once (un.) for the uninstaller, so each can
; call it. SynaSetTargets has filled $SynaRoots and $SynaProbe; this writes the
; helper and runs it: detect first so a prompt comes before anything is closed,
; then the graceful-then-forced close, with Retry/Cancel if something is still
; holding the files. synabun-stop.ps1 does the real work; this decides what to say.
!macro SynaStopBody UN
Function ${UN}SynaStopExec
  ; A whole-helper timeout (60 s) so a hung PowerShell never stalls the install;
  ; a failed launch or a timeout pops a non-numeric code ("error"/"timeout"),
  ; which is not "0" and so counts as a failure below.
  !insertmacro SynaLogPause
  nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\synabun-stop.ps1"'
  Pop $R7  ; "0" closed and files free, "3" still running / a file is locked, "2" could not look, "error"/"timeout" the helper did not run
  Pop $R8  ; the one-line summary, or nsExec's own text on a launch error / timeout
  !insertmacro SynaLogResume
  !insertmacro SynaLogLine "synabun-stop.ps1 answered $R7: $R8"
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
  ;    Anything but a clean "nothing running" (0) warns in an interactive run:
  ;    a "busy" (3) or a helper that could not tell (2 / error / timeout). Fail
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
  ;    closed and the files free (exit 0). Every other result (still busy (3),
  ;    could not look (2), the helper did not run (error / timeout)) is a
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

; -- Replace the installed copy in one step (installer only) --
!ifndef BUILD_UNINSTALLER
; Move the copy installed in this folder aside in one rename, instead of
; running its uninstaller (which renames every one of its files into a temporary
; folder and then deletes them, one by one, before a single new file is
; written). It goes into this installer's own temporary folder: the same disk
; (TEMP and the install folder are both in the user's profile), and Windows
; removes it with that folder when the installer closes. Only a SynaBun copy is
; ever moved: the one the registry records in this very folder, with its window
; executable there; or, when the registry records none, a complete desktop copy
; an install left here without registering it (it stopped before writing its
; uninstaller: 2.0.5's and 2.0.7's failed checks did). A folder that holds
; anything else is left alone, and so is a copy the rename cannot move (a file
; still held): electron-builder's own way follows. Sets $SynaAside ("" when
; nothing was moved).
Function SynaMoveAside
  ${if} $SynaAside != ""
    Return
  ${endIf}
  ${ifNot} ${FileExists} "$SynaProbe"
    Return
  ${endIf}
  StrCpy $R2 ""
  ${if} $SynaRecorded == $INSTDIR
    StrCpy $R2 "the installed SynaBun"
  ${endIf}
  ${if} $SynaRecorded == ""
  ${andIf} ${FileExists} "$INSTDIR\resources\synabun-package.json"
  ${andIf} ${FileExists} "$INSTDIR\resources\app.asar"
    StrCpy $R2 "the SynaBun an unfinished install left here (never registered)"
  ${endIf}
  ${if} $R2 == ""
    Return
  ${endIf}
  ; The installer works in the install folder (.onInit), and Windows does not
  ; rename a folder a process works in: leave it first.
  SetOutPath "$PLUGINSDIR"
  StrCpy $R3 0
  synaAsideTry:
    IntOp $R3 $R3 + 1
    ClearErrors
    Rename "$INSTDIR" "$PLUGINSDIR\earlier-copy"
    ${ifNot} ${errors}
      StrCpy $SynaAside "$PLUGINSDIR\earlier-copy"
      !insertmacro SynaPhase "Moved $R2 aside in one step (it is removed when this installer closes, or put back if the install cannot finish)"
      Return
    ${endIf}
    ${if} $R3 < 3
      Sleep 500
      Goto synaAsideTry
    ${endIf}
  SetOutPath "$INSTDIR"
  !insertmacro SynaPhase "$R2 could not be moved aside in one step (a file in it is held): electron-builder's own way follows"
FunctionEnd

; Put the earlier copy back when this install does not finish: whatever was
; unpacked goes into the temporary folder (removed with it), and the earlier copy
; back into the install folder. When it cannot go back there it is kept in
; %TEMP%\SynaBun-earlier-<n>, which the temporary folder's removal never reaches,
; and the log names it.
Function SynaRestoreEarlier
  ${if} $SynaAside == ""
    Return
  ${endIf}
  SetOutPath "$PLUGINSDIR"
  StrCpy $R3 0
  synaRestoreTry:
    IntOp $R3 $R3 + 1
    ClearErrors
    ${if} ${FileExists} "$INSTDIR\*.*"
      Rename "$INSTDIR" "$PLUGINSDIR\unfinished-copy-$R3"
    ${endIf}
    ${ifNot} ${errors}
      Rename "$SynaAside" "$INSTDIR"
      ${ifNot} ${errors}
        StrCpy $SynaAside ""
        !insertmacro SynaPhase "The SynaBun that was installed before is back in $INSTDIR"
        Return
      ${endIf}
    ${endIf}
    ${if} $R3 < 5
      Sleep 1000
      Goto synaRestoreTry
    ${endIf}
  System::Call 'kernel32::GetTickCount()i.s'
  Pop $R3
  ClearErrors
  Rename "$SynaAside" "$TEMP\SynaBun-earlier-$R3"
  ${ifNot} ${errors}
    StrCpy $SynaAside ""
    !insertmacro SynaPhase "The SynaBun that was installed before could not be put back in $INSTDIR: it is kept in $TEMP\SynaBun-earlier-$R3"
  ${else}
    !insertmacro SynaPhase "The SynaBun that was installed before could not be put back in $INSTDIR: it is in $SynaAside until this installer closes"
  ${endIf}
FunctionEnd
!endif

; -- Check what was unpacked --

; Check the unpacked payload against the build-time manifest (synabun-verify.ps1,
; embedded). Used by synabun-extract.nsh right after unpacking, so a locked file
; or a full disk never leaves an incomplete install that only checked SynaBun.exe.
; $R7 = "0" complete, "3" missing/short files, "2" could not check,
; anything else (a PowerShell error, "error", "timeout") the check did not run.
!macro SynaVerifyPayload
  File "/oname=$PLUGINSDIR\synabun-verify.ps1" "${BUILD_RESOURCES_DIR}\synabun-verify.ps1"
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_VERIFY_DIR", t "$OUTDIR")i'
  System::Call 'kernel32::SetEnvironmentVariable(t "SYNABUN_VERIFY_LOG", t "$SynaLog")i'
  !insertmacro SynaLogPause
  nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\synabun-verify.ps1"'
  Pop $R7
  Pop $R8
  !insertmacro SynaLogResume
  !insertmacro SynaLogLine "synabun-verify.ps1 answered $R7: $R8"
!macroend

; One file SynaBun starts, at its size from the build (SynaKeyFiles, written into
; synabun-installer-facts.nsh): $R6 names the first that is not ("" while all are).
!macro SynaKeyFile FILE SIZE
  ${if} $R6 == ""
    ClearErrors
    FileOpen $R5 "$OUTDIR\${FILE}" r
    ${if} ${errors}
      StrCpy $R6 "${FILE} is missing"
    ${else}
      FileSeek $R5 0 END $R4
      FileClose $R5
      ${if} $R4 != "${SIZE}"
        StrCpy $R6 "${FILE} has $R4 bytes, not ${SIZE}"
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

; The check when the full one cannot run: every file SynaBun starts, at its size.
; $R6 = "" when all are there, otherwise what is wrong with the first that is not.
!macro SynaKeyFilesCheck
  StrCpy $R6 ""
  !ifmacrodef SynaKeyFiles
    !insertmacro SynaKeyFiles
  !else
    ${ifNot} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R6 "${APP_EXECUTABLE_FILENAME} is missing"
    ${endIf}
  !endif
!macroend

; The free space of the install folder's disk, as words for a message: $R6
; ("" when it cannot be read).
!macro SynaFreeSpace
  StrCpy $R6 ""
  StrCpy $R4 $INSTDIR 3
  System::Call 'kernel32::GetDiskFreeSpaceExW(w R4, *l .R5, *l .R3, *l .R3) i .R2'
  ${if} $R2 <> 0
    System::Int64Op $R5 / 1048576
    Pop $R5
    StrCpy $R6 "$R5 MB free on $R4"
  ${endIf}
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
    ; The installed copy is moved aside in one step, not uninstalled file by file (synabun-upgrade.nsh).
    !ifmacrodef uninstallOldVersion
      !include "synabun-upgrade.nsh"
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
  ; electron-builder's own steps follow: a copy of this installer for the next
  ; update's smaller download, the uninstaller, Settings > Apps, the shortcuts.
  !insertmacro SynaPhase "Saving this installer for the next update, writing the uninstaller, the entry in Settings > Apps and the shortcuts"
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
  ${if} $SynaAside != ""
    DetailPrint "The SynaBun installed before is removed in the background when this installer closes."
  ${endIf}
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

; -- The finish page names the installation log, and can open it --
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
