@echo off
REM validate-squad.cmd — Windows wrapper. Runs the .ts via Bun (or Node 22+ as fallback).

where bun >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  bun "%~dp0validate-squad.ts" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node --experimental-strip-types --no-warnings "%~dp0validate-squad.ts" %*
  exit /b %ERRORLEVEL%
)

echo [validate-squad] FAIL: neither 'bun' nor 'node' found on PATH. >&2
exit /b 4
