@echo off
title Scrum Desk
cd /d "%~dp0"
set PORT=3001
start "" http://localhost:3001
node server.js
pause
