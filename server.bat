@echo off
setlocal
pushd "%~dp0"

if not defined PORT set "PORT=6001"
set "OPEN_BROWSER=1"

where pnpm >nul 2>&1
if errorlevel 1 call npm -g install pnpm
if errorlevel 1 goto exit

call pnpm install
if errorlevel 1 goto exit

node server\node\server-build-cache.cjs
if errorlevel 1 call pnpm run build
if errorlevel 1 goto exit

call pnpm run runserver

:exit
set "SERVER_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %SERVER_EXIT_CODE%
