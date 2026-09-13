# WIN-DB-002：Windows 安装入口与发布验证复盘

状态：代码和候选包已修复，目标 Windows x64 + Windows PowerShell 5.1 实机验收仍未完成。发现日期：2026-09-13。适用项目：`database-mcp-server`。

## 症状

同一轮候选包出现过以下症状：

- 双击 `INSTALL.cmd` 时窗口一闪而过，或中文 CMD 提示被代码页解码成乱码后被当成命令；
- PowerShell 报 `ConvertFrom-Json` 的“应为 `:` 或 `}`”解析错误，随后只看到通用安装失败；
- 修复后的包只显示 `Database MCP Server installer / Installing...`，长时间没有阶段信息；
- 外部 Windows Node/MCP 启动失败时，原脚本丢弃了 stderr，留下“入口语法检查失败”这一层信息。

这些输出来自用户报告。聊天中的 Markdown、反斜杠和链接可能改变显示，不能把转贴内容当作 ZIP 内文件的原始字节。

## 根因和证据边界

已确认的实现问题：

1. CMD 包装器使用中文文本，没有保证代码页安全；错误路径没有独立的每次运行日志尾部，也没有在脚本缺失/脚本加载前失败时提供同等诊断。
2. 安装脚本把完整性校验、复制和 MCP 冒烟放在同一条无阶段输出的流程中。`SHA256SUMS.txt` 覆盖约 3,795 个文件，用户只看到 `Installing...` 时无法区分哈希、复制、子进程启动或协议等待。
3. JSON 使用隐式文件读取编码；构建脚本中的 Windows PowerShell 字符串还曾把配置路径反斜杠作为字面字符交给 JSON 序列化，缺少“生成后按目标 PowerShell 回读”的门禁。
4. 原生 Node 调用曾用 `2>$null`，没有保留 stderr；Windows PowerShell 5.1 的原生 stderr 还可能表现为 ErrorRecord，不能用“有错误流”替代退出码判断。

尚未由目标机证据确认的事项：

- 用户看到的 JSON 解析错误究竟来自包内哪一个原始字节序列；当前仓库的本机 `0.2.2` 清单可被 JSON 解析，不能据此反推用户下载包的实际字节。
- 用户的 `Installing...` 是否最终停在 3,795 个文件哈希、Node 启动、MCP stdio 读取，还是目标机安全软件/文件锁；没有阶段日志和进程证据不能下结论。
- `Get-Sha256Hex` 相比 `Get-FileHash` 在 Windows 5.1 上的实际耗时收益；本机只证明它输出阶段计数，未完成目标机性能基准。

## 修复与经验

- `INSTALL.cmd` 采用 ASCII、CRLF、`EnableExtensions DisableDelayedExpansion`、`cd /d "%~dp0"`、缺失脚本检查、单独 `powershell.exe -ExecutionPolicy Bypass` 子进程、每次 `%TEMP%` 日志和失败时日志尾部回显。
- `INSTALL.ps1` 接受 `-LogPath`，按 UTF-8 读取 JSON，阶段输出使用可见编号，哈希校验显示 `Checked N/Total files`，并捕获原生 stdout/stderr；日志失败不能覆盖原始安装错误。
- 发布脚本检查最终包中的 PowerShell 语法、ASCII CMD、清单 JSON、单顶层目录、逐文件哈希、无 reparse point、Node PE x64 和 Node/MCP 启动边界。
- 这些做法参考了 `browser-mcp-server` 的 `INSTALL-WINDOWS-PILOT.cmd`、`INSTALL-WINDOWS-PILOT.ps1`、日志/步骤函数和 ADR 0008 的“发布门禁与目标机单次安装分离”原则；数据库包仍保持自己的 Node-only 目标机边界、目录、配置和 MCP 注册契约。

## 版本与验证记录

- 修复提交：`ca0c6b9`（清单解析）、`eaa3a7e`（安装进度）、`346d8b3`（日志、阶段和原生错误回显）。
- 当前候选包：`database-mcp-server-0.2.5-windows-x64.zip`；状态仍为 `CANDIDATE_UNVERIFIED`。
- 已完成：本机 PowerShell 解析器解析随包脚本、候选 ZIP 单顶层/逐文件 SHA-256/清单检查、Node `--check`、32 个 Node 测试。
- 未完成：原生 Windows x64 + Windows PowerShell 5.1 的干净安装、配置重载、升级/回滚、卸载、代码页矩阵和完整耗时基准。
- 本机执行候选包时，流程能输出完整哈希进度并到达 Windows Node 启动边界；macOS 不能执行包内 `node.exe`，该结果不计为 Windows 安装验收。

## 后续门禁

1. 在原生 Windows 5.1 用最终 ZIP，而不是源码目录或旧 ZIP，记录 `Get-ExecutionPolicy -List`、`$PSVersionTable`、代码页、解压路径和 sidecar SHA-256。
2. 保存完整安装日志；验证入口失败、清单损坏、哈希损坏、运行时启动失败、MCP 探针超时、日志目录不可写时都能看到原始原因并返回非零退出码。
3. 测量完整性校验、复制、Node 语法检查和 MCP 冒烟各阶段耗时；为外部进程设置有界等待和子进程清理，不以无限等待作为成功。
4. 把同一最终 ZIP 的安装、配置、升级/回滚和卸载证据交给发布门禁；只有证据齐全时才把清单从 `CANDIDATE_UNVERIFIED` 改为 `VERIFIED`。

