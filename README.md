# 数据库助手 MCP 服务

这是给 Claude Code 使用的本地数据库 MCP 服务。产品和 MCP 身份是通用的 `database-mcp-server` / `database-mcp`，当前首个适配器使用 MySQL 驱动；以后可以在不改变工具契约的前提下增加其他数据库适配器。

服务通过 stdio 工作，连接地址、数据库名、用户名和密码由用户目录中的 JSON 配置文件提供。默认文件是：

```text
Windows: %USERPROFILE%\database-mcp-server\config\settings.json
macOS/Linux: $HOME/database-mcp-server/config/settings.json
```

也可以通过 `DATABASE_CONFIG_PATH` 指定绝对路径。只有这个路径变量会从 MCP 启动环境读取，连接凭据不放在命令行参数中。

## 工具

| 工具 | 用途 |
| --- | --- |
| `database_config_status` | 查看配置路径、schema 版本、缺失字段和脱敏摘要，不连接数据库。 |
| `database_configure` | 创建或更新 `settings.json`，保存后自动重载。密码只写入本机文件，响应不会回显。 |
| `database_config_reload` | 重新读取配置并替换连接池。 |
| `database_environment_list` | 列出所有环境、默认环境和脱敏配置状态，不连接数据库。 |
| `database_environment_set_default` | 设置未传 `environment` 时使用的默认环境；不保存当前环境。 |
| `database_ping` | 测试指定环境（或默认环境）的 MySQL 连接并返回版本、数据库和认证用户。 |
| `database_list_tables` | 列出指定环境数据库的表和视图。 |
| `database_describe_table` | 返回指定环境中表的字段和索引。 |
| `database_query` | 在指定环境执行读形式 SQL，支持参数和多语句。 |
| `database_execute` | 在指定环境执行受权限开关保护的 DML/DDL，要求 `confirm=true`。 |

典型的数据助手流程是先调用 `database_config_status` 或 `database_environment_list`，确认环境后调用 `database_ping`，再调用 `database_list_tables` 和 `database_describe_table`，最后使用参数化的 `database_query`。没有设置默认环境时，每个数据库工具都要传 `environment`。

## 配置

把 [config/settings.example.json](config/settings.example.json) 复制到默认路径后填写连接信息。多环境配置的每个键都是一个环境名；`defaultEnvironment` 是可选的，只是省略 `environment` 参数时的回退。最小配置如下：

```json
{
  "schemaVersion": 1,
  "adapter": "mysql",
  "defaultEnvironment": "dev",
  "environments": {
    "dev": {
      "connection": {
        "host": "127.0.0.1",
        "port": 3306,
        "database": "业务库_dev",
        "user": "claude_reader",
        "password": "请填写密码"
      },
      "permissions": {
        "allowWrite": false,
        "allowDdl": false,
        "allowDestructive": false
      }
    },
    "prod": {
      "connection": {
        "host": "prod-db.example.com",
        "port": 3306,
        "database": "业务库_prod",
        "user": "claude_reader_prod",
        "password": "请填写密码"
      }
    }
  }
}
```

环境名只允许 Unicode 字母或数字开头，后续使用字母、数字、`.`、`_` 和 `-`，长度为 1–64 个字符。每个环境都有独立的 `connection`，因此可以分别配置地址、端口、数据库、用户名、密码和 TLS；`permissions`、`runtime` 可以写在环境内，也可以在顶层作为所有环境的默认值。建议生产环境单独使用最小权限账号，并且不要把生产环境设置成默认环境。

在多环境配置中如果没有 `defaultEnvironment`，服务不会猜测要连接哪个环境。调用时显式传入环境：

```json
{
  "environment": "staging",
  "sql": "SELECT COUNT(*) AS total FROM orders"
}
```

可以调用 `database_environment_set_default({"environment":"dev"})` 设置回退环境，也可以在 `database_configure` 中传 `environment` 和 `setAsDefault: true`。调用 `database_configure({"defaultEnvironment":null})` 可以移除回退。设置默认环境不会改变或记录一个“当前环境”；每次调用仍可传入其他环境。

旧版只有一个 `connection` 的配置文件仍然有效，服务会把它视为单一的 `default` 环境。只有在使用多环境配置时，才需要显式管理默认环境。
从旧配置向新环境迁移时，原连接会保留为 `default`，新环境单独写入；确认新环境可用后可以通过 `database_environment_set_default` 指定回退环境。

用户名和密码可以并列保存在这个用户目录中的 `settings.json`，这是为方便 Claude Code 读取而做的明确取舍。该文件等同于明文凭据：只允许当前操作系统用户读取，不能复制到 Git、压缩包、日志、截图或 Claude Code 的共享配置中。服务的状态、错误和工具响应都会省略密码；配置文件本身仍需要用户负责保护。

可选连接项包括 `socketPath`、`charset`、`timezone` 和 TLS；在多环境文件中把它们放到对应环境内：

```json
{
  "environments": {
    "prod": {
      "connection": {
        "ssl": {
          "mode": "verify_identity",
          "caFile": "ca.pem",
          "certFile": "client-cert.pem",
          "keyFile": "client-key.pem"
        }
      },
      "runtime": {
        "connectionLimit": 4,
        "connectTimeoutMs": 10000,
        "queryTimeoutMs": 30000
      }
    }
  }
}
```

证书文件的相对路径以 `settings.json` 所在目录为基准。`verify_ca` 和 `verify_identity` 需要 CA 文件；生产环境建议使用 `verify_identity`。

也可以让 Claude Code 调用 `database_configure` 写入配置。例如只提交连接字段时，已经存在的密码会被保留：

```json
{
  "environment": "staging",
  "host": "db.example",
  "port": 3306,
  "database": "sales",
  "user": "claude_reader",
  "password": "由用户填写"
}
```

上面的调用只更新 `staging` 环境，不会覆盖 `dev` 或 `prod`。如果要同时设为默认环境，再增加 `"setAsDefault": true`。完整的 `environments` 对象也可以通过 `settings` 或 `config` 一次提交。

## 接入 Claude Code

Windows ZIP 的 `INSTALL.cmd` 会复用当前用户已有的 `claude.exe` 或 `claude.cmd`，通过 Claude Code CLI 的 `mcp add --scope user` 自动注册 `database-mcp`，并读取用户级配置核对 Node、入口和 `DATABASE_CONFIG_PATH`。安装器不会安装、升级或下载 Claude Code；如果当前用户不能运行 `claude`，安装会失败并恢复原用户配置。安装完成后请重启 Claude Code，在任意项目运行 `/mcp` 确认 `database-mcp`。

源码或 macOS/Linux 环境可以参考 [claude-code.mcp.example.json](claude-code.mcp.example.json) 手工注册：

```json
{
  "mcpServers": {
    "database-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/database-mcp-server/src/index.js"],
      "env": {
        "DATABASE_CONFIG_PATH": "/absolute/path/database-mcp-server/config/settings.json"
      }
    }
  }
}
```

如果 Claude Code 找不到 `node`，把 `command` 换成本机 Node.js 的绝对路径。启动后先调用 `database_config_status` 或 `database_environment_list`；编辑配置后调用 `database_config_reload`，不必重启 Claude Code。数据工具的 `environment` 参数优先于 `defaultEnvironment`。

## SQL 行为与权限

服务允许多语句请求，会把 SQL 函数交给 MySQL 处理，`UPDATE` 和 `DELETE` 可以不带 `WHERE`，结果不会按行数或结果字节数截断。`database_query` 仍只接受 `SELECT`、`SHOW`、`DESCRIBE`、`EXPLAIN` 和读形式 `WITH`，并拒绝锁定读取、可执行注释和服务端文件导出；`database_execute` 拒绝账号/服务器/数据库级管理语句以及服务端文件导入导出。这些边界与多语句、函数、无 `WHERE` 和完整结果集是不同的策略。

DML、DDL 和破坏性 DDL 默认关闭：

```json
{
  "permissions": {
    "allowWrite": false,
    "allowDdl": false,
    "allowDestructive": false
  }
}
```

需要写入时，先让 Claude Code 展示 SQL 和影响范围，再在调用 `database_execute` 时传 `confirm: true`，并按需打开对应开关。多语句写入遵循 MySQL 自动提交行为，后续语句失败时，前面已经成功的语句可能已经提交；服务不提供跨调用事务。

建议为 Claude Code 创建权限最小的 MySQL 账号。只读场景授予目标库的 `SELECT`、`SHOW VIEW`；写入场景再单独授予必要的 DML 权限。

## 安装与检查

开发机需要 Node.js 18.18 或更高版本：

```bash
pnpm install --prod
pnpm run check
pnpm test
```

Windows 公开制品不要求目标机安装 Node.js、npm、pnpm、npx、Docker 或联网下载；构建脚本会把 Node 运行时和生产依赖放进 ZIP。目标机需要当前用户已经可以运行 Claude Code，安装器会自动注册用户级 MCP。请先把 ZIP 完整解压到一个普通目录，再运行 `START-HERE.html` 或 `INSTALL.cmd`，不要直接从压缩包预览窗口启动。然后运行 `CONFIGURE.cmd` 从模板创建 `%USERPROFILE%\database-mcp-server\config\settings.json`；升级会保留配置，卸载会注销 `database-mcp` 但默认保留数据库配置。

如果双击 `INSTALL.cmd` 失败，窗口会保留并显示 PowerShell 的原始错误，并自动显示临时安装日志的最后 80 行；日志默认位于 `%TEMP%\database-mcp-server\INSTALL-*.log`，直接运行 `INSTALL.ps1` 时才使用 `%USERPROFILE%\database-mcp-server\logs\install.log`。入口批处理文件只使用 ASCII 文本，避免 Windows 代码页把中文提示误当成命令；安装清单按 UTF-8 读取。请把该文件（或窗口）中的错误原文和 `Get-ExecutionPolicy -List` 输出交给管理员或维护者，不要只提供“错误码”。

真实 Windows x64 验收需要在干净 Windows + PowerShell 5.1 上完成；本仓库提供构建和清单脚本，但 macOS/Linux 本地检查不能替代该验收。

在 Windows 构建机上准备好官方 Windows x64 Node 运行时目录或 ZIP 后，可执行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\build-windows.ps1 `
  -NodeRuntime C:\path\to\node-v22.x-win-x64.zip
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\verify-windows-release.ps1 `
  -ZipPath .\dist\database-mcp-server-0.2.7-windows-x64.zip
```

如果能提供运行时来源，还可以把官方归档地址和 SHA-256 写入清单：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\build-windows.ps1 `
  -NodeRuntime C:\releases\node-v22.14.0-win-x64.zip `
  -NodeRuntimeSourceUrl https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip `
  -NodeRuntimeArchiveSha256 <官方归档 SHA-256>
```

构建默认生成 `CANDIDATE_UNVERIFIED` 清单；只有把干净 Windows x64 + PowerShell 5.1 的安装、升级/回滚、配置重载和卸载证据传给构建脚本，才允许标记 `VERIFIED`。目标机永远不执行包管理器或在线下载。

`INSTALL.cmd` 会为单个 PowerShell 子进程使用 `-ExecutionPolicy Bypass`，不会修改用户或计算机的持久执行策略。如果组织通过 `MachinePolicy` 或 `UserPolicy` 禁止脚本，运行入口仍可能在脚本正文之前被拦截；此时在 PowerShell 中执行 `Get-ExecutionPolicy -List`，把输出和错误原文交给管理员，由管理员批准签名脚本或调整组织策略。不要为了安装而执行 `Set-ExecutionPolicy` 修改全局策略。
