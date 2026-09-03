@echo off
setlocal
where /q bun
if %ERRORLEVEL%==0 (
    bun "%~dp0glance.ts" %*
    exit /b
)
where /q node
if %ERRORLEVEL%==0 (
    node --experimental-strip-types "%~dp0glance.ts" %*
    exit /b
)
echo [glance] Bun or Node 22+ required. Install: powershell -c "irm bun.sh/install.ps1 ^| iex"
exit /b 4
