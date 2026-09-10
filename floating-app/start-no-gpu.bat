@echo off
rem Diagnostic launcher: forces software rendering (SwiftShader) instead of
rem the real GPU. Use this to test whether the card-overlap glitch is a GPU
rem/compositor driver bug rather than a layout bug.
set SRC=%~dp0
set DEST=%USERPROFILE%\ClaudeFloatingApp

if not exist "%DEST%" mkdir "%DEST%"
robocopy "%SRC%" "%DEST%" /E /XD node_modules /XF run.log .claude-session.json >nul

cd /d "%DEST%"
set ELECTRON_RUN_AS_NODE=
set CLAUDE_FLOATING_NO_GPU=1
"node_modules\electron\dist\electron.exe" . > run.log 2>&1
