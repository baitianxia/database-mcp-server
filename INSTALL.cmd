@echo off
setlocal
echo.
echo Database MCP Server installer
echo Installing...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" %*
set "exitCode=%ERRORLEVEL%"
if "%exitCode%"=="0" goto success
echo.
echo Install failed. Exit code: %exitCode%.
echo PowerShell execution policy:
powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List"
goto finish

:success
echo.
echo Install command completed.

:finish
echo.
echo Press any key to close this window. Save the output above for troubleshooting.
pause >nul
exit /b %exitCode%
