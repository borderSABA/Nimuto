@echo off
setlocal EnableExtensions
title NIMT ONLINE - Environment Check

cd /d "%~dp0"

echo ==================================================
echo NIMT ONLINE - Environment Check
echo ==================================================
echo.
echo Project folder:
echo %CD%
echo.

if not exist "package.json" (
    echo [NG] package.json not found.
    echo     Extract the ZIP first. Do not run BAT inside the ZIP.
    echo.
) else (
    echo [OK] package.json
)

if not exist "wrangler.jsonc" (
    echo [NG] wrangler.jsonc not found.
    echo.
) else (
    echo [OK] wrangler.jsonc
)

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [NG] Node.js not found
) else (
    echo [OK] Node.js
    node --version
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [NG] npm not found
) else (
    echo [OK] npm
    call npm.cmd --version
)

echo.
echo ==================================================
echo Check finished.
echo ==================================================
echo.
pause
