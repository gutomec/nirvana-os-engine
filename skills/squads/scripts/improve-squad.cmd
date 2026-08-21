@echo off
setlocal
where /q bun
if %ERRORLEVEL%==0 (
    bun "%~dp0improve-squad.ts" %*
    exit /b %ERRORLEVEL%
)
where /q node
if %ERRORLEVEL%==0 (
    node --experimental-strip-types "%~dp0improve-squad.ts" %*
    exit /b %ERRORLEVEL%
)
echo [improve-squad] Bun or Node 22+ required.
exit /b 4
