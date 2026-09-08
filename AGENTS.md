# Database MCP Server 项目约定

## 当前规范

- [README.md](README.md) 是安装、配置、工具边界和安全默认值的用户侧规范。
- [docs/architecture.md](docs/architecture.md) 是 MCP 工具契约和模块边界的实现规范。
- 上级 `/Users/baitianxia/project/AGENTS.md` 仅在涉及 Windows 开发时补充跨项目约束。

## 变更要求

- 默认关闭 DML/DDL；扩大写权限或调整 SQL 执行策略时必须同时更新 README 和架构文档。
- 任何 SQL 执行策略变化都要有对应的单元测试。
- 密码、完整连接 URL 和 TLS 私钥不得进入日志、测试输出或提交的配置文件。
- MCP stdio 的 stdout 只能输出协议消息；诊断信息写 stderr。
