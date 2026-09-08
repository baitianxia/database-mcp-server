# 架构与工具契约

## 边界

服务是单进程、stdio 传输的 MCP server。`src/index.js` 负责 MCP 握手、工具注册、环境解析和运行时重载；`src/config.js` 负责用户目录 JSON 配置、schema 校验、原子写入和脱敏摘要；`src/sql.js` 负责 SQL 多语句拆分、语句分类和工具边界；`src/db.js` 负责 adapter 工厂、按环境缓存的 MySQL 连接池、结果转换和多结果集组装。

产品身份固定为：包名 `database-mcp-server`，MCP 名称 `database-mcp`，用户显示名“数据库助手（当前支持 MySQL）”。MySQL 是当前 adapter，不出现在工程名或工具名中。工具不接受主机、用户名或密码参数来临时扩大连接范围；连接范围只来自用户配置文件。

配置路径由 `DATABASE_CONFIG_PATH` 显式覆盖，否则使用 `%USERPROFILE%\database-mcp-server\config\settings.json`（macOS/Linux 对应 `$HOME/database-mcp-server/config/settings.json`）。配置文档的 `schemaVersion` 当前为 `1`。写入使用临时文件加原子 rename；POSIX 文件权限为 `0600`，Windows 安装入口负责移除继承 ACL 并只授权当前用户。一个文档可以通过 `environments` 保存多个独立连接；`defaultEnvironment` 是可选回退，服务不保存“当前环境”。

## 工具契约

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `database_config_status` | 无 | 不建立连接；返回绝对配置路径、schema 版本、adapter、缺失字段和非敏感摘要。 |
| `database_configure` | `settings`/`config` 对象，或快捷连接与权限字段；可选 `environment`、`setAsDefault` | 合并并校验配置，原子写入后自动重载；指定环境时只修改该环境，密码可以写入本地文件但响应永不包含密码。 |
| `database_config_reload` | 无 | 重新读取文件并替换连接池；读取失败时保留仍可用的旧池。 |
| `database_environment_list` | 无 | 列出所有环境、默认环境和脱敏状态，不建立连接。 |
| `database_environment_set_default` | `environment` | 设置可选默认环境，不保存或切换当前环境。 |
| `database_ping` | 可选 `environment` | 执行指定环境的版本、当前数据库和当前用户查询；省略时使用 `defaultEnvironment`。 |
| `database_list_tables` | 可选 `environment` | 读取指定环境 MySQL 数据库的 `information_schema.TABLES`。 |
| `database_describe_table` | `table`，可选 `environment` | 允许可打印的 1–64 字符表名，通过参数绑定读取指定环境的字段和索引元数据。 |
| `database_query` | `sql`, `params`，可选 `environment` | 在指定环境接受一条或多条读形式语句；参数使用 MySQL `?` 占位符，参数只能是标量或一层标量数组；返回每条语句的列信息、行数和全部结果行。 |
| `database_execute` | `sql`, `params`, `confirm`，可选 `environment` | 在指定环境接受一条或多条受支持写语句；参数只能是标量或一层标量数组；需要 `confirm=true` 并受该环境的配置开关保护。 |

配置快捷字段会被归一化到以下文档形状：

```json
{
  "schemaVersion": 1,
  "adapter": "mysql",
  "connection": {
    "host": "127.0.0.1",
    "port": 3306,
    "database": "业务库",
    "user": "claude_reader",
    "password": "仅保存在本机文件",
    "ssl": { "mode": "disabled" }
  },
  "permissions": {
    "allowWrite": false,
    "allowDdl": false,
    "allowDestructive": false
  },
  "runtime": {
    "connectionLimit": 4,
    "connectTimeoutMs": 10000,
    "queryTimeoutMs": 30000
  }
}
```

多环境文档使用以下形状；每个环境必须有自己的连接字段，权限和运行参数可以写在环境内：

```json
{
  "schemaVersion": 1,
  "adapter": "mysql",
  "defaultEnvironment": "dev",
  "environments": {
    "dev": {
      "connection": { "host": "127.0.0.1", "port": 3306, "database": "app_dev", "user": "reader", "password": "仅保存在本机文件" },
      "permissions": { "allowWrite": false, "allowDdl": false, "allowDestructive": false }
    },
    "prod": {
      "connection": { "host": "prod-db.example.com", "port": 3306, "database": "app_prod", "user": "reader_prod", "password": "仅保存在本机文件" }
    }
  }
}
```

环境名限制为 1–64 个 Unicode 字母或数字（首字符）以及 `.`、`_`、`-`。多环境文档没有 `defaultEnvironment` 时，数据库工具必须显式传 `environment`；这样配置文件不会暗示一个未经用户选择的目标。旧版单连接文档仍按单一环境兼容。

## 安全不变量

1. 连接池显式开启 `multipleStatements`。SQL 分析器会拆分并检查每一条语句；`database_query` 中的每条语句都必须是读形式，`database_execute` 中的每条语句都必须是受支持的 DML 或 DDL。
2. 多语句、SQL 函数、无 `WHERE` 的 `UPDATE`/`DELETE` 和完整结果集均允许通过；服务不执行危险函数黑名单，也不按行数或结果字节数截断。驱动仍负责参数转义和数据库自身的权限判断。
3. `database_query` 不执行 DML、DDL、管理语句、锁定读取、可执行注释或服务端文件导出；服务端文件导入导出属于文件系统边界，始终拒绝。
4. `database_execute` 没有 `confirm=true` 时不会打开数据库连接。DML、DDL 和破坏性 DDL 的默认开关均为 `false`。
5. `UPDATE`、`DELETE` 和写入型 `WITH` 可以不包含 `WHERE`。账号、服务器和数据库级管理语句始终拒绝。
6. 返回值将 `BigInt`、日期和二进制值转换为 JSON 安全表示，不做结果截断。多语句写入遵循 MySQL 自动提交，不提供跨调用事务。
7. 配置错误仍允许 MCP 完成握手，Claude Code 可以通过 `database_config_status` 和 `database_configure` 修复配置。所有状态、错误、日志和工具响应都不得包含密码、TLS 私钥或完整连接 URL。

## 模块数据流

```text
Claude Code
    │ stdio / JSON-RPC
    ▼
src/index.js ── database_config_* ──► src/config.js ──► settings.json
    │                                      │
    └── database_* ──► environment resolver ──► src/db.js ◄────┘
                           │
                    src/sql.js policy
                           │
                         MySQL
```

重载先完整读取环境目录和默认环境，再创建默认环境的惰性连接池；显式请求的其他环境按需创建连接池。重载成功后关闭旧池；这样文件编辑或新版本配置出错时不会立即丢失仍可用的连接。
