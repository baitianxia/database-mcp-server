# WIN-DB-001：通用数据库助手 Windows 交付整改

状态：代码整改完成，Windows x64 实机验收未完成。负责人：项目维护者。优先级：P0。

## 目标

把 database-mcp-server 定义为通用数据库助手，首个标准版本使用：

- 工程/包名：database-mcp-server
- 用户显示名：数据库助手（当前支持 MySQL）
- MCP 注册名：database-mcp
- 用户目录：%USERPROFILE%\database-mcp-server\
- 配置：%USERPROFILE%\database-mcp-server\config\settings.json

MySQL 保留为当前 adapter/驱动能力，不能成为产品级工程名、MCP 注册名或安装目录。本次不迁移历史 mysql-mcp-server、database-data-assistant 名称。

## 整改内容

1. 统一 server identity、工具名、初始化说明和文档；通用数据库工具使用 database_* 命名，MySQL 特有选项放在 adapter 配置和能力说明中。
2. 用本工程可发现的 JSON 配置替代目标机上深层或隐含的手工配置。默认路径为 config/settings.json，同时提供 DATABASE_CONFIG_PATH 作为显式覆盖入口。
3. 提供 database_config_status、database_configure、database_config_reload、database_environment_list 和 database_environment_set_default，并在 initialize.instructions 输出绝对路径、schema 版本、缺失字段和下一步命令。状态、工具结果、日志和错误默认不得返回密码。
4. 本次允许用户名和密码在本工程用户目录的 settings.json 中明文并列保存，且设置为当前 Windows 用户可读。真实凭据绝不能进入 ZIP、Git、.env.example、测试输出、日志、命令行参数或 MCP 返回值；README 必须说明 Claude Code 可读明文凭据的风险。
5. 生成唯一公开制品 database-mcp-server-<version>-windows-x64.zip，顶层提供中文 README.md、START-HERE.html、INSTALL.cmd、CONFIGURE.cmd、OPEN-CONFIG.cmd、UNINSTALL.cmd、config/settings.example.json、payload/、release-manifest.json 和 SHA256SUMS.txt。
6. INSTALL.cmd 同时支持首次安装和升级：版本目录独立、配置外置、清单/运行时/MCP 冒烟通过后原子切换，失败回滚并保留最近可用版本；卸载默认保留配置。
7. 把 Node 运行时和生产依赖放入 ZIP，目标机不执行 npm、pnpm、npx、Docker 或在线下载。为仓库补齐可审计的 Windows 构建流程、许可证、SBOM 和哈希生成；若当前目录尚未纳入 Git，先建立可追溯的版本基线。
8. 更新 README.md、docs/architecture.md、配置契约和测试，使默认 DML/DDL 安全策略与 Windows 交付规则保持一致；不得用真实数据库凭据做验收样例。

## 验收证据

- [ ] 干净 Windows x64 + PowerShell 5.1 解压并安装后，可用示例配置完成 MCP 初始化；无数据库时也能验证配置状态和错误提示。
- [ ] Claude Code 能找到并修改配置，执行重载后能看到 schema/连接状态变化，且密码保持脱敏。
- [ ] 覆盖安装保留配置；模拟新版本启动失败可恢复旧版本；卸载不删除配置。
- [ ] 目录/注册项检查证明只写 %USERPROFILE%\database-mcp-server\，不触及其他工程或共享 ClaudeTools。
- [ ] 发布 ZIP 不含真实凭据、开发目录、.env 或测试快照；提交清单、逐文件 SHA256、运行时来源、许可证和 SBOM。

## 当前实现证据

- `src/config.js` 已使用用户目录 `config/settings.json`，支持 `DATABASE_CONFIG_PATH`、schemaVersion 1、原子写入、脱敏摘要和权限加固；配置可通过 `environments` 保存多套连接，并用可选 `defaultEnvironment` 指定省略环境参数时的回退。
- `src/index.js` 已固定 `database-mcp` 身份，并提供环境目录、默认环境设置和带 `environment` 参数的通用 `database_*` 工具；服务不保存当前环境。
- `scripts/build-windows.ps1` 只接受显式提供的 Windows x64 Node 运行时，使用生产依赖和白名单文件生成 `database-mcp-server-<version>-windows-x64.zip`；打包前会用 PowerShell AST 解析器检查随包 `.ps1`；默认清单状态为 `CANDIDATE_UNVERIFIED`。
- `INSTALL.cmd` 通过单独的 `powershell.exe -ExecutionPolicy Bypass` 子进程启动，直接回显全部输出，并无论成功或失败都停留到用户按键；脚本能启动时还会把输出写入 `%USERPROFILE%\database-mcp-server\logs\install.log`；日志目录不可写或脚本在解析前失败时仍直接显示错误；`CONFIGURE.cmd`、`OPEN-CONFIG.cmd`、`UNINSTALL.cmd` 只访问本工程用户目录。
- 本机 `node --check` 和 `node --test` 已通过；由于当前执行环境不是 Windows x64，不能把这些结果当作 Windows 验收证据，也未将候选制品标记为 `VERIFIED`。
- Git 仓库已初始化并推送到公开远端；根目录的 [`release-baseline.json`](../release-baseline.json) 继续保存逐文件内容摘要，构建脚本会在可用时把 Git 提交写入发布清单，否则使用该摘要 revision。

## 当前候选制品（2026-09-13）

- 文件：`dist/database-mcp-server-0.2.4-windows-x64.zip`
- 外置校验：同目录的 `database-mcp-server-0.2.4-windows-x64.zip.sha256`；发布清单中的 `source.revision` 指向根目录内容基线。
- 运行时：Node.js 22.14.0 Windows x64，PE machine `0x8664`；官方归档 SHA-256 已在构建前核对。
- 已完成的非 Windows 检查：ZIP 单顶层目录、逐文件 SHA-256、sidecar SHA-256、无 reparse/symlink、无凭据文件、Node 入口语法和 MCP initialize 冒烟。
- 清单状态仍为 `CANDIDATE_UNVERIFIED`；没有把 macOS 主机上的检查当作 Windows PowerShell 5.1 验收。

## 完成定义

代码、配置契约、Windows 入口、中文文档和验收证据全部提交后，在任务总表登记制品版本与哈希，才可把状态改为“已验收”。
