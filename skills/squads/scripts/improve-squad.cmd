@echo off
setlocal
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
    bun "%~dp0improve-squad.ts" %*
    exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if %ERRORLEVEL%==0 (
    node --experimental-strip-types "%~dp0improve-squad.ts" %*
    exit /b %ERRORLEVEL%
)
echo [improve-squad] Bun or Node 22+ required.
exit /b 4
