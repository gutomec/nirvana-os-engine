@echo off
REM activate-squad.cmd — Windows wrapper. Runs the .ts via Bun (or Node 22+ as fallback).
REM Cross-platform: this file is for Windows native (cmd.exe / PowerShell).

where bun >/dev/null 2>/dev/null
if %ERRORLEVEL% EQU 0 (
  bun "%~dp0activate-squad.ts" %*
  exit /b %ERRORLEVEL%
)

where node >/dev/null 2>/dev/null
if %ERRORLEVEL% EQU 0 (
  node --experimental-strip-types --no-warnings "%~dp0activate-squad.ts" %*
  exit /b %ERRORLEVEL%
)

echo [activate-squad] FAIL: neither 'bun' nor 'node' found on PATH. >&2
echo Install Bun: powershell -c "irm bun.sh/install.ps1 ^| iex" >&2
exit /b 4
