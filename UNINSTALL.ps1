[CmdletBinding()]
param(
  [switch]$RemoveConfiguration
)

$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $env:USERPROFILE 'database-mcp-server'

function Resolve-ClaudeCode {
  foreach ($name in @('claude.exe', 'claude.cmd', 'claude')) {
    $commands = @(Get-Command -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandType -eq 'Application' })
    foreach ($command in $commands) {
      $path = if ($command.Source) { [string]$command.Source } else { [string]$command.Path }
      if ($path) { return $path }
    }
  }
  $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $fallback -PathType Leaf) {
    return (Resolve-Path -LiteralPath $fallback).Path
  }
  return $null
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $output = @()
  $exitCode = 1
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    try {
      $output = @(& $Executable @Arguments 2>&1)
      $exitCode = $LASTEXITCODE
    } catch {
      $output = @($_.Exception.Message)
      $exitCode = 1
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{ Output = @($output); ExitCode = $exitCode }
}

function Remove-ClaudeCodeMcp {
  $claude = Resolve-ClaudeCode
  if (-not $claude) {
    Write-Warning '未找到 Claude Code，跳过用户级 database-mcp 注销。'
    return
  }
  $configDirectory = if ([string]::IsNullOrWhiteSpace([string]$env:CLAUDE_CONFIG_DIR)) {
    [string]$env:USERPROFILE
  } else {
    if (-not [IO.Path]::IsPathRooted([string]$env:CLAUDE_CONFIG_DIR)) {
      throw 'CLAUDE_CONFIG_DIR 必须是绝对路径。'
    }
    [IO.Path]::GetFullPath([string]$env:CLAUDE_CONFIG_DIR)
  }
  $userConfigPath = Join-Path $configDirectory '.claude.json'
  $hadServer = $false
  if (Test-Path -LiteralPath $userConfigPath -PathType Leaf) {
    try {
      $payload = Get-Content -LiteralPath $userConfigPath -Raw | ConvertFrom-Json
      $serversProperty = $payload.PSObject.Properties['mcpServers']
      if ($serversProperty -and $serversProperty.Value) {
        $hadServer = $null -ne $serversProperty.Value.PSObject.Properties['database-mcp']
      }
    } catch {
      throw "无法读取 Claude Code 用户配置：$userConfigPath；$($_.Exception.Message)"
    }
  }
  $result = Invoke-NativeCapture $claude @('mcp', 'remove', 'database-mcp', '--scope', 'user')
  if ($result.ExitCode -eq 0) {
    Write-Host '已从 Claude Code 用户级配置注销 database-mcp。'
    return
  }
  if (-not $hadServer -and $result.ExitCode -eq 1) {
    Write-Host 'Claude Code 用户级配置中没有 database-mcp，继续卸载。'
    return
  }
  $details = (@($result.Output) -join "`n").Trim()
  if ($details.Length -gt 2000) { $details = $details.Substring($details.Length - 2000) }
  throw "Claude Code database-mcp 注销失败，退出码 $($result.ExitCode)：$details"
}

try {
  Remove-ClaudeCodeMcp
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
