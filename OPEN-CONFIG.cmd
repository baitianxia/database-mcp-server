@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0OPEN-CONFIG.ps1" %*
set "exitCode=%ERRORLEVEL%"
exit /b %exitCode%
