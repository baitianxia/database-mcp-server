import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  configurationStatus,
  listEnvironments,
  loadConfig,
  resolveConfigPath,
  setDefaultEnvironment,
  summarizeConfig,
  updateConfig,
  updateEnvironmentConfig,
} from './config.js';
import { createDatabase } from './db.js';

const VERSION = '0.2.5';
const SERVER_NAME = 'database-mcp';
const DISPLAY_NAME = '数据库助手（当前支持 MySQL）';
const configPath = resolveConfigPath();

let config = null;
let configError = null;
let databases = new Map();
let environmentCatalog = null;

function asConfigError(error, fallback = 'Database configuration could not be loaded.') {
  return error instanceof ConfigError ? error : new ConfigError(fallback);
}

async function closeDatabaseMap(databaseMap) {
  for (const database of databaseMap.values()) {
    try {
      await database.close();
    } catch (error) {
      console.error('Previous database pool could not be closed:', error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Refresh the configuration catalogue and the optional default pool. Pools for
 * explicitly requested environments are created lazily by databaseForEnvironment.
 */
async function reloadRuntime({ allowInvalidDefault = false } = {}) {
  const catalog = await listEnvironments({ configPath });
  let nextConfig = null;
  let nextError = null;
  const fallbackEnvironment = catalog.defaultEnvironment
    || (catalog.legacySingleEnvironment ? 'default' : null);
  if (fallbackEnvironment) {
    try {
      nextConfig = await loadConfig({ configPath, environment: fallbackEnvironment });
    } catch (error) {
      if (!allowInvalidDefault) throw error;
      nextError = asConfigError(error);
    }
  }
  const nextDatabases = new Map();
  if (nextConfig) nextDatabases.set(nextConfig.environment, createDatabase(nextConfig));
  const previousDatabases = databases;
  databases = nextDatabases;
  environmentCatalog = catalog;
  config = nextConfig;
  configError = nextError;
  await closeDatabaseMap(previousDatabases);
  return { catalog, config: nextConfig };
}

async function initializeRuntime() {
  try {
    await reloadRuntime({ allowInvalidDefault: true });
  } catch (error) {
    configError = asConfigError(error);
    environmentCatalog = null;
    config = null;
    databases = new Map();
  }
}

await initializeRuntime();

const initialMissing = configError?.missing || [];
const initialConfigurationHint = initialMissing.length
  ? `当前缺失字段：${initialMissing.join('、')}。`
  : (configError ? `当前配置不可用：${configError.code}。` : '配置目录已加载；数据库工具会根据显式 environment 或 defaultEnvironment 选择连接。');

const server = new McpServer(
  { name: SERVER_NAME, version: VERSION },
  {
    instructions: [
      `${DISPLAY_NAME}通过 stdio 提供数据库工具；当前 adapter 是 MySQL。`,
      `配置文件路径为 ${configPath}，schemaVersion 为 ${CONFIG_SCHEMA_VERSION}。`,
      initialConfigurationHint,
      '多环境配置使用 environments 对象；可选的 defaultEnvironment 只用于未传 environment 的调用，不保存当前环境。没有默认环境时，数据库工具必须显式传 environment。',
      '首次使用请调用 database_config_status 或 database_environment_list 查看配置，再调用 database_configure 写入配置；配置变更后调用 database_config_reload。',
      '状态、错误和工具结果不会返回密码。多语句、SQL 函数、无 WHERE 的 UPDATE/DELETE 和完整结果集均按 MySQL 交给服务器处理；服务不按行数或结果字节数截断。',
      'DML/DDL 默认关闭；database_execute 还需要 confirm=true，并同时满足配置中的权限开关。',
    ].join(' '),
  },
);

const scalarParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const paramsSchema = z.array(
  z.union([scalarParamSchema, z.array(scalarParamSchema)]),
).optional().default([]);

const configPatchSchema = z.object({
  // `settings` and `config` make it possible to submit the documented JSON shape directly.
  settings: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  config: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  // `environment` scopes a patch to one named environment. `defaultEnvironment`
  // changes the optional fallback used by database tools that omit `environment`.
  environment: z.string().optional(),
  defaultEnvironment: z.string().nullable().optional(),
  setAsDefault: z.boolean().optional(),
  adapter: z.string().optional(),
  host: z.string().optional(),
  address: z.string().optional(),
  port: z.union([z.number(), z.string()]).optional(),
  database: z.string().optional(),
  db: z.string().optional(),
  user: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  socketPath: z.string().optional(),
  socket: z.string().optional(),
  charset: z.string().optional(),
  timezone: z.string().optional(),
  ssl: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  tls: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  allowWrite: z.boolean().optional(),
  allowDdl: z.boolean().optional(),
  allowDestructive: z.boolean().optional(),
  connectionLimit: z.union([z.number(), z.string()]).optional(),
  connectTimeoutMs: z.union([z.number(), z.string()]).optional(),
  queryTimeoutMs: z.union([z.number(), z.string()]).optional(),
  connection: z.record(z.string(), z.unknown()).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  runtime: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorResult(error) {
  const code = error?.code || 'MCP_TOOL_ERROR';
  let message = error instanceof Error ? error.message : String(error);
  const configuredPasswords = [
    config?.password,
    ...Array.from(databases.values(), (database) => database?.config?.password),
  ].filter(Boolean);
  for (const configuredPassword of configuredPasswords) {
    message = message.split(configuredPassword).join('[REDACTED]');
  }
  message = message.replace(/mysql(?:2)?:\/\/[^\s)]+/gi, 'mysql://[REDACTED]');
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: { code, message } }, null, 2),
    }],
    isError: true,
  };
}

function serverStatus() {
  return {
    server: { name: SERVER_NAME, displayName: DISPLAY_NAME, version: VERSION },
    fallbackConfiguration: config ? summarizeConfig(config) : {
      configured: false,
      configPath,
      missing: configError?.missing || [],
    },
    defaultEnvironment: environmentCatalog?.defaultEnvironment || null,
    environmentRequired: environmentCatalog?.environmentRequired || false,
    environments: environmentCatalog?.environments || [],
    policy: {
      multipleStatements: true,
      functionRestrictions: false,
      whereClauseRequired: false,
      resultLimits: false,
      writeConfirmationRequired: true,
    },
  };
}

function requestedEnvironment(environment) {
  if (environment !== undefined && environment !== null) {
    const normalized = String(environment).trim();
    if (!normalized) {
      throw new ConfigError('environment cannot be empty.', ['environment'], 'INVALID_ENVIRONMENT');
    }
    return normalized;
  }
  if (environmentCatalog?.defaultEnvironment) return environmentCatalog.defaultEnvironment;
  if (environmentCatalog?.legacySingleEnvironment) return 'default';
  if (configError && !environmentCatalog) throw configError;
  throw new ConfigError(
    'No default environment is configured. Pass environment explicitly or set a default with database_environment_set_default.',
    ['environment'],
    'ENVIRONMENT_REQUIRED',
  );
}

async function databaseForEnvironment(environment) {
  const name = requestedEnvironment(environment);
  if (databases.has(name)) return databases.get(name);
  const nextConfig = await loadConfig({ configPath, environment: name });
  const nextDatabase = createDatabase(nextConfig);
  databases.set(name, nextDatabase);
  return nextDatabase;
}

function patchFromArguments(args) {
  const supplied = args.settings || args.config || {};
  let base = supplied;
  if (typeof supplied === 'string') {
    try {
      base = JSON.parse(supplied);
    } catch {
      throw new ConfigError('settings must contain valid JSON.');
    }
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    throw new ConfigError('settings must be a JSON object.');
  }
  const patch = { ...base };
  if (args.environment !== undefined) patch.environment = args.environment;
  if (args.defaultEnvironment !== undefined) patch.defaultEnvironment = args.defaultEnvironment;
  if (args.setAsDefault !== undefined) patch.setAsDefault = args.setAsDefault;
  if (args.adapter !== undefined) patch.adapter = args.adapter;
  const connection = { ...(patch.connection || {}), ...(args.connection || {}) };
  const connectionFields = [
    'host', 'address', 'port', 'database', 'db', 'user', 'username', 'password', 'socketPath', 'socket', 'charset', 'timezone', 'ssl', 'tls',
  ];
  for (const field of connectionFields) {
    if (args[field] !== undefined) connection[field] = args[field];
    else if (patch[field] !== undefined) connection[field] = patch[field];
  }
  if (Object.keys(connection).length) patch.connection = connection;
  const permissions = { ...(patch.permissions || {}), ...(args.permissions || {}) };
  for (const field of ['allowWrite', 'allowDdl', 'allowDestructive']) {
    if (args[field] !== undefined) permissions[field] = args[field];
    else if (patch[field] !== undefined) permissions[field] = patch[field];
  }
  if (Object.keys(permissions).length) patch.permissions = permissions;
  const runtime = { ...(patch.runtime || {}), ...(args.runtime || {}) };
  for (const field of ['connectionLimit', 'connectTimeoutMs', 'queryTimeoutMs']) {
    if (args[field] !== undefined) runtime[field] = args[field];
    else if (patch[field] !== undefined) runtime[field] = patch[field];
  }
  if (Object.keys(runtime).length) patch.runtime = runtime;
  return patch;
}

server.registerTool('database_config_status', {
  title: '数据库配置状态',
  description: '查看配置文件路径、schema 版本、环境列表、默认环境、缺失字段和非敏感连接摘要；不会建立数据库连接，也不会返回密码。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const file = await configurationStatus({ configPath });
  return result({
    ...serverStatus(),
    configPath: file.path,
    schemaVersion: file.schemaVersion,
    configuration: file.configuration,
    missing: file.missing,
    defaultEnvironment: file.defaultEnvironment,
    defaultEnvironmentError: file.defaultEnvironmentError,
    environmentRequired: file.environmentRequired ?? false,
    environments: file.environments,
    nextSteps: file.nextSteps,
    file,
  });
});

server.registerTool('database_configure', {
  title: '写入数据库配置',
  description: '创建或更新用户目录中的 settings.json。传 environment 可只修改一个环境；传 setAsDefault=true 可把该环境设为默认。也可传完整 environments 配置。密码只写入本地配置文件，响应中永不回显。',
  inputSchema: configPatchSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  try {
    const patch = patchFromArguments(args);
    const targetEnvironment = patch.environment;
    const setAsDefault = patch.setAsDefault === true;
    const requestedDefault = patch.defaultEnvironment;
    let savedEnvironment = targetEnvironment;
    const hasOtherPatchFields = Object.keys(patch).some((key) => key !== 'defaultEnvironment');
    let updateResult;
    delete patch.environment;
    delete patch.setAsDefault;
    if (targetEnvironment !== undefined) {
      const targetIsDefault = requestedDefault !== undefined
        && requestedDefault !== null
        && requestedDefault === targetEnvironment;
      updateResult = await updateEnvironmentConfig(patch, targetEnvironment, configPath, {
        setAsDefault: setAsDefault || targetIsDefault,
      });
      if (requestedDefault !== undefined && requestedDefault !== null && requestedDefault !== targetEnvironment) {
        await setDefaultEnvironment(requestedDefault, configPath);
      } else if (requestedDefault === null) {
        updateResult = await updateConfig({ defaultEnvironment: null }, configPath);
      }
    } else if (requestedDefault !== undefined && !patch.environments && !hasOtherPatchFields) {
      if (requestedDefault === null) {
        updateResult = await updateConfig({ defaultEnvironment: null }, configPath);
        savedEnvironment = null;
      } else {
        updateResult = await setDefaultEnvironment(requestedDefault, configPath);
        savedEnvironment = requestedDefault;
      }
    } else {
      updateResult = await updateConfig(patch, configPath);
    }
    const runtime = await reloadRuntime({ allowInvalidDefault: true });
    const savedConfig = savedEnvironment
      ? await loadConfig({ configPath, environment: savedEnvironment })
      : (updateResult?.config || runtime.config);
    return result({
      saved: true,
      path: configPath,
      defaultEnvironment: runtime.catalog.defaultEnvironment,
      defaultEnvironmentError: runtime.catalog.defaultEnvironmentError,
      environmentRequired: runtime.catalog.environmentRequired,
      environments: runtime.catalog.environments,
      environment: savedEnvironment || null,
      configuration: savedConfig ? summarizeConfig(savedConfig) : null,
      fallbackConfiguration: runtime.config ? summarizeConfig(runtime.config) : null,
      message: '配置已保存并重新加载。',
    });
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_config_reload', {
  title: '重新加载数据库配置',
  description: '重新读取 settings.json 并替换已缓存的环境连接池；适用于用户在 Claude Code 或编辑器中修改配置后立即生效。不会返回密码。',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const runtime = await reloadRuntime();
    return result({
      reloaded: true,
      defaultEnvironment: runtime.catalog.defaultEnvironment,
      defaultEnvironmentError: runtime.catalog.defaultEnvironmentError,
      environmentRequired: runtime.catalog.environmentRequired,
      environments: runtime.catalog.environments,
      configuration: runtime.config ? summarizeConfig(runtime.config) : null,
    });
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_environment_list', {
  title: '列出数据库环境',
  description: '列出 settings.json 中的所有数据库环境及其脱敏状态；不会建立数据库连接，也不会返回密码。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const catalog = await listEnvironments({ configPath });
    environmentCatalog = catalog;
    return result(catalog);
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_environment_set_default', {
  title: '设置默认数据库环境',
  description: '设置未传 environment 的数据库工具所使用的默认环境；不会保存或切换当前环境。',
  inputSchema: { environment: z.string().min(1).max(64) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ environment }) => {
  try {
    await setDefaultEnvironment(environment, configPath);
    const runtime = await reloadRuntime({ allowInvalidDefault: true });
    return result({
      saved: true,
      defaultEnvironment: runtime.catalog.defaultEnvironment,
      defaultEnvironmentError: runtime.catalog.defaultEnvironmentError,
      environmentRequired: runtime.catalog.environmentRequired,
      environments: runtime.catalog.environments,
      configuration: runtime.config ? summarizeConfig(runtime.config) : null,
    });
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_ping', {
  title: '测试数据库连接',
  description: '使用指定环境（或已配置的 defaultEnvironment）建立 MySQL 连接并返回版本、当前数据库和认证用户。',
  inputSchema: { environment: z.string().min(1).max(64).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ environment }) => {
  try {
    return result(await (await databaseForEnvironment(environment)).ping());
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_list_tables', {
  title: '列出数据库表',
  description: '列出指定环境（或 defaultEnvironment）数据库中的表和视图。',
  inputSchema: { environment: z.string().min(1).max(64).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ environment }) => {
  try {
    return result(await (await databaseForEnvironment(environment)).listTables());
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_describe_table', {
  title: '查看表结构',
  description: '返回指定环境中表的字段和索引元数据。',
  inputSchema: {
    table: z.string().min(1).max(64).regex(/^[^\u0000-\u001F\u007F]+$/u),
    environment: z.string().min(1).max(64).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ table, environment }) => {
  try {
    return result(await (await databaseForEnvironment(environment)).describeTable(table));
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_query', {
  title: '执行数据库查询',
  description: '在指定环境（或 defaultEnvironment）执行一条或多条读形式 SQL。支持 ? 参数、多语句、SQL 函数和完整结果集；服务不按行数或结果大小截断。',
  inputSchema: {
    sql: z.string().min(1).max(100_000),
    params: paramsSchema,
    environment: z.string().min(1).max(64).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ sql, params, environment }) => {
  try {
    return result(await (await databaseForEnvironment(environment)).query(sql, params));
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool('database_execute', {
  title: '执行数据库写入',
  description: '在指定环境（或 defaultEnvironment）执行一条或多条 INSERT、UPDATE、DELETE、REPLACE 或已启用的 DDL。支持多语句、SQL 函数和不带 WHERE 的 UPDATE/DELETE；必须传 confirm=true，且仍受权限开关保护。',
  inputSchema: {
    sql: z.string().min(1).max(100_000),
    params: paramsSchema,
    confirm: z.boolean().optional().default(false),
    environment: z.string().min(1).max(64).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async ({ sql, params, confirm, environment }) => {
  try {
    return result(await (await databaseForEnvironment(environment)).execute(sql, params, confirm));
  } catch (error) {
    return errorResult(error);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

let shutdownPromise;
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      await closeDatabaseMap(databases);
      databases = new Map();
      await server.close();
    } catch (error) {
      console.error('Shutdown error:', error instanceof Error ? error.message : String(error));
    }
  })();
  return shutdownPromise;
}

const terminate = () => { void shutdown().finally(() => process.exit(0)); };
process.once('SIGINT', terminate);
process.once('SIGTERM', terminate);
process.stdin.once('end', terminate);

main().catch((error) => {
  console.error('MCP server error:', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
