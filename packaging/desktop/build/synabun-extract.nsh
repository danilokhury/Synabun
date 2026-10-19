; SynaBun: unpack the application straight into the install folder, with the
; progress shown on the install page, and confirm it is complete before going on.
;
; electron-builder's own extractUsing7za (app-builder-lib 26.15.3,
; templates/nsis/include/extractAppPackage.nsh) first unpacks the ~1.5 GB payload
; into a temporary folder and then CopyFiles every file into place — a second
; full write that also makes the virus scanner read every file twice. On a large
; payload that double write is the biggest part of a slow install.
;
; The running SynaBun has already been closed (installer.nsh, synabun-stop.ps1),
; so the install folder's files are free: SynaBun unpacks straight into $OUTDIR
; (the install folder) with Nsis7z::ExtractWithDetails, so the page shows
; "Unpacking SynaBun 45%..." instead of standing still, and nothing is copied a
; second time. Unpacking is "done" only when the window executable is in place
; AND the whole payload checks out against the build-time manifest
; (SynaVerifyPayload -> synabun-verify.ps1): a locked file or a full disk can
; leave SynaBun.exe present while other files are missing or short, and the old
; version has already been removed, so that must not pass. A failure retries a
; few times, then asks the user (Retry/Cancel) — or, in a silent run (the app's
; own update), stops with a non-zero exit so the updater rolls back; it never
; shows a blocking box.
;
; packaging/lib/desktop.mjs (extractMacroMatches) refuses to build the installer
; unless electron-builder still unpacks with the Nsis7z plugin this relies on and
; this macro still unpacks straight into the folder.
;
; installer.nsh includes this from customCheckAppRunning: electron-builder has
; defined its macro by then, and inserts it only later, in the same section.

!macroundef extractUsing7za
!macro extractUsing7za FILE
  StrCpy $R1 0
  LoopExtract7za:
    IntOp $R1 $R1 + 1
    ClearErrors
    Nsis7z::ExtractWithDetails "${FILE}" "Unpacking SynaBun %s..."
    # Done only when the window executable is in place AND the whole payload
    # matches the manifest. The Nsis7z plugin reports no result (electron-builder's
    # own macro never reads one either), so success is the end state on disk.
    ${if} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
      !insertmacro SynaPhase "Checking the unpacked files are all there"
      !insertmacro SynaVerifyPayload
      ${if} $R7 == "0"
        Goto DoneExtract7za
      ${endif}
      DetailPrint "The unpacked SynaBun is incomplete: $R8"
    ${else}
      StrCpy $R8 `SynaBun.exe was not unpacked`
      DetailPrint `Can't modify "${PRODUCT_NAME}"'s files.`
    ${endif}

    ${if} $R1 < 5
      # Try a few times before asking for a user action (a file may be let go).
      Sleep 1000
      Goto LoopExtract7za
    ${endif}
    # Out of retries. A silent run (the app's own update) never shows a box; it
    # stops with a non-zero exit so the updater keeps the old version.
    ${if} ${Silent}
      SetErrorLevel 2
      Quit
    ${endif}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "SynaBun could not be installed completely:$\r$\n$R8$\r$\n$\r$\nFree some disk space or close whatever is using the files, then choose Retry — or Cancel to stop." /SD IDCANCEL IDRETRY LoopExtract7za
    SetErrorLevel 2
    Quit

  DoneExtract7za:
!macroend
