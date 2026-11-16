@echo off
rem Jam relay - run in this window (close the window to stop)
cd /d "%~dp0"
if not exist node_modules\ws (
  echo Installing dependencies...
  call npm install --omit=dev --no-fund --no-audit
)
if "%PORT%"=="" set PORT=3031
echo Starting Jam relay on port %PORT% ...
node jam-relay.js
pause
