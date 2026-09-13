# Windows x64 交付流程

本工程的 Windows 用户交付物只有一个 ZIP：
`database-mcp-server-<version>-windows-x64.zip`。

构建机需要准备官方 Node.js Windows x64 ZIP 或已解压目录。运行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\build-windows.ps1 `
  -NodeRuntime C:\releases\node-v22.14.0-win-x64.zip `
  -NodeRuntimeSourceUrl https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip `
  -NodeRuntimeArchiveSha256 <官方归档 SHA-256>
```

脚本只收集白名单文件，使用 `pnpm install --prod` 和 hoisted 复制布局生成生产依赖，运行时只复制 `node.exe`，并写入 CycloneDX 简化 SBOM、第三方声明、运行时哈希、版本来源、逐文件 `SHA256SUMS.txt` 和 ZIP sidecar 哈希。打包和清单检查还会用 PowerShell AST 解析器检查随包 `.ps1`，避免语法错误进入 ZIP。目标机不需要 Node、npm、pnpm、npx、Docker 或联网下载。

构建清单默认是 `CANDIDATE_UNVERIFIED`。在干净 Windows x64 + PowerShell 5.1 上完成安装、首次启动、配置重载、覆盖升级、故障回滚和卸载后，把证据目录传给构建脚本，才可以使用 `-VerificationStatus VERIFIED -WindowsEvidencePath <path>`。当前仓库只在 macOS/Linux 上完成 Node 语法、单元和 MCP 握手检查，因此不能宣称 Windows 已验收。

安装器把版本放在 `%USERPROFILE%\database-mcp-server\versions\<version>`，把配置放在版本目录之外的 `%USERPROFILE%\database-mcp-server\config\settings.json`，并只写入该工程的状态和注册文件。升级失败时保留旧版本；卸载默认保留配置。`INSTALL.cmd` 使用进程级 `-ExecutionPolicy Bypass`，不会修改用户或计算机的持久执行策略。安装入口会直接显示 PowerShell 的全部输出，并且无论成功还是失败都停留到用户按键；失败时还会显示临时日志尾部；入口批处理文件只使用 ASCII 文本，安装脚本按 UTF-8 读取发布清单，并在完整性校验期间显示已完成文件数；日志默认位于 `%TEMP%\database-mcp-server\INSTALL-*.log`，直接运行脚本时才使用 `%USERPROFILE%\database-mcp-server\logs\install.log`。运行前应先完整解压 ZIP，不要从压缩包预览窗口直接启动。

配置文件支持 `environments` 多环境对象和可选 `defaultEnvironment`。安装器只复制模板，不会创建真实 `settings.json`；首次配置后，Claude Code 的数据库工具可以在每次调用中传入 `environment`，没有默认值时不会猜测目标数据库。
