; SynaBun: unpack the application straight into the install folder, with the
; progress shown on the install page, and confirm it is complete before going on.
; Keep this file ASCII (installer.nsh says why).
;
; electron-builder's own extractUsing7za (app-builder-lib 26.15.3,
; templates/nsis/include/extractAppPackage.nsh) first unpacks the ~1.5 GB payload
; into a temporary folder and then CopyFiles every file into place: a second
; full write that also makes the virus scanner read every file twice.
;
; The running SynaBun has already been closed (installer.nsh, synabun-stop.ps1)
; and the installed copy moved aside (synabun-upgrade.nsh), so SynaBun unpacks
; straight into $OUTDIR (the install folder) with Nsis7z::ExtractWithDetails: the
; page's status line and bar show "Unpacking SynaBun 45% (630 / 1402 MB)..." (the
; plugin writes no line per file), and nothing is copied a second time.
;
; Unpacking is done only when the window executable is in place AND the whole
; payload checks out against the build-time manifest (SynaVerifyPayload ->
; synabun-verify.ps1, one pass). Nothing is unpacked again by itself: a pass
; takes minutes (141 s for 25,077 files on the owner's Windows 11), and 2.0.7
; repeated four more of them over a complete folder before it said anything.
; What a failure does depends on what failed:
;   the check itself did not run (a PowerShell error, a launch failure, a
;   timeout; in 2.0.7 the script did not even parse)
;       the check, not the unpacking, runs once more. Still nothing: the files
;       SynaBun starts are checked at their sizes from the build
;       (SynaKeyFilesCheck); all there, the install goes on and the log says the
;       full check did not run; one missing or of another size, the install is
;       incomplete, as below, and the box says the check could not run
;   files missing or short (3), or SynaBun.exe not unpacked
;       the install is incomplete. Silent: stop with exit 2. Interactive: a box
;       that names the files, the free disk space and the installation log, with
;       Retry (unpack once more: the one chance to free disk space or close the
;       program that holds a file) or Cancel; when that second pass fails too,
;       a last box names the error and the log, and the installation stops
; Every stop puts the installed copy back (SynaRestoreEarlier) and ends with
; exit 2: the app's own update then keeps the installed version (win-swap.mjs
; restores on a non-zero exit).
;
; packaging/lib/desktop.mjs (extractMacroMatches) refuses to build the installer
; unless electron-builder still unpacks with the Nsis7z plugin this relies on and
; this macro still unpacks straight into the folder.
;
; installer.nsh includes this from customCheckAppRunning: electron-builder has
; defined its macro by then, and inserts it only later, in the same section.

!macroundef extractUsing7za
!macro extractUsing7za FILE
  ; How many times the payload was unpacked: never more than twice, the second only by the box's Retry.
  StrCpy $R1 0
  LoopExtract7za:
    IntOp $R1 $R1 + 1
    !insertmacro SynaPhase "Unpacking SynaBun into $OUTDIR"
    ClearErrors
    Nsis7z::ExtractWithDetails "${FILE}" "Unpacking SynaBun %s..."
    # The Nsis7z plugin reports no result (electron-builder's own macro never reads
    # one either), so success is the end state on disk.
    ${if} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
      !insertmacro SynaPhase "Checking the unpacked files against the list the build wrote"
      !insertmacro SynaVerifyPayload
      ; SynaPhase uses $R7: keep the result in $R9.
      StrCpy $R9 $R7
      ${if} $R9 != "0"
      ${andIf} $R9 != "3"
        ; The check did not run: run it, not the unpacking, once more.
        !insertmacro SynaPhase "The check did not run (result $R9); running the check once more"
        !insertmacro SynaVerifyPayload
        StrCpy $R9 $R7
      ${endif}
      StrCpy $R8 $R8 400
      ${if} $R9 == "0"
        !insertmacro SynaPhase "Every file is in place ($R8)"
        Goto DoneExtract7za
      ${endif}
      ${if} $R9 == "3"
        StrCpy $R8 "Files missing or incomplete: $R8"
      ${else}
        ; The check did not run twice: unpacking again cannot change that. The files SynaBun starts decide.
        !insertmacro SynaPhase "The check of the unpacked files did not run (result $R9): $R8"
        !insertmacro SynaKeyFilesCheck
        ${if} $R6 == ""
          !insertmacro SynaPhase "The files SynaBun starts are all in place at their size; going on without the full check"
          Goto DoneExtract7za
        ${endif}
        StrCpy $R8 "The installer's check of the files could not run (result $R9: $R8), and $R6."
      ${endif}
    ${else}
      StrCpy $R8 "SynaBun.exe was not unpacked into $OUTDIR."
    ${endif}
    !insertmacro SynaPhase "SynaBun could not be installed completely: $R8"
    # A silent run (the app's own update) never shows a box: it stops with a
    # non-zero exit, the installed copy back in place, so the updater keeps it.
    ${if} ${Silent}
      Call SynaRestoreEarlier
      SetErrorLevel 2
      Quit
    ${endif}
    !insertmacro SynaFreeSpace
    ${if} $R1 < 2
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "SynaBun could not be installed completely.$\r$\n$\r$\n$R8$\r$\n$\r$\nDisk: $R6$\r$\nInstallation log: $SynaLog$\r$\n$\r$\nRetry unpacks SynaBun once more (if the disk is full, or another program holds one of these files, deal with that first). Cancel stops the installation, and a SynaBun that was installed before is put back." /SD IDCANCEL IDRETRY LoopExtract7za
    ${else}
      MessageBox MB_OK|MB_ICONSTOP "SynaBun could not be installed completely, also after unpacking it a second time.$\r$\n$\r$\n$R8$\r$\n$\r$\nDisk: $R6$\r$\nInstallation log: $SynaLog$\r$\n$\r$\nThe installation stops, and a SynaBun that was installed before is put back." /SD IDOK
    ${endif}
    !insertmacro SynaPhase "The installation stops here"
    Call SynaRestoreEarlier
    SetErrorLevel 2
    Quit

  DoneExtract7za:
!macroend
