@echo off
setlocal
where /q bun
if %ERRORLEVEL%==0 (
    bun "%~dp0audit-squads-score.ts" %*
    exit /b
)
where /q node
if %ERRORLEVEL%==0 (
    node --experimental-strip-types "%~dp0audit-squads-score.ts" %*
    exit /b
)
echo [audit-squads-score] Bun or Node 22+ required.
exit /b 4
