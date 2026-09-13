@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
echo.
echo Database MCP Server installer
echo Installing...
if not exist "%~dp0INSTALL.ps1" (
  echo INSTALL.ps1 was not found beside this launcher.
  pause
  exit /b 2
)
set "INSTALL_LOG=%TEMP%\database-mcp-server\INSTALL-%RANDOM%-%RANDOM%.log"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" -LogPath "%INSTALL_LOG%" %*
set "exitCode=%ERRORLEVEL%"
if "%exitCode%"=="0" goto success
echo.
echo Install failed. Exit code: %exitCode%.
echo PowerShell execution policy:
powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List"
if exist "%INSTALL_LOG%" (
  echo.
  echo Detailed error log:
  powershell.exe -NoLogo -NoProfile -Command "Get-Content -LiteralPath $env:INSTALL_LOG -Tail 80"
)
goto finish

:success
echo.
echo Install command completed.

:finish
echo.
if exist "%INSTALL_LOG%" echo Install log: %INSTALL_LOG%
echo Press any key to close this window.
pause >nul
exit /b %exitCode%
