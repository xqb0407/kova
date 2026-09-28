@echo off
rem
rem build-release.bat - one-click release build
rem                   (deps -> sidecar -> frontend -> installer)
rem
rem Run from repo root:  scripts\build-release.bat
rem macOS / Linux use scripts\build-release.sh instead.
rem
rem Usage:
rem   build-release.bat [options]
rem
rem   --skip-install   skip bun install (when deps are up to date)
rem   --debug          produce a debug bundle (tauri build --debug, faster, self-test only)
rem   --allow-dev      continue even if a dev server is listening on port 3000
rem   --check          only run the environment preflight, no build
rem
rem Stages (5):
rem   1. preflight   bun / cargo / rustc on PATH, dev-server check
rem   2. deps        bun install (all workspaces, incl. plugins)
rem   3. sidecar     bun run build:sidecar  -> src-tauri\binaries\pi-agent-<triple>.exe
rem   4. frontend    bun run build          -> apps\desktop\out
rem   5. package     tauri build (beforeBuildCommand skipped, 3/4 already done)
rem
rem Artifacts: apps\desktop\src-tauri\target\release\bundle  (.msi / setup .exe)
rem Note: packaging != publishing. Publishing (version sync + tag + push):
rem   node scripts\release.mjs <version>
rem
setlocal enabledelayedexpansion
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fi"
cd /d "%REPO_ROOT%" || exit /b 1

set "SKIP_INSTALL=0"
set "PROF=release"
set "ALLOW_DEV=0"
set "CHECK_ONLY=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--skip-install" ( set "SKIP_INSTALL=1" & shift & goto parse )
if /i "%~1"=="--debug"        ( set "PROF=debug"     & shift & goto parse )
if /i "%~1"=="--allow-dev"    ( set "ALLOW_DEV=1"    & shift & goto parse )
if /i "%~1"=="--check"        ( set "CHECK_ONLY=1"   & shift & goto parse )
if /i "%~1"=="-h"             ( goto help )
if /i "%~1"=="--help"         ( goto help )
echo unknown option: %~1
goto help

:help
rem print header usage block (comment lines 3..26 of this file)
powershell -NoProfile -Command "Get-Content -LiteralPath '%~f0' | Select-Object -Skip 2 -First 24 | ForEach-Object { $_ -replace '^\s*rem ?', '' }"
exit /b 1

:parsed
echo.
echo ==^> 1/5 environment preflight
for %%t in (bun cargo rustc) do (
  where %%t >nul 2>&1 || ( echo missing tool: %%t -- see README "Environment" ^& exit /b 1 )
)
for /f "tokens=2" %%h in ('rustc -vV ^| findstr /b "host:"') do set "HOST_TRIPLE=%%h"
if "%HOST_TRIPLE%"=="" ( echo cannot read rustc host triple ^& exit /b 1 )
echo     rust toolchain ok ^(%HOST_TRIPLE%^)

if not "%ALLOW_DEV%"=="1" (
  netstat -ano | findstr /c:":3000 " | findstr /i "LISTENING" >nul 2>&1
  if not errorlevel 1 (
    echo dev server detected on port 3000. Stop ^'bun run tauri:dev^' / ^'bun run dev^' first,
    echo or pass --allow-dev. ^(next build rewrites the shared .next directory.^)
    exit /b 2
  )
)

if "%CHECK_ONLY%"=="1" (
  echo     preflight passed ^(--check, no build executed^)
  exit /b 0
)

echo.
echo ==^> 2/5 dependencies ^(bun install^)
if "%SKIP_INSTALL%"=="1" (
  echo     skipped via --skip-install
) else (
  call bun install || ( echo bun install failed ^& exit /b 1 )
)

echo.
echo ==^> 3/5 sidecar ^(pi-agent^)
call bun run build:sidecar || ( echo sidecar build failed ^& exit /b 1 )
if not exist "apps\desktop\src-tauri\binaries\pi-agent-%HOST_TRIPLE%.exe" (
  echo missing sidecar binary: apps\desktop\src-tauri\binaries\pi-agent-%HOST_TRIPLE%.exe
  exit /b 1
)
echo     sidecar ok

echo.
echo ==^> 4/5 frontend ^(next build^)
call bun run build || ( echo frontend build failed ^& exit /b 1 )
if not exist "apps\desktop\out" ( echo missing apps\desktop\out ^& exit /b 1 )
echo     frontend ok: apps\desktop\out

echo.
echo ==^> 5/5 package ^(tauri build, first run takes a while^)
set "OFFBEFORE=%TEMP%\kova-off-before.json"
echo {"build":{"beforeBuildCommand":""}}> "%OFFBEFORE%"
cd /d "%REPO_ROOT%\apps\desktop"
if exist "node_modules\.bin\tauri.cmd" (
  call "node_modules\.bin\tauri.cmd" build --config "%OFFBEFORE%" --%PROF%
) else (
  call bunx tauri build --config "%OFFBEFORE%" --%PROF%
)
set "TAURI_ERR=%ERRORLEVEL%"
del "%OFFBEFORE%" >nul 2>&1
cd /d "%REPO_ROOT%"
if not "%TAURI_ERR%"=="0" ( echo tauri build failed ^& exit /b 1 )

echo.
echo ==^> done: artifacts
dir /s /b "apps\desktop\src-tauri\target\%PROF%\bundle" 2>nul | findstr /i /e ".msi .exe"
if errorlevel 1 echo no installer found under apps\desktop\src-tauri\target\%PROF%\bundle
echo.
echo next steps:
echo   - self-test:   install the .msi / setup .exe above
echo   - publish:     node scripts\release.mjs ^<version^>   (version sync + git tag + push)
echo   - dev vs release data are isolated: release identifier com.kova.assistant,
echo     dev ^(via tauri:dev^) com.kova.assistant.dev - uninstalls never touch the other's data.
exit /b 0
