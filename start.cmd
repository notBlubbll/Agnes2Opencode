@echo off
setlocal enabledelayedexpansion

taskkill /F /FI "WINDOWTITLE eq Agnes2Opencode" /T >nul 2>&1
timeout /t 1 /nobreak >nul

title Agnes2Opencode
cd /d "%~dp0"

echo ==================================================
echo  Agnes2Opencode
echo ==================================================
echo.

set "BUN_PATH=C:\WINDOWS\system32\config\systemprofile\.bun\bin"
set "PATH=%BUN_PATH%;%PATH%"

echo [1/3] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/3] Detecting runtime...
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
echo [3/3] Starting proxy...
echo.
echo ==================================================
echo  Proxy: http://localhost:8080
echo  Dashboard: http://localhost:8080/dashboard
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
