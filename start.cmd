@echo off
rem Double-click launcher for start.ps1.
rem WHY: Windows blocks running .ps1 files by default ("running scripts is
rem disabled on this system"). -ExecutionPolicy Bypass allows just this one.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
