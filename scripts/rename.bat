@echo off
rem ==========================================================
rem  rename.bat - One-click project rename (Windows)
rem  Usage: rename.bat <new-slug> [--app-name "Name"] [--bundle-id com.x.y]
rem               [--dir] [--dry-run] [--force] [-y]
rem  Requires rename.ps1 in this folder. (macOS/Linux: rename.sh)
rem ==========================================================
setlocal
set "PS1PATH=%~dp0rename.ps1"
if not exist "%PS1PATH%" (
  echo [ERROR] rename.ps1 not found next to rename.bat
  exit /b 1
)
set "RENAME_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '%PS1PATH%'"
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
