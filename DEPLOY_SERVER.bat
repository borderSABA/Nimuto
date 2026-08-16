@echo off
setlocal EnableExtensions
title NIMT ONLINE - Cloudflare Deploy

cd /d "%~dp0"

echo ==================================================
echo NIMT ONLINE - Cloudflare Deploy
echo ==================================================
echo.
echo Project folder:
echo %CD%
echo.

REM ZIP内から直接実行した場合などを検出
if not exist "package.json" (
    echo [ERROR] package.json was not found.
    echo.
    echo Please EXTRACT the ZIP file first,
    echo then run DEPLOY_SERVER.bat from the extracted folder.
    echo.
    goto :FAILED
)

if not exist "wrangler.jsonc" (
    echo [ERROR] wrangler.jsonc was not found.
    echo The project files are incomplete.
    echo.
    goto :FAILED
)

echo [1/5] Checking Node.js...
where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Install Node.js LTS, close this window,
    echo and run this BAT file again.
    echo.
    goto :FAILED
)
node --version
if errorlevel 1 goto :FAILED
echo.

echo [2/5] Checking npm...
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm.cmd was not found.
    echo Reinstall Node.js LTS with npm included.
    echo.
    goto :FAILED
)
call npm.cmd --version
if errorlevel 1 goto :FAILED
echo.

echo [3/5] Installing project dependencies...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo Check your internet connection and npm error above.
    echo.
    goto :FAILED
)
echo.

echo [4/5] Checking Wrangler / Cloudflare login...
call npx.cmd wrangler --version
if errorlevel 1 (
    echo.
    echo [ERROR] Wrangler could not start.
    echo.
    goto :FAILED
)

call npx.cmd wrangler whoami
if errorlevel 1 (
    echo.
    echo Cloudflare login is required.
    echo A browser window should open now.
    echo.
    call npx.cmd wrangler login
    if errorlevel 1 (
        echo.
        echo [ERROR] Cloudflare login failed.
        echo.
        goto :FAILED
    )
)
echo.

echo [5/5] Deploying...
call npx.cmd wrangler deploy
if errorlevel 1 (
    echo.
    echo [ERROR] Wrangler deploy failed.
    echo Read the error message shown above.
    echo.
    goto :FAILED
)

echo.
echo ==================================================
echo DEPLOY COMPLETED
echo ==================================================
echo Open the workers.dev URL shown above.
echo.
pause
exit /b 0

:FAILED
echo ==================================================
echo DEPLOY FAILED
echo ==================================================
echo.
echo This window will stay open so the error can be read.
echo If you send me the text shown above, I can fix that exact error.
echo.
pause
exit /b 1
