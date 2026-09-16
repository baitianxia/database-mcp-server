[CmdletBinding()]
param(
  [switch]$KeepOlderVersions,
  [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$logDirectory = Join-Path (Join-Path $env:USERPROFILE 'database-mcp-server') 'logs'
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $logDirectory 'install.log'
} else {
  $LogPath = [IO.Path]::GetFullPath($LogPath)
}
$logPath = $LogPath
$transcriptStarted = $false
try {
  $logParent = Split-Path -Parent $logPath
  if ($logParent) { New-Item -ItemType Directory -Force -Path $logParent | Out-Null }
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

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label,
    [AllowNull()][string]$InputText = $null
  )
  $output = @()
  $exitCode = 1
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 turns redirected native stderr into ErrorRecord
    # objects. Keep it visible and in the transcript, but decide success from
    # the native exit code.
    $ErrorActionPreference = 'Continue'
    if ($null -eq $InputText) {
      $output = @(& $Executable @Arguments 2>&1)
    } else {
      $output = @($InputText | & $Executable @Arguments 2>&1)
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($line in $output) {
    if ($null -ne $line) { Write-Host ([string]$line) }
  }
  if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode" }
  return $output
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

function Format-NativeFailure {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)]$Result
  )
  $lines = @($Result.Output | ForEach-Object { if ($null -ne $_) { [string]$_ } })
  $details = ($lines -join "`n").Trim()
  if ($details.Length -gt 2000) { $details = $details.Substring($details.Length - 2000) }
  if ($details) { return "$Label failed with exit code $($Result.ExitCode): $details" }
  return "$Label failed with exit code $($Result.ExitCode)."
}

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

function Get-ClaudeUserConfigPath {
  $configDirectory = [string]$env:CLAUDE_CONFIG_DIR
  if ([string]::IsNullOrWhiteSpace($configDirectory)) {
    $configDirectory = [string]$env:USERPROFILE
  } else {
    if (-not [IO.Path]::IsPathRooted($configDirectory)) {
      throw 'CLAUDE_CONFIG_DIR 必须是绝对路径。'
    }
    $configDirectory = [IO.Path]::GetFullPath($configDirectory)
  }
  return (Join-Path $configDirectory '.claude.json')
}

function Assert-ClaudeUserMcp {
  param(
    [Parameter(Mandatory = $true)][string]$UserConfigPath,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath
  )
  $payload = Read-Utf8Json $UserConfigPath
  $serversProperty = $payload.PSObject.Properties['mcpServers']
  $entryProperty = if ($serversProperty -and $serversProperty.Value) {
    $serversProperty.Value.PSObject.Properties['database-mcp']
  } else { $null }
  if ($null -eq $entryProperty -or $null -eq $entryProperty.Value) {
    throw 'Claude Code 用户配置中没有 database-mcp 条目。'
  }
  $entry = $entryProperty.Value
  $typeProperty = $entry.PSObject.Properties['type']
  if ($typeProperty -and [string]$typeProperty.Value -ne 'stdio') {
    throw 'Claude Code database-mcp 条目不是 stdio 传输。'
  }
  if (-not [string]::Equals([string]$entry.command, $NodePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Claude Code database-mcp 条目的 Node 路径不正确。'
  }
  $actualArgs = @($entry.args | ForEach-Object { [string]$_ })
  if ($actualArgs.Count -ne 1 -or
      -not [string]::Equals($actualArgs[0], $EntryPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Claude Code database-mcp 条目的入口参数不正确。'
  }
  $envProperty = $entry.PSObject.Properties['env']
  $configProperty = if ($envProperty -and $envProperty.Value) {
    $envProperty.Value.PSObject.Properties['DATABASE_CONFIG_PATH']
  } else { $null }
  if ($null -eq $configProperty -or [string]$configProperty.Value -ne $ConfigPath) {
    throw 'Claude Code database-mcp 条目的 DATABASE_CONFIG_PATH 不正确。'
  }
}

function Register-ClaudeCodeMcp {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$UserConfigPath
  )
  $claude = Resolve-ClaudeCode
  if (-not $claude) {
    throw '未找到现有的 Claude Code（claude.exe 或 claude.cmd）。安装器不会安装或下载 Claude Code；请先让当前用户可以运行 claude 后重试。'
  }
  $versionResult = Invoke-NativeCapture $claude @('--version')
  if ($versionResult.ExitCode -ne 0) {
    throw (Format-NativeFailure 'Claude Code version check' $versionResult)
  }
  Write-Host ("Claude Code: {0}" -f ((@($versionResult.Output) -join ' ').Trim()))

  if (Test-Path -LiteralPath $UserConfigPath -PathType Container) {
    throw "Claude Code 用户配置路径不是普通文件：$UserConfigPath"
  }
  $configExisted = Test-Path -LiteralPath $UserConfigPath -PathType Leaf
  $hadServer = $false
  if ($configExisted) {
    $existing = Read-Utf8Json $UserConfigPath
    $serversProperty = $existing.PSObject.Properties['mcpServers']
    $hadServer = $false
    if ($serversProperty -and $serversProperty.Value) {
      $hadServer = $null -ne $serversProperty.Value.PSObject.Properties['database-mcp']
    }
  }
  $backupPath = Join-Path ([IO.Path]::GetTempPath()) ("database-mcp-server-claude-{0}.bak" -f ([guid]::NewGuid().ToString('N')))
  if ($configExisted) { [IO.File]::Copy($UserConfigPath, $backupPath, $false) }

  try {
    $remove = Invoke-NativeCapture $claude @('mcp', 'remove', 'database-mcp', '--scope', 'user')
    if ($remove.ExitCode -eq 0) {
      Write-Host '已清理旧的 Claude Code 用户级 database-mcp 条目。'
    } elseif (-not $hadServer -and $remove.ExitCode -eq 1) {
      Write-Host '未发现旧的 Claude Code database-mcp 条目，继续首次注册。'
    } else {
      throw (Format-NativeFailure 'claude mcp remove' $remove)
    }

    $addArguments = @(
      'mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'database-mcp',
      '--env', "DATABASE_CONFIG_PATH=$ConfigPath", '--', $NodePath, $EntryPath
    )
    $add = Invoke-NativeCapture $claude $addArguments
    if ($add.ExitCode -ne 0) {
      throw (Format-NativeFailure 'claude mcp add' $add)
    }
    $get = Invoke-NativeCapture $claude @('mcp', 'get', 'database-mcp')
    if ($get.ExitCode -ne 0) {
      throw (Format-NativeFailure 'claude mcp get' $get)
    }
    Assert-ClaudeUserMcp $UserConfigPath $NodePath $EntryPath $ConfigPath
    Write-Host 'Claude Code 用户级 database-mcp 注册和读取验证已完成。'
    return $UserConfigPath
  } catch {
    $failure = $_.Exception.Message
    try {
      if ($configExisted) {
        [IO.File]::Copy($backupPath, $UserConfigPath, $true)
      } elseif (Test-Path -LiteralPath $UserConfigPath -PathType Leaf) {
        Remove-Item -LiteralPath $UserConfigPath -Force
      }
    } catch {
      throw "Claude Code MCP 注册失败：$failure；恢复用户配置也失败：$($_.Exception.Message)"
    }
    throw "Claude Code MCP 注册失败：$failure；已恢复原用户配置。"
  } finally {
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Test-RetryableDirectoryMoveError {
  param(
    [Parameter(Mandatory = $true)]
    [Management.Automation.ErrorRecord]$ErrorRecord
  )
  if ($ErrorRecord.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied) {
    return $true
  }
  $errorId = [string]$ErrorRecord.FullyQualifiedErrorId
  if ($errorId -match '(?i)(UnauthorizedAccess|MoveDirectoryItemIOError|MoveFileInfoItemUnauthorizedAccessError)') {
    return $true
  }
  $exception = $ErrorRecord.Exception
  while ($null -ne $exception) {
    if ($exception -is [UnauthorizedAccessException] -or $exception -is [IO.IOException]) {
      return $true
    }
    $exception = $exception.InnerException
  }
  return $false
}

function Move-DirectoryWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$OperationLabel,
    [ValidateRange(2, 100)][int]$MaximumAttempts = 25
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "$OperationLabel 的源目录不存在：$Source"
  }
  if (Test-Path -LiteralPath $Destination) {
    throw "$OperationLabel 的目标路径已存在：$Destination"
  }
  $delayMilliseconds = 250
  for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
    try {
      # Directory.Move performs a same-volume rename. Unlike Move-Item, a
      # denied rename does not create a partial destination directory, which
      # keeps a retry unambiguous on Windows PowerShell 5.1.
      [IO.Directory]::Move($Source, $Destination)
      if (Test-Path -LiteralPath $Source) {
        throw "$OperationLabel 返回成功但源目录仍存在：$Source"
      }
      if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
        throw "$OperationLabel 返回成功但目标目录不存在：$Destination"
      }
      if ($attempt -gt 1) {
        Write-Host "$OperationLabel 已等待占用释放，继续安装。"
      }
      return
    } catch {
      $moveError = $_
      $sourcePresent = Test-Path -LiteralPath $Source -PathType Container
      $destinationPresent = Test-Path -LiteralPath $Destination -PathType Container
      if (-not $sourcePresent -and $destinationPresent) {
        Write-Host "$OperationLabel 已完成，继续安装。"
        return
      }
      if (-not $sourcePresent -or $destinationPresent) {
        throw "$OperationLabel 状态不明确，未继续重试。sourcePresent=$sourcePresent; destinationPresent=$destinationPresent; error=$($moveError.Exception.Message)"
      }
      if (-not (Test-RetryableDirectoryMoveError $moveError)) { throw }
      if ($attempt -ge $MaximumAttempts) {
        throw "$OperationLabel 被安全软件或其他进程持续占用；安装器已重试 $MaximumAttempts 次仍无法完成。原始错误：$($moveError.Exception.Message)"
      }
      if ($attempt -eq 1) {
        Write-Host "$OperationLabel 正被安全软件或其他进程占用，安装器将自动重试。"
      } elseif (($attempt % 5) -eq 0) {
        Write-Host "$OperationLabel 仍在等待占用释放（已重试 $attempt 次）。"
      }
      Start-Sleep -Milliseconds $delayMilliseconds
      $delayMilliseconds = [Math]::Min($delayMilliseconds * 2, 5000)
    }
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
    throw "无法按 UTF-8 读取 JSON：$Path；$($_.Exception.Message)"
  }
  try {
    return ($text | ConvertFrom-Json)
  } catch {
    throw "JSON 无效：$Path；$($_.Exception.Message)；请重新解压完整 ZIP，不要运行被编辑器或网页改写的 JSON 文件。"
  }
}

try {
  Write-Host '[1/6] Reading release manifest...'
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
  Write-Host '[2/6] Checking package structure...'
  Assert-NoReparsePoint $packageRoot
  Assert-NoForbiddenContent $packageRoot
  Write-Host '[3/6] Verifying package files...'
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
  Write-Host '[4/6] Checking bundled runtime and MCP entry...'
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
    Write-Host '[5/6] Copying files and running MCP smoke check...'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -Path (Join-Path $payload '*') -Destination $stage -Recurse -Force
    $nodeTarget = Join-Path $stage $nodeRelative
    $appTarget = Join-Path $stage $appRelative
    Assert-PeX64 $nodeTarget
    Invoke-NativeChecked $nodeTarget @('--check', $appTarget) 'MCP entry syntax check' | Out-Null
    $probe = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"installer-probe","version":"1"}}}'
    $probeOutput = @(Invoke-NativeChecked $nodeTarget @($appTarget) 'MCP startup smoke check' $probe)
    if (($probeOutput -join "`n") -notmatch '"name"\s*:\s*"database-mcp"') {
      throw 'MCP 启动冒烟检查失败。'
    }

    if (Test-Path -LiteralPath $versionRoot) {
      $backup = Join-Path $versionsRoot ".rollback-$version-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
      Move-DirectoryWithRetry -Source $versionRoot -Destination $backup -OperationLabel '备份当前版本'
    }
    Move-DirectoryWithRetry -Source $stage -Destination $versionRoot -OperationLabel '发布暂存版本'
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
    $claudeConfigPath = Get-ClaudeUserConfigPath
    $state.claudeConfigPath = $claudeConfigPath
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
    Write-Host '[6/6] Registering database-mcp in Claude Code user scope...'
    $null = Register-ClaudeCodeMcp -NodePath $nodeInstalled -EntryPath $appInstalled -ConfigPath $configPath -UserConfigPath $claudeConfigPath
    Write-Host "数据库助手 $version 已安装到 $projectRoot。"
    Write-Host "配置文件：$configPath"
    Write-Host "Claude Code 用户级 MCP 已注册：$claudeConfigPath"
    Write-Host '请重启 Claude Code，在任意项目运行 /mcp 确认 database-mcp；如需填写配置，先运行 CONFIGURE.cmd。'
  } catch {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if ($versionMoved -and -not $backup -and (Test-Path -LiteralPath $versionRoot)) {
      Remove-Item -LiteralPath $versionRoot -Recurse -Force
    }
    if ($backup -and (Test-Path -LiteralPath $backup)) {
      if (Test-Path -LiteralPath $versionRoot) { Remove-Item -LiteralPath $versionRoot -Recurse -Force }
      Move-DirectoryWithRetry -Source $backup -Destination $versionRoot -OperationLabel '回滚旧版本'
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
