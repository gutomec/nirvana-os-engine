@echo off
REM init-business.cmd — Windows wrapper. Runs the .ts via Bun (or Node 22+ as fallback).

where bun >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  bun "%~dp0init-business.ts" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node --experimental-strip-types --no-warnings "%~dp0init-business.ts" %*
  exit /b %ERRORLEVEL%
)

echo [init-business] FAIL: neither 'bun' nor 'node' found on PATH. >&2
exit /b 4
