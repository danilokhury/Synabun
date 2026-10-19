; SynaBun: the copy installed in this folder is moved aside in one rename
; (installer.nsh SynaMoveAside) instead of running its uninstaller.
; Keep this file ASCII (installer.nsh says why).
;
; electron-builder's uninstallOldVersion (app-builder-lib 26.15.3,
; templates/nsis/include/installUtil.nsh) runs the installed version's
; uninstaller with --updated: it renames every one of that copy's ~25,000 files
; into its own temporary folder, one at a time, and deletes them when it ends,
; all before this installer writes a single file. Moving the folder aside is one
; rename: the copy is removed with this installer's temporary folder when the
; installer closes, and until then it can be put back (SynaRestoreEarlier).
; The uninstaller would leave the shortcuts in place (electron-builder passes
; --keep-shortcuts), and the entry in Settings > Apps and the link handler are
; written again by this installer either way.
;
; electron-builder's macro is
;     !macro uninstallOldVersion ROOT_KEY
;       Push "${ROOT_KEY}"
;       Call uninstallOldVersion
;     !macroend
; and installSection.nsh follows it with handleUninstallResult, which reads the
; error flag and $R0 (0: done). When the registered copy was moved aside this
; leaves both as a finished uninstall would. Otherwise electron-builder's own
; function runs as before: a copy recorded in another folder, a folder the rename
; could not move, the app's own update (which has moved the copy aside itself,
; win-swap.mjs, and leaves nothing to move), and an unregistered copy that was
; moved aside (nothing is recorded, so their function finds nothing to run, or
; an uninstaller the registry still names elsewhere).
;
; packaging/lib/desktop.mjs (uninstallMacroMatches) refuses to build the installer
; when electron-builder's macro, or the way installSection.nsh uses it, is no
; longer that.
;
; installer.nsh includes this from customCheckAppRunning, after the running
; SynaBun is closed: electron-builder has defined its macro by then, and inserts
; it only later, in the same section.

!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  Call SynaMoveAside
  ${if} $SynaAside == ""
  ${orIf} $SynaRecorded == ""
    Push "${ROOT_KEY}"
    Call uninstallOldVersion
  ${else}
    ClearErrors
    StrCpy $R0 0
  ${endIf}
!macroend
