@echo off
setlocal enabledelayedexpansion

taskkill /F /FI "WINDOWTITLE eq Agnes2Opencode" /T >nul 2>&1
timeout /t 1 /nobreak >nul

cd /d "%~dp0"

:: Detect port from config first (before any echo using it)
set "PORT=8082"
set "CONFIG_FILE=%~dp0.config\config.json"
if exist "%CONFIG_FILE%" (
    for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$c=Get-Content '%CONFIG_FILE%' -Raw ^| ConvertFrom-Json; $l=$c.LISTEN_ADDR; if($l -match ':(?<p>\d+)$'){Write-Output $matches['p']}else{Write-Output '8082'}"`) do set "PORT=%%a"
)

title Agnes2Opencode

echo ==================================================
echo  Agnes2Opencode
echo ==================================================
echo.

set "BUN_PATH=C:\WINDOWS\system32\config\systemprofile\.bun\bin"
set "PATH=%BUN_PATH%;%PATH%"

echo [1/4] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/4] Installing dependencies...
call npm i
if exist "%~dp0package-lock.json" del /q "%~dp0package-lock.json"
title Agnes2Opencode
echo.

echo [3/4] Detecting runtime...
where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Runtime: Bun
    set "RUNTIME=bun"
    goto :start
)
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Runtime: Node.js
    set "RUNTIME=node"
    goto :start
)
echo [ERROR] Neither Bun nor Node.js found in PATH.
echo        Install Node: https://nodejs.org
echo        Install Bun:  https://bun.sh
pause
exit

:start
echo [4/4] Starting proxy...
echo.
echo ==================================================
echo  Proxy: http://localhost:%PORT%
echo  Dashboard: http://localhost:%PORT%/dashboard
echo ==================================================
echo.

if "%RUNTIME%"=="bun" (
    bun run proxy.js
) else (
    node proxy.js
)

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 0 exit /b 0
if %EXIT_CODE% equ -1073741819 exit /b 0
echo.
echo [ERROR] Proxy exited with code %EXIT_CODE%
timeout /t 5 /nobreak >nul
exit /b %EXIT_CODE%
