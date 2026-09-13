@echo off
setlocal
set "installLogDirectory=%USERPROFILE%\database-mcp-server\logs"
set "installLog=%installLogDirectory%\install.log"
if not exist "%installLogDirectory%\." mkdir "%installLogDirectory%" >nul 2>&1
if not exist "%installLogDirectory%\." goto runWithoutLog
type nul > "%installLog" 2>nul
if errorlevel 1 goto runWithoutLog

echo 正在安装数据库助手，请稍候...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" %* > "%installLog" 2>&1
set "exitCode=%ERRORLEVEL%"
if "%exitCode%"=="0" goto showLog
powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List" >> "%installLog" 2>&1

:showLog
type "%installLog%"
goto report

:runWithoutLog
set "installLog="
echo 无法写入安装日志，将直接显示安装输出。
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" %*
set "exitCode=%ERRORLEVEL%"
if "%exitCode%"=="0" goto report
powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List"

:report
if "%exitCode%"=="0" goto done
echo.
echo 安装失败，错误码 %exitCode%。
if not "%installLog%"=="" echo 详细输出已保存到："%installLog%"
echo 请把上面的原始错误和执行策略列表提供给维护者或管理员。
pause

:done
exit /b %exitCode%
