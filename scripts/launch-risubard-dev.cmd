@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
title RisuBard Dev

node "scripts\dev-launcher.mjs"
set "LAUNCHER_EXIT_CODE=%ERRORLEVEL%"

if not "%LAUNCHER_EXIT_CODE%"=="0" (
  echo.
  echo RisuBard Dev 런처가 오류로 종료되었습니다.
  pause
)

endlocal & exit /b %LAUNCHER_EXIT_CODE%
