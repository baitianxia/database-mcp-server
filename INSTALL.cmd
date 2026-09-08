@echo off
setlocal
set "logDirectory=%USERPROFILE%\database-mcp-server\logs"
set "logFile=%logDirectory%\install.log"
if not exist "%logDirectory%" mkdir "%logDirectory%" 2>nul
type nul > "%logFile%" 2>nul
if errorlevel 1 goto runWithoutLog

echo 正在安装数据库助手，请稍候...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" %* > "%logFile%" 2>&1
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List" >> "%logFile%" 2>&1
type "%logFile%"
goto finish

:runWithoutLog
set "logFile="
echo 无法写入安装日志，将直接显示安装输出。
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" %*
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List"

:finish
if not "%exitCode%"=="0" (
  echo.
  echo 安装失败，错误码 %exitCode%。
  if defined logFile echo 详细输出已保存到："%logFile%"
  echo 请把上面的原始错误和执行策略列表提供给维护者或管理员。
  pause
)
exit /b %exitCode%
