@echo off
rem ============================================================
rem  Command Code Proxy - one-click launcher (just double-click)
rem  Runs only inside this folder; writes nothing to C:.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe parses .bat in the
rem  console ANSI codepage, so non-ASCII bytes can corrupt parsing.
rem  chcp 65001 below makes the Chinese UI printed by proxy.mjs
rem  render correctly.
rem ============================================================
setlocal
chcp 65001 >nul 2>nul
title Command Code Proxy
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul && set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18+ from https://nodejs.org
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0proxy.mjs" (
  echo.
  echo   [ERROR] proxy.mjs was not found next to this script.
  echo   Keep start.bat and proxy.mjs in the same folder.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0proxy.mjs" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo   Proxy exited with code %EXITCODE%
  echo.
  pause
)

endlocal
