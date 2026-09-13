[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$configRoot = Join-Path (Join-Path $env:USERPROFILE 'database-mcp-server') 'config'
try {
  New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
  Start-Process -FilePath explorer.exe -ArgumentList @($configRoot)
} catch {
  Write-Error ("无法打开配置目录：" + $_.Exception.Message)
  exit 1
}
