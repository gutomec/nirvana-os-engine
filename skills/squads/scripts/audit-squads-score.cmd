@echo off
setlocal
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
    bun "%~dp0audit-squads-score.ts" %*
    exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if %ERRORLEVEL%==0 (
    node --experimental-strip-types "%~dp0audit-squads-score.ts" %*
    exit /b %ERRORLEVEL%
)
echo [audit-squads-score] Bun or Node 22+ required.
exit /b 4
