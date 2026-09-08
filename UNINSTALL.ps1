[CmdletBinding()]
param(
  [switch]$RemoveConfiguration
)

$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $env:USERPROFILE 'database-mcp-server'
try {
  if (-not (Test-Path -LiteralPath $projectRoot)) {
    Write-Host '数据库助手尚未安装。'
    exit 0
  }
  $versions = Join-Path $projectRoot 'versions'
  if (Test-Path -LiteralPath $versions) { Remove-Item -LiteralPath $versions -Recurse -Force }
  foreach ($name in @('current.json', 'claude-code.mcp.json')) {
    $target = Join-Path $projectRoot $name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  }
  if ($RemoveConfiguration) {
    $config = Join-Path $projectRoot 'config'
    if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config -Recurse -Force }
    Write-Host '配置也已删除。'
  } else {
    Write-Host "已卸载运行时；配置保留在 $(Join-Path $projectRoot 'config')."
  }
  if ($RemoveConfiguration -and (Test-Path -LiteralPath $projectRoot)) {
    $remaining = @(Get-ChildItem -LiteralPath $projectRoot -Force)
    if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $projectRoot -Force }
  }
} catch {
  Write-Error ("卸载失败：" + $_.Exception.Message)
  exit 1
}
