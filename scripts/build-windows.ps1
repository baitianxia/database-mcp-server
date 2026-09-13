[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NodeRuntime,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),
  [ValidateSet('CANDIDATE_UNVERIFIED', 'VERIFIED')]
  [string]$VerificationStatus = 'CANDIDATE_UNVERIFIED',
  [string]$WindowsEvidencePath,
  [string]$NodeRuntimeSourceUrl,
  [string]$NodeRuntimeArchiveSha256
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageJsonPath = Join-Path $repoRoot 'package.json'
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw 'package.json 的版本号无效。' }
if ($VerificationStatus -eq 'VERIFIED' -and [string]::IsNullOrWhiteSpace($WindowsEvidencePath)) {
  throw '只有提供 WindowsEvidencePath 时才能把制品标为 VERIFIED。'
}
if ($VerificationStatus -eq 'VERIFIED' -and -not (Test-Path -LiteralPath $WindowsEvidencePath)) {
  throw 'WindowsEvidencePath 不存在，不能把制品标为 VERIFIED。'
}
if ($NodeRuntimeArchiveSha256 -and $NodeRuntimeArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') {
  throw 'NodeRuntimeArchiveSha256 必须是 64 位十六进制 SHA-256。'
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [IO.File]::WriteAllText($Path, $Text, (New-Object -TypeName Text.UTF8Encoding -ArgumentList $false))
}

function Read-Utf8Json([string]$Path) {
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $text = [IO.File]::ReadAllText($Path, $utf8)
  return ($text | ConvertFrom-Json)
}

function Assert-AsciiCmd([string]$Path) {
  foreach ($byte in [IO.File]::ReadAllBytes($Path)) {
    if ($byte -gt 0x7f) { throw "批处理入口必须是 ASCII 文本：$Path" }
  }
}

function Copy-Tree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}

function Assert-NoReparsePoint([string]$Root) {
  $items = @(Get-Item -LiteralPath $Root) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "输入或输出包含不允许的 reparse point: $($item.FullName)"
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
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw 'Node 运行时不是有效的 PE 文件。'
  }
  $offset = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($offset -lt 0 -or $offset + 6 -gt $bytes.Length -or $bytes[$offset] -ne 0x50 -or $bytes[$offset + 1] -ne 0x45) {
    throw 'Node 运行时 PE 头无效。'
  }
  if ([BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x8664) {
    throw 'Node 运行时不是 Windows x64。'
  }
}

function Get-NodeVersion([string]$Path) {
  $versionOutput = ((& $Path '--version' 2>$null) -join "`n").Trim()
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '^v?(\d+\.\d+\.\d+)$') {
    throw '无法读取内置 Node 运行时版本。'
  }
  return $Matches[1]
}

function Relative-Name([string]$Root, [string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $full = [IO.Path]::GetFullPath($Path)
  return $full.Substring($rootFull.Length).Replace('\', '/')
}

function Get-SourceRevision {
  try {
    $revision = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -eq 0 -and $revision) { return $revision }
  } catch { }
  $baselinePath = Join-Path $repoRoot 'release-baseline.json'
  if (Test-Path -LiteralPath $baselinePath) {
    try {
      $baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
      if ($baseline.revision) { return [string]$baseline.revision }
    } catch { }
  }
  return 'NO_GIT_BASELINE'
}

function New-Sha256File([string]$Root, [string]$OutputPath) {
  $lines = @()
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
    Where-Object { $_.FullName -ne $OutputPath } |
    Sort-Object { Relative-Name $Root $_.FullName } |
    ForEach-Object {
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $lines += "$hash  $(Relative-Name $Root $_.FullName)"
    }
  # Keep the checksum list LF-normalized so it can be verified by both
  # PowerShell and common Unix tooling after a ZIP is copied across systems.
  Write-Utf8NoBom $OutputPath (($lines -join "`n") + "`n")
}

function Expand-Runtime([string]$InputPath, [string]$Destination) {
  $resolved = (Resolve-Path $InputPath).Path
  if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'node.exe'))) {
      $nested = Get-ChildItem -LiteralPath $resolved -Filter node.exe -File -Recurse | Select-Object -First 1
      if (-not $nested) { throw 'NodeRuntime 目录中找不到 node.exe。' }
      $resolved = $nested.Directory.FullName
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $resolved 'node.exe') -Destination (Join-Path $Destination 'node.exe') -Force
    $license = Join-Path $resolved 'LICENSE'
    if (Test-Path -LiteralPath $license) { Copy-Item -LiteralPath $license -Destination (Join-Path $Destination 'NODE-LICENSE') -Force }
    return
  }
  if ([IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne '.zip') { throw 'NodeRuntime 必须是包含 node.exe 的目录或 ZIP。' }
  $temp = Join-Path ([IO.Path]::GetTempPath()) "database-mcp-node-$PID"
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    Expand-Archive -LiteralPath $resolved -DestinationPath $temp -Force
    $node = Get-ChildItem -LiteralPath $temp -Filter node.exe -File -Recurse | Select-Object -First 1
    if (-not $node) { throw 'NodeRuntime ZIP 中找不到 node.exe。' }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -LiteralPath $node.FullName -Destination (Join-Path $Destination 'node.exe') -Force
    $license = Join-Path $node.Directory.FullName 'LICENSE'
    if (Test-Path -LiteralPath $license) { Copy-Item -LiteralPath $license -Destination (Join-Path $Destination 'NODE-LICENSE') -Force }
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  }
}

$stagingParent = Join-Path ([IO.Path]::GetTempPath()) "database-mcp-build-$PID"
$packageName = "database-mcp-server-$version-windows-x64"
$packageRoot = Join-Path $stagingParent $packageName
$outputFull = [IO.Path]::GetFullPath($OutputDirectory)
$zipPath = Join-Path $outputFull "$packageName.zip"
$nodeSourceHash = $null

try {
  New-Item -ItemType Directory -Force -Path $stagingParent, $packageRoot, $outputFull | Out-Null
  $payloadRoot = Join-Path $packageRoot 'payload'
  $runtimeRoot = Join-Path $payloadRoot 'runtime'
  $appRoot = Join-Path $payloadRoot 'app'
  Expand-Runtime $NodeRuntime $runtimeRoot
  $nodePath = Join-Path $runtimeRoot 'node.exe'
  Assert-PeX64 $nodePath
  if ($NodeRuntimeArchiveSha256 -and (Test-Path -LiteralPath $NodeRuntime -PathType Leaf)) {
    $inputHash = (Get-FileHash -LiteralPath $NodeRuntime -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($inputHash -ne $NodeRuntimeArchiveSha256.ToLowerInvariant()) {
      throw 'NodeRuntimeArchiveSha256 与输入运行时归档不匹配。'
    }
  }
  $nodeSourceHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $nodeVersion = Get-NodeVersion $nodePath

  Copy-Tree (Join-Path $repoRoot 'src') (Join-Path $appRoot 'src')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination (Join-Path $appRoot 'package.json')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'pnpm-lock.yaml') -Destination (Join-Path $appRoot 'pnpm-lock.yaml')
  $packageManager = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $packageManager) { throw '构建机需要 pnpm.cmd 来生成可审计的生产依赖；目标机不需要 pnpm。' }
  & $packageManager.Source install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --dir $appRoot
  if ($LASTEXITCODE -ne 0) { throw '生产依赖安装失败。' }
  Remove-Item -LiteralPath (Join-Path $appRoot 'pnpm-lock.yaml') -Force
  $runtimePackage = [ordered]@{
    name = [string]$packageJson.name
    version = [string]$packageJson.version
    description = [string]$packageJson.description
    license = [string]$packageJson.license
    type = [string]$packageJson.type
    engines = $packageJson.engines
    dependencies = $packageJson.dependencies
  }
  Write-Utf8NoBom (Join-Path $appRoot 'package.json') (($runtimePackage | ConvertTo-Json -Depth 8) + "`r`n")
  $nodeModules = Join-Path $appRoot 'node_modules'
  foreach ($metadata in @('.pnpm', '.modules.yaml', '.package-map.json', '.pnpm-workspace-state-v1.yaml', '.pnpm-workspace-state-v1.json', '.bin')) {
    $metadataPath = Join-Path $nodeModules $metadata
    if (Test-Path -LiteralPath $metadataPath) { Remove-Item -LiteralPath $metadataPath -Recurse -Force }
  }
  Assert-NoReparsePoint $nodeModules
  $probe = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"build-probe","version":"1"}}}'
  $probeOutput = $probe | & $nodePath (Join-Path $appRoot 'src\index.js') 2>$null
  if ($LASTEXITCODE -ne 0 -or (($probeOutput -join "`n") -notmatch '"name"\s*:\s*"database-mcp"')) {
    throw 'MCP 启动冒烟检查失败。'
  }

  foreach ($file in @('README.md', 'START-HERE.html', 'claude-code.mcp.example.json', 'INSTALL.cmd', 'INSTALL.ps1', 'CONFIGURE.cmd', 'CONFIGURE.ps1', 'OPEN-CONFIG.cmd', 'OPEN-CONFIG.ps1', 'UNINSTALL.cmd', 'UNINSTALL.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $packageRoot $file)
  }
  foreach ($file in @('INSTALL.ps1', 'CONFIGURE.ps1', 'OPEN-CONFIG.ps1', 'UNINSTALL.ps1')) {
    Assert-PowerShellSyntax (Join-Path $packageRoot $file)
  }
  foreach ($file in @('INSTALL.cmd', 'CONFIGURE.cmd', 'OPEN-CONFIG.cmd', 'UNINSTALL.cmd')) {
    Assert-AsciiCmd (Join-Path $packageRoot $file)
  }
  $packageConfig = Join-Path $packageRoot 'config'
  New-Item -ItemType Directory -Force -Path $packageConfig | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'config\settings.example.json') -Destination (Join-Path $packageConfig 'settings.example.json')
  $notice = @"
database-mcp-server $version third-party notices

The payload includes production dependencies declared in package.json and pnpm-lock.yaml.
Their licenses are distributed with the corresponding package metadata under payload/app/node_modules.
This candidate was assembled for Windows x64 and remains unverified until a clean Windows gate is recorded.
"@
  Write-Utf8NoBom (Join-Path $packageRoot 'THIRD-PARTY-NOTICES.txt') $notice

  $sbom = [ordered]@{
    bomFormat = 'CycloneDX'
    specVersion = '1.5'
    version = 1
    metadata = @{ component = @{ type = 'application'; name = 'database-mcp-server'; version = $version } }
    components = @(
      @{ type = 'library'; name = '@modelcontextprotocol/sdk'; version = '1.30.0' },
      @{ type = 'library'; name = 'mysql2'; version = '3.24.3' },
      @{ type = 'library'; name = 'zod'; version = '4.1.12' },
      @{ type = 'framework'; name = 'node'; version = $nodeVersion; hashes = @(@{ alg = 'SHA-256'; content = $nodeSourceHash }) }
    )
  }
  Write-Utf8NoBom (Join-Path $payloadRoot 'sbom.cdx.json') (($sbom | ConvertTo-Json -Depth 12) + "`r`n")

  $source = [ordered]@{
    revision = (Get-SourceRevision)
    repository = 'local workspace'
    builtAt = [DateTime]::UtcNow.ToString('o')
  }
  if ($NodeRuntimeSourceUrl) { $source.runtimeArchive = $NodeRuntimeSourceUrl }
  if ($NodeRuntimeArchiveSha256) { $source.runtimeArchiveSha256 = $NodeRuntimeArchiveSha256.ToLowerInvariant() }
  $manifest = [ordered]@{
    manifestVersion = 1
    product = 'database-mcp-server'
    displayName = '数据库助手（当前支持 MySQL）'
    version = $version
    target = @{ os = 'windows'; architecture = 'x64'; shell = 'PowerShell 5.1+' }
    status = $VerificationStatus
    source = $source
    runtime = @{ nodePath = 'runtime/node.exe'; entryPath = 'app/src/index.js'; nodeSha256 = $nodeSourceHash; nodeVersion = $nodeVersion; peFormat = 'PE32+ x86-64' }
    config = @{ path = '%USERPROFILE%/database-mcp-server/config/settings.json'; schemaVersion = 1; supportsEnvironments = $true; defaultEnvironmentOptional = $true }
    restrictions = @{ targetMachinePackageManagers = @('npm', 'pnpm', 'npx', 'Docker', 'online-downloads') }
  }
  Write-Utf8NoBom (Join-Path $packageRoot 'release-manifest.json') (($manifest | ConvertTo-Json -Depth 12) + "`r`n")
  $null = Read-Utf8Json (Join-Path $packageRoot 'release-manifest.json')
  Assert-NoReparsePoint $packageRoot
  New-Sha256File $packageRoot (Join-Path $packageRoot 'SHA256SUMS.txt')
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Utf8NoBom "$zipPath.sha256" "$zipHash  $(Split-Path -Leaf $zipPath)`n"
  Write-Host "已生成候选 Windows x64 制品：$zipPath"
  Write-Host "SHA-256：$zipHash"
} finally {
  if (Test-Path -LiteralPath $stagingParent) { Remove-Item -LiteralPath $stagingParent -Recurse -Force }
}
