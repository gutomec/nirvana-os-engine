@echo off
setlocal
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
    bun "%~dp0init-project.ts" %*
    exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if %ERRORLEVEL%==0 (
    node --experimental-strip-types "%~dp0init-project.ts" %*
    exit /b %ERRORLEVEL%
)
echo [init-project] Bun or Node 22+ required. Install: powershell -c "irm bun.sh/install.ps1 ^| iex"
exit /b 4
