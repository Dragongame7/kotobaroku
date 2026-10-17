@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo Bundled Node.js is missing. Extract the entire release ZIP before starting.
  pause
  exit /b 1
)
"runtime\node.exe" "scripts\start-client.mjs"
if errorlevel 1 (
  echo Application stopped with an error. See the message above.
  pause
  exit /b 1
)
