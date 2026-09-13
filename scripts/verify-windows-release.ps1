[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$zip = (Resolve-Path $ZipPath).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) "database-mcp-verify-$PID"

function Assert-NoReparsePoint([string]$Root) {
  $items = @(Get-Item -LiteralPath $Root) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "发现 reparse point: $($item.FullName)"
    }
  }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $details = ($errors | ForEach-Object { $_.Message }) -join ' | '
    throw "PowerShell 语法检查失败：$Path；$details"
  }
}

function Assert-PeX64([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Node 运行时不是有效的 PE 文件。' }
  $offset = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($offset -lt 0 -or $offset + 6 -gt $bytes.Length -or $bytes[$offset] -ne 0x50 -or $bytes[$offset + 1] -ne 0x45) { throw 'Node 运行时 PE 头无效。' }
  if ([BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x8664) { throw 'Node 运行时不是 Windows x64。' }
}

function Assert-RelativePayloadPath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or [IO.Path]::IsPathRooted($Value) -or
      $Value -match '(^|[\\/])\.\.([\\/]|$)' -or $Value -match '[:*?"<>|]') {
    throw "$Label 必须是 payload 目录内的相对路径。"
  }
  return $Value.Replace('/', '\')
}

function Relative-Name([string]$Root, [string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $full = [IO.Path]::GetFullPath($Path)
  return $full.Substring($rootFull.Length).Replace('\', '/')
}

try {
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
  $roots = @(Get-ChildItem -LiteralPath $temp -Force)
  if ($roots.Count -ne 1 -or -not $roots[0].PSIsContainer) { throw 'ZIP 必须只有一个顶层目录。' }
  $root = $roots[0].FullName
  $required = @('README.md', 'START-HERE.html', 'claude-code.mcp.example.json', 'INSTALL.cmd', 'INSTALL.ps1', 'CONFIGURE.cmd', 'CONFIGURE.ps1', 'OPEN-CONFIG.cmd', 'OPEN-CONFIG.ps1', 'UNINSTALL.cmd', 'UNINSTALL.ps1', 'config\settings.example.json', 'payload', 'release-manifest.json', 'SHA256SUMS.txt')
  foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $item))) { throw "缺少必需文件：$item" }
  }
  foreach ($file in @('INSTALL.ps1', 'CONFIGURE.ps1', 'OPEN-CONFIG.ps1', 'UNINSTALL.ps1')) {
    Assert-PowerShellSyntax (Join-Path $root $file)
  }
  $forbiddenNames = @('.git', '.env', 'settings.json', 'pnpm-lock.yaml', 'npm.cmd', 'npx.cmd', 'pnpm.cmd', 'corepack')
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
    if ($forbiddenNames -contains $item.Name -or $item.Name -like '.env*' -or $item.Name -in @('.pnpm', '.bin')) {
      throw "制品包含禁止内容：$(Relative-Name $root $item.FullName)"
    }
  }
  Assert-NoReparsePoint $root
  $secretFiles = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File | Where-Object { $_.Name -like '.env*' -or $_.Name -eq 'settings.json' })
  if ($secretFiles.Count -gt 0) { throw '制品包含运行时凭据文件。' }
  $manifest = Get-Content -LiteralPath (Join-Path $root 'release-manifest.json') -Raw | ConvertFrom-Json
  if ([string]$manifest.product -ne 'database-mcp-server') { throw '制品 product 不匹配。' }
  if ([string]$manifest.target.os -ne 'windows' -or [string]$manifest.target.architecture -ne 'x64') { throw '制品目标平台不匹配。' }
  if ([string]$manifest.config.path -and [string]$manifest.config.path -ne '%USERPROFILE%\database-mcp-server\config\settings.json') { throw '制品配置路径不匹配。' }
  $payload = Join-Path $root 'payload'
  if (-not (Test-Path -LiteralPath $payload -PathType Container)) { throw '制品缺少 payload 目录。' }
  $nodeRelativeValue = if ($manifest.runtime.nodePath) { [string]$manifest.runtime.nodePath } else { 'runtime\node.exe' }
  $nodeRelative = Assert-RelativePayloadPath $nodeRelativeValue 'runtime.nodePath'
  if ($nodeRelative -notmatch '^runtime[\\/]') { throw 'runtime.nodePath 必须位于 payload/runtime。' }
  $nodePath = Join-Path $payload $nodeRelative
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw '制品缺少 Node 运行时。' }
  Assert-PeX64 $nodePath
  if ($manifest.runtime.nodeSha256) {
    $expectedNodeHash = [string]$manifest.runtime.nodeSha256
    if ($expectedNodeHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'release-manifest.json 的 nodeSha256 无效。' }
    $actualNodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualNodeHash -ne $expectedNodeHash.ToLowerInvariant()) { throw 'Node 运行时 SHA-256 与 manifest 不匹配。' }
  }
  $entryRelativeValue = if ($manifest.runtime.entryPath) { [string]$manifest.runtime.entryPath } else { 'app\src\index.js' }
  $entryRelative = Assert-RelativePayloadPath $entryRelativeValue 'runtime.entryPath'
  if ($entryRelative -notmatch '^app[\\/]') { throw 'runtime.entryPath 必须位于 payload/app。' }
  $entryPath = Join-Path $payload $entryRelative
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw '制品缺少 MCP 入口。' }
  if ([string]$manifest.status -eq 'VERIFIED') { Write-Warning '该包标为 VERIFIED；请确认 WindowsEvidencePath 记录已随发布保存。' }
  $hashLines = [IO.File]::ReadAllLines((Join-Path $root 'SHA256SUMS.txt'))
  $listed = @{}
  foreach ($line in $hashLines) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { throw 'SHA256SUMS.txt 格式错误。' }
    $expected = $Matches[1].ToLowerInvariant(); $relative = $Matches[2].Trim()
    $relative = $relative.Replace('\', '/')
    if ($relative -eq 'SHA256SUMS.txt') { throw 'SHA256SUMS.txt 不得引用自身。' }
    $listed[$relative.ToLowerInvariant()] = $true
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative))
    $rootWithSlash = $root.TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($rootWithSlash, [StringComparison]::OrdinalIgnoreCase)) { throw 'SHA256SUMS.txt 引用了包外路径。' }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "哈希清单引用不存在：$relative" }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "哈希不匹配：$relative" }
  }
  $actualFiles = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
    ForEach-Object { Relative-Name $root $_.FullName })
  foreach ($relative in $actualFiles) {
    if (-not $listed.ContainsKey($relative.ToLowerInvariant())) { throw "SHA256SUMS.txt 未覆盖文件：$relative" }
  }
  Write-Host "Windows x64 制品结构和 SHA-256 清单检查通过：$zip"
  Write-Host "状态：$($manifest.status)"
} catch {
  Write-Error ("制品检查失败：" + $_.Exception.Message)
  exit 1
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
