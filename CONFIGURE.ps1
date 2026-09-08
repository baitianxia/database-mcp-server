[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $env:USERPROFILE 'database-mcp-server'
$configRoot = Join-Path $projectRoot 'config'
$configPath = Join-Path $configRoot 'settings.json'
$packageRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$examplePath = Join-Path $packageRoot 'config\settings.example.json'
$installedExamplePath = Join-Path $configRoot 'settings.example.json'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
}

function Set-PrivateAcl([string]$Path) {
  try {
    $identity = if ($env:USERDOMAIN) { "$($env:USERDOMAIN)\$($env:USERNAME)" } else { $env:USERNAME }
    & icacls.exe $Path /inheritance:r /grant:r "${identity}:(F)" /c | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'ACL 设置未成功，请在文件属性的“安全”页限制为当前用户。' }
  } catch { Write-Warning '无法调用 icacls；请手动检查配置文件权限。' }
}

try {
  New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
  if (-not (Test-Path -LiteralPath $configPath)) {
    $sourceExample = if (Test-Path -LiteralPath $examplePath) { $examplePath } else { $installedExamplePath }
    if (-not (Test-Path -LiteralPath $sourceExample)) { throw '找不到 config\settings.example.json。' }
    Copy-Item -LiteralPath $sourceExample -Destination $configPath
    Write-Host "已创建配置模板：$configPath"
  } else {
    Write-Host "将打开现有配置：$configPath"
  }
  Set-PrivateAcl $configPath
  Start-Process -FilePath notepad.exe -ArgumentList @($configPath) -Wait
  Write-Host '配置文件已保存。请在 Claude Code 中调用 database_config_reload 和 database_environment_list，再按需传 environment 调用 database_ping。'
} catch {
  Write-Error ("配置失败：" + $_.Exception.Message)
  exit 1
}
