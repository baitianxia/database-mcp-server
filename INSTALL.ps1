[CmdletBinding()]
param(
  [switch]$KeepOlderVersions
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$logDirectory = Join-Path (Join-Path $env:USERPROFILE 'database-mcp-server') 'logs'
$logPath = Join-Path $logDirectory 'install.log'
$transcriptStarted = $false
try {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  Start-Transcript -LiteralPath $logPath -Force | Out-Null
  $transcriptStarted = $true
} catch {
  # Installation must still run when the project log directory is unavailable.
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
}

function Set-PrivateAcl([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    $identity = if ($env:USERDOMAIN) { "$($env:USERDOMAIN)\$($env:USERNAME)" } else { $env:USERNAME }
    & icacls.exe $Path /inheritance:r /grant:r "${identity}:(F)" /c | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "无法自动设置 $Path 的 ACL，请在文件属性中限制为当前用户。" }
  } catch {
    Write-Warning "无法调用 icacls 设置 $Path 的 ACL。"
  }
}

function Get-Sha256Hex([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [IO.File]::OpenRead($Path)
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}

function Assert-NoReparsePoint([string]$Root) {
  $items = @(Get-Item -LiteralPath $Root) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "安装包包含不允许的 reparse point: $($item.FullName)"
    }
  }
}

function Assert-PeX64([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw '内置运行时不是有效的 PE 文件。' }
  $offset = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($offset -lt 0 -or $offset + 6 -gt $bytes.Length -or $bytes[$offset] -ne 0x50 -or $bytes[$offset + 1] -ne 0x45) { throw '内置运行时 PE 头无效。' }
  $machine = [BitConverter]::ToUInt16($bytes, $offset + 4)
  if ($machine -ne 0x8664) { throw '内置运行时不是 Windows x64 架构。' }
}

function Assert-RelativePayloadPath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or [IO.Path]::IsPathRooted($Value) -or
      $Value -match '(^|[\\/])\.\.([\\/]|$)' -or $Value -match '[:*?"<>|]') {
    throw "$Label 必须是 payload 目录内的相对路径。"
  }
  return $Value.Replace('/', '\')
}

function Assert-NoForbiddenContent([string]$Root) {
  $forbidden = @('.git', '.env', 'settings.json', 'pnpm-lock.yaml', 'npm.cmd', 'npx.cmd', 'pnpm.cmd', 'corepack', '.pnpm', '.bin')
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Recurse -Force)) {
    if ($forbidden -contains $item.Name -or $item.Name -like '.env*') {
      throw "安装包包含禁止内容：$($item.FullName)"
    }
  }
}

function Verify-Hashes([string]$Root) {
  $hashFile = Join-Path $Root 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $hashFile)) { throw '缺少 SHA256SUMS.txt，已停止安装。' }
  $lines = [IO.File]::ReadAllLines($hashFile)
  $entries = @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith('#') })
  $total = $entries.Count
  $checked = 0
  Write-Host "Verifying package integrity ($total files); do not close this window."
  foreach ($line in $entries) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { throw "SHA256SUMS.txt 包含无法解析的行。" }
    $expected = $Matches[1].ToLowerInvariant()
    $relative = $Matches[2].Trim()
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $relative))
    $rootWithSlash = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootWithSlash, [StringComparison]::OrdinalIgnoreCase)) { throw "哈希清单包含包外路径。" }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "哈希清单引用的文件不存在: $relative" }
    $actual = Get-Sha256Hex $candidate
    if ($actual -ne $expected) { throw "文件完整性校验失败: $relative" }
    $checked++
    if ($checked -eq 1 -or $checked -eq $total -or $checked % 100 -eq 0) {
      Write-Host ("Checked {0}/{1} files" -f $checked, $total)
    }
  }
}

function Write-AtomicJson([string]$Path, $Value) {
  $temp = "$Path.$PID.tmp"
  Write-Utf8NoBom $temp (($Value | ConvertTo-Json -Depth 12) + "`r`n")
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Read-Utf8Json([string]$Path) {
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  try {
    $text = [IO.File]::ReadAllText($Path, $utf8)
  } catch {
    throw "无法按 UTF-8 读取发布清单：$Path；$($_.Exception.Message)"
  }
  try {
    return ($text | ConvertFrom-Json)
  } catch {
    throw "发布清单 JSON 无效：$($_.Exception.Message)；请重新解压完整 ZIP，不要运行被编辑器或网页改写的 release-manifest.json。"
  }
}

try {
  Write-Host '[1/5] Reading release manifest...'
  $manifestPath = Join-Path $packageRoot 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw '缺少 release-manifest.json，已停止安装。' }
  $manifest = Read-Utf8Json $manifestPath
  $version = [string]$manifest.version
  if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw '发布清单中的版本号无效。' }
  if ([string]$manifest.product -ne 'database-mcp-server') { throw '发布清单 product 不匹配。' }
  if ([string]$manifest.target.os -ne 'windows' -or [string]$manifest.target.architecture -ne 'x64') {
    throw '发布清单目标必须是 Windows x64。'
  }
  $manifestConfigPath = ([string]$manifest.config.path).Replace('/', '\')
  if ($manifestConfigPath -and $manifestConfigPath -ne '%USERPROFILE%\database-mcp-server\config\settings.json') {
    throw '发布清单配置路径不属于 database-mcp-server。'
  }
  $manifestStatus = [string]$manifest.status
  if ($manifestStatus -notin @('CANDIDATE_UNVERIFIED', 'VERIFIED')) { throw '发布清单状态无效。' }
  Write-Host '[2/5] Checking package structure...'
  Assert-NoReparsePoint $packageRoot
  Assert-NoForbiddenContent $packageRoot
  Write-Host '[3/5] Verifying package files...'
  Verify-Hashes $packageRoot

  $payload = Join-Path $packageRoot 'payload'
  $nodeRelativeValue = if ($manifest.runtime.nodePath) { [string]$manifest.runtime.nodePath } else { 'runtime\node.exe' }
  $appRelativeValue = if ($manifest.runtime.entryPath) { [string]$manifest.runtime.entryPath } else { 'app\src\index.js' }
  $nodeRelative = Assert-RelativePayloadPath $nodeRelativeValue 'runtime.nodePath'
  $appRelative = Assert-RelativePayloadPath $appRelativeValue 'runtime.entryPath'
  if ($nodeRelative -notmatch '^runtime[\\/]') { throw 'runtime.nodePath 必须位于 payload/runtime。' }
  if ($appRelative -notmatch '^app[\\/]') { throw 'runtime.entryPath 必须位于 payload/app。' }
  $nodeSource = Join-Path $payload $nodeRelative
  $appSource = Join-Path $payload $appRelative
  if (-not (Test-Path -LiteralPath $nodeSource -PathType Leaf)) { throw "缺少 Windows x64 Node 运行时: $nodeRelative" }
  if (-not (Test-Path -LiteralPath $appSource -PathType Leaf)) { throw "缺少 MCP 入口: $appRelative" }
  Write-Host '[4/5] Checking bundled runtime and MCP entry...'
  Assert-PeX64 $nodeSource
  if ($manifest.runtime.nodeSha256) {
    $expectedNodeHash = [string]$manifest.runtime.nodeSha256
    if ($expectedNodeHash -notmatch '^[0-9a-fA-F]{64}$') { throw '发布清单中的 nodeSha256 无效。' }
    $actualNodeHash = Get-Sha256Hex $nodeSource
    if ($actualNodeHash -ne $expectedNodeHash.ToLowerInvariant()) { throw 'Node 运行时 SHA-256 与发布清单不匹配。' }
  }

  $projectRoot = Join-Path $env:USERPROFILE 'database-mcp-server'
  $versionsRoot = Join-Path $projectRoot 'versions'
  $configRoot = Join-Path $projectRoot 'config'
  New-Item -ItemType Directory -Force -Path $versionsRoot, $configRoot | Out-Null
  $stage = Join-Path $versionsRoot ".staging-$PID-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
  $versionRoot = Join-Path $versionsRoot $version
  $configPath = Join-Path $configRoot 'settings.json'
  $installedExample = Join-Path $configRoot 'settings.example.json'
  $exampleExisted = Test-Path -LiteralPath $installedExample
  $currentPath = Join-Path $projectRoot 'current.json'
  $oldCurrent = if (Test-Path -LiteralPath $currentPath) { Get-Content -LiteralPath $currentPath -Raw } else { $null }
  $registrationPath = Join-Path $projectRoot 'claude-code.mcp.json'
  $oldRegistration = if (Test-Path -LiteralPath $registrationPath) { Get-Content -LiteralPath $registrationPath -Raw } else { $null }
  $backup = $null
  $versionMoved = $false
  $exampleCreated = $false

  try {
    Write-Host '[5/5] Copying files and running MCP smoke check...'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -Path (Join-Path $payload '*') -Destination $stage -Recurse -Force
    $nodeTarget = Join-Path $stage $nodeRelative
    $appTarget = Join-Path $stage $appRelative
    Assert-PeX64 $nodeTarget
    & $nodeTarget --check $appTarget
    if ($LASTEXITCODE -ne 0) { throw 'MCP 入口语法检查失败。' }
    $probe = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"installer-probe","version":"1"}}}'
    $probeOutput = $probe | & $nodeTarget $appTarget 2>$null
    if ($LASTEXITCODE -ne 0 -or (($probeOutput -join "`n") -notmatch '"name"\s*:\s*"database-mcp"')) {
      throw 'MCP 启动冒烟检查失败。'
    }

    if (Test-Path -LiteralPath $versionRoot) {
      $backup = Join-Path $versionsRoot ".rollback-$version-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
      Move-Item -LiteralPath $versionRoot -Destination $backup
    }
    Move-Item -LiteralPath $stage -Destination $versionRoot
    $versionMoved = $true
    if (-not (Test-Path -LiteralPath $configPath)) {
      $example = Join-Path $packageRoot 'config\settings.example.json'
      if (-not (Test-Path -LiteralPath $example)) { throw '缺少配置模板 config\settings.example.json。' }
      if (-not (Test-Path -LiteralPath $installedExample)) { Copy-Item -LiteralPath $example -Destination $installedExample; $exampleCreated = $true }
      Write-Host "尚未创建真实配置；请运行 CONFIGURE.cmd，将模板填写到 $configPath。"
    }
    if (Test-Path -LiteralPath $configPath) { Set-PrivateAcl $configPath }

    $nodeInstalled = Join-Path $versionRoot $nodeRelative
    $appInstalled = Join-Path $versionRoot $appRelative
    $state = [ordered]@{
      product = 'database-mcp-server'
      displayName = '数据库助手（当前支持 MySQL）'
      version = $version
      installedAt = [DateTime]::UtcNow.ToString('o')
      nodePath = $nodeInstalled
      entryPath = $appInstalled
      configPath = $configPath
      status = $manifestStatus
    }
    Write-AtomicJson $currentPath $state
    $registration = [ordered]@{ mcpServers = [ordered]@{ 'database-mcp' = [ordered]@{
      type = 'stdio'; command = $nodeInstalled; args = @($appInstalled); env = @{ DATABASE_CONFIG_PATH = $configPath }
    } } }
    Write-AtomicJson $registrationPath $registration

    if (-not $KeepOlderVersions) {
      Get-ChildItem -LiteralPath $versionsRoot -Directory -Force |
        Where-Object { $_.Name -ne $version -and $_.Name -notlike '.rollback-*' -and $_.Name -notlike '.staging-*' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 1 |
        Remove-Item -Recurse -Force
    }
    Write-Host "数据库助手 $version 已安装到 $projectRoot。"
    Write-Host "配置文件：$configPath"
    Write-Host '请运行 CONFIGURE.cmd（如需填写配置），然后在 Claude Code 中重新加载 database-mcp。'
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if ($versionMoved -and -not $backup -and (Test-Path -LiteralPath $versionRoot)) {
      Remove-Item -LiteralPath $versionRoot -Recurse -Force
    }
    if ($backup -and (Test-Path -LiteralPath $backup)) {
      if (Test-Path -LiteralPath $versionRoot) { Remove-Item -LiteralPath $versionRoot -Recurse -Force }
      Move-Item -LiteralPath $backup -Destination $versionRoot
    }
    if ($exampleCreated -and -not $exampleExisted -and (Test-Path -LiteralPath $installedExample)) {
      Remove-Item -LiteralPath $installedExample -Force
    }
    if ($oldCurrent) { Write-Utf8NoBom $currentPath $oldCurrent }
    elseif (Test-Path -LiteralPath $currentPath) { Remove-Item -LiteralPath $currentPath -Force }
    if ($oldRegistration) { Write-Utf8NoBom $registrationPath $oldRegistration }
    elseif (Test-Path -LiteralPath $registrationPath) { Remove-Item -LiteralPath $registrationPath -Force }
    throw
  }
} catch {
  $message = "安装未完成：$($_.Exception.Message)"
  if ($transcriptStarted) { $message += "；日志：$logPath" }
  Write-Error $message
  exit 1
} finally {
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
