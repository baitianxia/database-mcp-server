@echo off
setlocal
if "%~1"=="" (
  echo 用法：build-windows.cmd ^<NodeRuntime目录或ZIP^>
  exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" -NodeRuntime "%~1"
exit /b %ERRORLEVEL%
