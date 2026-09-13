@echo off
setlocal
echo.
echo 数据库助手安装程序
echo 正在安装，请稍候...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1" %*
set "exitCode=%ERRORLEVEL%"
if "%exitCode%"=="0" goto success
echo.
echo 安装失败，错误码 %exitCode%。
echo 当前 PowerShell 执行策略：
powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List"
goto finish

:success
echo.
echo 安装命令执行完成。

:finish
echo.
echo 安装窗口将在按键后关闭；如需排查，请先保存上面的完整错误信息。
pause >nul
exit /b %exitCode%
