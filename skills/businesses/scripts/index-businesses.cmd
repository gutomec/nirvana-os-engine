@echo off
REM index-businesses.cmd — Windows wrapper. Runs the .ts via Bun (or Node 22+ as fallback).
REM Cross-platform: this file is for Windows native (cmd.exe / PowerShell).

where /q bun
if %ERRORLEVEL% EQU 0 (
  bun "%~dp0index-businesses.ts" %*
  exit /b
)

where /q node
if %ERRORLEVEL% EQU 0 (
  node --experimental-strip-types --no-warnings "%~dp0index-businesses.ts" %*
  exit /b
)

echo [index-businesses] FAIL: neither 'bun' nor 'node' found on PATH. >&2
echo Install Bun: powershell -c "irm bun.sh/install.ps1 ^| iex" >&2
exit /b 4
