@echo off
title NexLink demo devices
cd /d "%~dp0apps\server"
echo Starting 5 simulated NexLink devices. Close this window to stop them.
echo New devices appear in NexLink under Devices - Pending approval.
echo.
node scripts\demo.mjs 5
pause
