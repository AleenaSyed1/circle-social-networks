@echo off
cd /d "%~dp0"
echo Starting Circle... keep this window open.
start "" http://localhost:3000
node server.js
pause
