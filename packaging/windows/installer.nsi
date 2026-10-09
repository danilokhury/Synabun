; SynaBun — Windows installer (NSIS 3, Unicode)
;
; Built by packaging/lib/bundle.mjs:
;   makensis /DAPP_VERSION=2.0.0 /DAPP_VERSION_QUAD=2.0.0.0 /DAPP_DIR=<bundle folder>
;            /DOUT_FILE=<setup.exe> [/DAPP_ICON=<ico>] installer.nsi
;
; Per-user: no administrator rights, files in %LOCALAPPDATA%\Programs\SynaBun.
; User data lives in %APPDATA%\synabun and is never touched, by install,
; upgrade or uninstall.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef APP_VERSION
  !error "APP_VERSION is not defined"
!endif
!ifndef APP_DIR
  !error "APP_DIR is not defined"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is not defined"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${UnStrStr}

!define APP_NAME "SynaBun"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SynaBun"
!define PROTOCOL_KEY "Software\Classes\synabun"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
BrandingText "${APP_NAME} ${APP_VERSION}"

!ifdef APP_VERSION_QUAD
  VIProductVersion "${APP_VERSION_QUAD}"
  VIAddVersionKey "ProductName" "${APP_NAME}"
  VIAddVersionKey "FileDescription" "${APP_NAME} installer"
  VIAddVersionKey "FileVersion" "${APP_VERSION}"
  VIAddVersionKey "ProductVersion" "${APP_VERSION}"
  VIAddVersionKey "LegalCopyright" "The SynaBun Authors"
!endif

!ifdef APP_ICON
  !define MUI_ICON "${APP_ICON}"
  !define MUI_UNICON "${APP_ICON}"
!endif
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\SynaBun.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start SynaBun"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; The application's files cannot be replaced or removed while it runs.
!macro StopIfRunning
  ${If} ${FileExists} "$INSTDIR\resources\runtime\node.exe"
    ClearErrors
    FileOpen $0 "$INSTDIR\resources\runtime\node.exe" a
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "SynaBun is running. Use Apps > Stop Server in SynaBun before updating or uninstalling, then try again. Closing the PWA window leaves the server running."
      Abort
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

Section "SynaBun" SecMain
  SectionIn RO
  !insertmacro StopIfRunning

  ; The application is replaced as a whole, so nothing of an older version stays behind.
  RMDir /r "$INSTDIR\resources"
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\SynaBun.exe"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  ; synabun:// links (the Start Server button of the offline page). This is the
  ; value SynaBun itself writes on every start (lib/start-launcher.js).
  WriteRegStr HKCU "${PROTOCOL_KEY}" "" "URL:SynaBun Protocol"
  WriteRegStr HKCU "${PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${PROTOCOL_KEY}\shell\open\command" "" '"$INSTDIR\SynaBun.exe" "launcher" "--via=protocol" "--" "%1"'

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "The SynaBun Authors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\SynaBun.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://synabun.ai"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  !insertmacro StopIfRunning

  ; Remove the link handler only while it still points at this copy.
  ReadRegStr $0 HKCU "${PROTOCOL_KEY}\shell\open\command" ""
  ${UnStrStr} $1 $0 "$INSTDIR\SynaBun.exe"
  ${If} $1 != ""
    DeleteRegKey HKCU "${PROTOCOL_KEY}"
  ${EndIf}

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\SynaBun.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\NOTICE"
  Delete "$INSTDIR\THIRD-PARTY-LICENSES.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
  ; %APPDATA%\synabun (memories, settings) stays where it is.
SectionEnd
