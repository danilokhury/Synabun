@echo off
setlocal enableextensions
title SynaBun Updater

rem ───────────────────────────────────────────────────────
rem Windows shim for the cross-platform updater (updater.mjs).
rem Invoked by the running SynaBun server via:
rem   start "" "<install>\updater.cmd" --payload payload.json
rem
rem We use a shim instead of spawning node directly so cmd's
rem quoting rules don't mangle the command line, and so the
rem window stays open for the user to read npm output even
rem if node exits unexpectedly.
rem ───────────────────────────────────────────────────────

set "SCRIPT_DIR=%~dp0"
set "EXIT_CODE=0"

rem %~dp0 ends with backslash. updater.mjs lives next to this file.
node "%SCRIPT_DIR%updater.mjs" %* --no-hold
set EXIT_CODE=%ERRORLEVEL%

echo.
if %EXIT_CODE%==0 (
  echo [Update finished. Press any key to close this window.]
) else (
  echo [Update exited with code %EXIT_CODE%. Press any key to close this window.]
)
pause >nul

endlocal ^& exit /b %EXIT_CODE%
