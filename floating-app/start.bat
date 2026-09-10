@echo off
set SRC=%~dp0
set DEST=%USERPROFILE%\ClaudeFloatingApp

if not exist "%DEST%" mkdir "%DEST%"

rem Sync source files from the shared drive to a local copy. node_modules is
rem installed locally once and left alone (Electron can only launch its
rem GPU/renderer child processes from a binary that lives on local disk).
robocopy "%SRC%" "%DEST%" /E /XD node_modules /XF run.log .claude-session.json >nul

cd /d "%DEST%"
set ELECTRON_RUN_AS_NODE=
"node_modules\electron\dist\electron.exe" . > run.log 2>&1
