import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIG_DIRECTORY = 'database-mcp-server';
export const DEFAULT_CONFIG_FILE = 'settings.json';
export const DEFAULT_ENVIRONMENT = 'default';

// Environment names are persisted as JSON object keys and may be echoed in
// diagnostics. Keep them deliberately small and shell/path safe.
const ENVIRONMENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3306;
const DEFAULT_CONNECTION_LIMIT = 4;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const VALID_SSL_MODES = new Set(['disabled', 'required', 'verify_ca', 'verify_identity']);

export class ConfigError extends Error {
  constructor(message, missing = [], code = 'CONFIGURATION_ERROR') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.missing = [...missing];
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function stringValue(value, field, { trim = true, allowEmpty = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ConfigError(`${field} must be a string.`);
  }
  const output = String(value);
  const normalized = trim ? output.trim() : output;
  if (!allowEmpty && normalized.length === 0) {
    throw new ConfigError(`${field} cannot be empty.`);
  }
  return normalized;
}

function environmentValue(value, field = 'environment') {
  const normalized = stringValue(value, field);
  if (!ENVIRONMENT_NAME_PATTERN.test(normalized)) {
    throw new ConfigError(
      `${field} must start with a Unicode letter or number and contain only letters, numbers, ., _, or - (1–64 characters).`,
      [field],
      'INVALID_ENVIRONMENT',
    );
  }
  return normalized;
}

function integerValue(value, field, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = typeof value === 'number' ? value : String(value).trim();
  if ((typeof normalized === 'string' && !/^[0-9]+$/.test(normalized))
    || (typeof normalized !== 'string' && !Number.isInteger(normalized))) {
    throw new ConfigError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  const output = Number(normalized);
  if (!Number.isSafeInteger(output) || output < minimum || output > maximum) {
    throw new ConfigError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return output;
}

function booleanValue(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  throw new ConfigError(`${field} must be true or false.`);
}

function homeDirectory(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/** Resolve the user-owned configuration path. DATABASE_CONFIG_PATH is the only environment override. */
export function resolveConfigPath(env = process.env) {
  const override = typeof env.DATABASE_CONFIG_PATH === 'string'
    ? env.DATABASE_CONFIG_PATH.trim()
    : '';
  if (override) return path.resolve(override);
  return path.join(homeDirectory(env), DEFAULT_CONFIG_DIRECTORY, 'config', DEFAULT_CONFIG_FILE);
}

function resolveOptionalFile(file, configPath, field) {
  if (file === undefined || file === null || file === '') return undefined;
  const value = stringValue(file, field);
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value);
}

function readFileIfPresent(filePath, field) {
  try {
    return fsSync.readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigError(`${field} could not be read.`);
  }
}

function readSsl(rawSsl, configPath) {
  if (rawSsl === undefined || rawSsl === null) {
    return { mode: 'disabled', options: undefined, document: { mode: 'disabled' } };
  }
  const ssl = typeof rawSsl === 'string' ? { mode: rawSsl } : rawSsl;
  if (!isObject(ssl)) throw new ConfigError('connection.ssl must be an object or a mode string.');
  const mode = (stringValue(ssl.mode, 'connection.ssl.mode', { allowEmpty: true }) || 'disabled').toLowerCase();
  if (!VALID_SSL_MODES.has(mode)) {
    throw new ConfigError('connection.ssl.mode must be disabled, required, verify_ca, or verify_identity.');
  }
  if (mode === 'disabled') return { mode, options: undefined, document: { mode } };

  const options = { rejectUnauthorized: mode !== 'required' };
  const caFile = resolveOptionalFile(firstDefined(ssl.caFile, ssl.caPath), configPath, 'connection.ssl.caFile');
  const certFile = resolveOptionalFile(firstDefined(ssl.certFile, ssl.certPath), configPath, 'connection.ssl.certFile');
  const keyFile = resolveOptionalFile(firstDefined(ssl.keyFile, ssl.keyPath), configPath, 'connection.ssl.keyFile');
  if (caFile) options.ca = readFileIfPresent(caFile, 'connection.ssl.caFile');
  if (certFile) options.cert = readFileIfPresent(certFile, 'connection.ssl.certFile');
  if (keyFile) options.key = readFileIfPresent(keyFile, 'connection.ssl.keyFile');
  // Inline PEM values are accepted for advanced users and omitted from summaries.
  if (!options.ca && typeof ssl.ca === 'string') options.ca = ssl.ca;
  if (!options.cert && typeof ssl.cert === 'string') options.cert = ssl.cert;
  if (!options.key && typeof ssl.key === 'string') options.key = ssl.key;
  if ((mode === 'verify_ca' || mode === 'verify_identity') && !options.ca) {
    throw new ConfigError('connection.ssl.ca or connection.ssl.caFile is required when certificates are verified.');
  }
  const document = { mode };
  for (const key of ['caFile', 'caPath', 'certFile', 'certPath', 'keyFile', 'keyPath', 'ca', 'cert', 'key']) {
    if (ssl[key] !== undefined) document[key] = ssl[key];
  }
  return { mode, options, document };
}

function rawConnection(raw) {
  const nested = isObject(raw.connection)
    ? raw.connection
    : (isObject(raw.mysql) ? raw.mysql : raw);
  return { raw: nested, nested: nested !== raw };
}

function hasEnvironmentDocument(raw) {
  return isObject(raw?.environments);
}

function environmentNames(raw) {
  if (own(raw || {}, 'environments') && !isObject(raw.environments)) {
    throw new ConfigError('environments must be a JSON object.', ['environments']);
  }
  if (!hasEnvironmentDocument(raw)) return [DEFAULT_ENVIRONMENT];
  const names = Object.keys(raw.environments);
  for (const name of names) environmentValue(name, 'environment name');
  return names;
}

function environmentDefaults(raw) {
  // Permissions and runtime values may be shared by all environments. A
  // per-environment value always wins. Connection fields intentionally are not
  // inherited because silently sharing a host or password is too easy to miss.
  return {
    ...(isObject(raw?.permissions) ? { permissions: deepMerge({}, raw.permissions) } : {}),
    ...(isObject(raw?.runtime) ? { runtime: deepMerge({}, raw.runtime) } : {}),
  };
}

function selectEnvironmentRaw(raw, requestedEnvironment) {
  const names = environmentNames(raw);
  if (!hasEnvironmentDocument(raw)) {
    const requested = requestedEnvironment === undefined
      ? DEFAULT_ENVIRONMENT
      : environmentValue(requestedEnvironment);
    if (requested !== DEFAULT_ENVIRONMENT) {
      throw new ConfigError(
        `Environment '${requested}' is not configured.`,
        ['environment'],
        'ENVIRONMENT_NOT_FOUND',
      );
    }
    return {
      name: DEFAULT_ENVIRONMENT,
      raw,
      names,
      defaultEnvironment: null,
      legacy: true,
    };
  }

  const configuredDefault = raw.defaultEnvironment === undefined || raw.defaultEnvironment === null
    ? undefined
    : environmentValue(raw.defaultEnvironment, 'defaultEnvironment');
  const requested = requestedEnvironment === undefined ? configuredDefault : environmentValue(requestedEnvironment);
  if (requested === undefined) {
    throw new ConfigError(
      'No default environment is configured. Specify an environment explicitly.',
      ['environment'],
      'ENVIRONMENT_REQUIRED',
    );
  }
  if (!own(raw.environments, requested)) {
    throw new ConfigError(
      `Environment '${requested}' is not configured.`,
      ['environment'],
      'ENVIRONMENT_NOT_FOUND',
    );
  }
  const selected = raw.environments[requested];
  if (!isObject(selected)) {
    throw new ConfigError(`Environment '${requested}' must be a JSON object.`, ['environment']);
  }
  const defaults = environmentDefaults(raw);
  return {
    name: requested,
    raw: {
      ...defaults,
      ...selected,
      ...(isObject(defaults.permissions) && isObject(selected.permissions)
        ? { permissions: deepMerge(defaults.permissions, selected.permissions) }
        : {}),
      ...(isObject(defaults.runtime) && isObject(selected.runtime)
        ? { runtime: deepMerge(defaults.runtime, selected.runtime) }
        : {}),
    },
    names,
    defaultEnvironment: configuredDefault || null,
    legacy: false,
  };
}

function canonicalSettings(raw, configPath, { requireCredentials = true, environment } = {}) {
  if (!isObject(raw)) throw new ConfigError('Configuration must be a JSON object.');
  const schemaVersion = integerValue(
    firstDefined(raw.schemaVersion, raw.version),
    'schemaVersion',
    CONFIG_SCHEMA_VERSION,
    1,
    CONFIG_SCHEMA_VERSION,
  );
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported configuration schemaVersion: ${schemaVersion}.`);
  }
  const adapter = String(firstDefined(raw.adapter, raw.database?.adapter, 'mysql')).trim().toLowerCase();
  if (adapter !== 'mysql') {
    throw new ConfigError(`Unsupported database adapter: ${adapter}.`, ['adapter']);
  }

  const selected = selectEnvironmentRaw(raw, environment);
  const selectedRaw = selected.raw;
  const { raw: connection } = rawConnection(selectedRaw);
  const permissions = isObject(selectedRaw.permissions) ? selectedRaw.permissions : selectedRaw;
  const runtime = isObject(selectedRaw.runtime) ? selectedRaw.runtime : selectedRaw;
  const host = stringValue(firstDefined(connection.host, connection.address, DEFAULT_HOST), 'connection.host');
  const port = integerValue(connection.port, 'connection.port', DEFAULT_PORT, 1, 65_535);
  const database = stringValue(firstDefined(connection.database, connection.db), 'connection.database', { allowEmpty: true });
  const user = stringValue(firstDefined(connection.user, connection.username), 'connection.user', { trim: false, allowEmpty: true });
  const passwordConfigured = own(connection, 'password') && connection.password !== null && connection.password !== undefined;
  const password = passwordConfigured
    ? stringValue(connection.password, 'connection.password', { trim: false, allowEmpty: true })
    : undefined;
  const missing = [];
  if (!database) missing.push('connection.database');
  if (!user) missing.push('connection.user');
  if (!passwordConfigured) missing.push('connection.password');
  if (requireCredentials && missing.length) {
    throw new ConfigError(
      `Database connection is not configured. Set ${missing.join(', ')} in ${configPath}.`,
      missing,
    );
  }

  const socketPath = stringValue(
    firstDefined(connection.socketPath, connection.socket),
    'connection.socketPath',
    { allowEmpty: true },
  );
  const charset = stringValue(firstDefined(connection.charset, 'utf8mb4'), 'connection.charset');
  if (!/^[A-Za-z0-9_]+$/.test(charset)) throw new ConfigError('connection.charset contains unsupported characters.');
  const timezone = stringValue(firstDefined(connection.timezone, 'Z'), 'connection.timezone');
  const ssl = readSsl(firstDefined(connection.ssl, connection.tls), configPath);

  const config = {
    schemaVersion,
    adapter,
    configPath,
    environment: selected.name,
    defaultEnvironment: selected.defaultEnvironment,
    availableEnvironments: selected.names,
    legacySingleEnvironment: selected.legacy,
    host,
    port,
    database,
    user,
    password,
    passwordSource: passwordConfigured ? 'config-file' : 'missing',
    socketPath: socketPath || undefined,
    charset,
    timezone,
    sslMode: ssl.mode,
    ssl: ssl.options,
    sslConfig: ssl.document,
    allowWrite: booleanValue(firstDefined(permissions.allowWrite, selectedRaw.allowWrite), 'permissions.allowWrite', false),
    allowDdl: booleanValue(firstDefined(permissions.allowDdl, selectedRaw.allowDdl), 'permissions.allowDdl', false),
    allowDestructive: booleanValue(
      firstDefined(permissions.allowDestructive, selectedRaw.allowDestructive),
      'permissions.allowDestructive',
      false,
    ),
    connectionLimit: integerValue(
      firstDefined(runtime.connectionLimit, selectedRaw.connectionLimit),
      'runtime.connectionLimit',
      DEFAULT_CONNECTION_LIMIT,
      1,
      32,
    ),
    connectTimeoutMs: integerValue(
      firstDefined(runtime.connectTimeoutMs, selectedRaw.connectTimeoutMs),
      'runtime.connectTimeoutMs',
      DEFAULT_CONNECT_TIMEOUT_MS,
      1_000,
      120_000,
    ),
    queryTimeoutMs: integerValue(
      firstDefined(runtime.queryTimeoutMs, selectedRaw.queryTimeoutMs),
      'runtime.queryTimeoutMs',
      DEFAULT_QUERY_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    missing,
  };
  return Object.freeze(config);
}

export function parseConfig(raw, configPath = resolveConfigPath(), options = {}) {
  const normalizedOptions = typeof options === 'string' ? { environment: options } : options;
  return canonicalSettings(raw, path.resolve(configPath), normalizedOptions || {});
}

function decodeJsonBytes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/u, '');
}

async function readRawJsonFile(resolved) {
  const bytes = await fs.readFile(resolved);
  try {
    return JSON.parse(decodeJsonBytes(bytes));
  } catch {
    throw new ConfigError(`Configuration file is not valid JSON: ${resolved}.`, [], 'CONFIGURATION_INVALID');
  }
}

async function readSettingsDocument(configPath = resolveConfigPath()) {
  const resolved = path.resolve(configPath);
  let raw;
  try {
    raw = await readRawJsonFile(resolved);
  } catch (error) {
    if (error instanceof ConfigError && error.code === 'CONFIGURATION_INVALID') throw error;
    if (error?.code === 'ENOENT') {
      throw new ConfigError(
        `Configuration file was not found: ${resolved}.`,
        ['configuration file'],
        'CONFIGURATION_NOT_FOUND',
      );
    }
    throw new ConfigError(`Configuration file could not be read: ${resolved}.`);
  }
  return { path: resolved, raw };
}

export async function readSettingsFile(configPath = resolveConfigPath(), options = {}) {
  const document = await readSettingsDocument(configPath);
  return { ...document, config: canonicalSettings(document.raw, document.path, options) };
}

/** Load the configured JSON file. The optional argument is useful for tests and embedding. */
export async function loadConfig(options) {
  const supplied = options !== undefined;
  const input = options === undefined ? {} : options;
  if (isObject(input) && (
    own(input, 'connection')
    || own(input, 'mysql')
    || own(input, 'host')
    || own(input, 'address')
    || own(input, 'database')
    || own(input, 'db')
    || own(input, 'user')
    || own(input, 'username')
    || own(input, 'password')
    || own(input, 'socketPath')
    || own(input, 'socket')
    || own(input, 'charset')
    || own(input, 'timezone')
    || own(input, 'ssl')
    || own(input, 'tls')
    || own(input, 'schemaVersion')
    || own(input, 'adapter')
    || own(input, 'environments')
    || own(input, 'defaultEnvironment')
  )) {
    const rawPath = input.configPath || resolveConfigPath(input.env || process.env);
    return parseConfig(input, rawPath, { environment: input.environment });
  }
  const optionObject = input;
  const hasExplicitOptions = own(optionObject, 'configPath') || own(optionObject, 'env') || own(optionObject, 'environment');
  const configPath = optionObject.configPath;
  const env = hasExplicitOptions
    ? (optionObject.env || process.env)
    : (supplied && Object.keys(optionObject).length ? optionObject : process.env);
  const resolved = path.resolve(configPath || resolveConfigPath(env));
  return (await readSettingsFile(resolved, { environment: optionObject.environment })).config;
}

function deepMerge(base, patch) {
  if (!isObject(base)) return isObject(patch) ? { ...patch } : patch;
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isObject(value) && isObject(output[key])) output[key] = deepMerge(output[key], value);
    else output[key] = value;
  }
  return output;
}

function normalizeUpdatePatch(patch) {
  const output = { ...patch };
  const connection = isObject(output.connection) ? { ...output.connection } : {};
  let hasConnectionFields = false;
  for (const field of ['host', 'address', 'port', 'database', 'db', 'user', 'username', 'password', 'socketPath', 'socket', 'charset', 'timezone', 'ssl', 'tls']) {
    if (!own(output, field)) continue;
    // A nested `database` object is reserved for adapter metadata; a scalar is
    // the documented flat connection alias.
    if (field === 'database' && isObject(output[field])) continue;
    connection[field] = output[field];
    delete output[field];
    hasConnectionFields = true;
  }
  if (hasConnectionFields) output.connection = connection;

  const permissions = isObject(output.permissions) ? { ...output.permissions } : {};
  let hasPermissions = false;
  for (const field of ['allowWrite', 'allowDdl', 'allowDestructive']) {
    if (!own(output, field)) continue;
    permissions[field] = output[field];
    delete output[field];
    hasPermissions = true;
  }
  if (hasPermissions) output.permissions = permissions;

  const runtime = isObject(output.runtime) ? { ...output.runtime } : {};
  let hasRuntime = false;
  for (const field of ['connectionLimit', 'connectTimeoutMs', 'queryTimeoutMs']) {
    if (!own(output, field)) continue;
    runtime[field] = output[field];
    delete output[field];
    hasRuntime = true;
  }
  if (hasRuntime) output.runtime = runtime;
  return output;
}

function hasEnvironmentScopedFields(patch) {
  if (!isObject(patch)) return false;
  const fields = [
    'host', 'address', 'port', 'database', 'db', 'user', 'username', 'password',
    'socketPath', 'socket', 'charset', 'timezone', 'ssl', 'tls', 'connection',
  ];
  return fields.some((field) => own(patch, field));
}

function canonicalForFile(config) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    adapter: config.adapter,
    connection: {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ...(config.socketPath ? { socketPath: config.socketPath } : {}),
      charset: config.charset,
      timezone: config.timezone,
      ssl: config.sslConfig || { mode: config.sslMode },
    },
    permissions: {
      allowWrite: config.allowWrite,
      allowDdl: config.allowDdl,
      allowDestructive: config.allowDestructive,
    },
    runtime: {
      connectionLimit: config.connectionLimit,
      connectTimeoutMs: config.connectTimeoutMs,
      queryTimeoutMs: config.queryTimeoutMs,
    },
  };
}

function hardenFilePermissions(filePath) {
  try {
    fsSync.chmodSync(filePath, 0o600);
  } catch {
    // chmod is unavailable on some Windows filesystems; the installer applies ACLs there.
  }
  if (process.platform === 'win32') {
    const username = process.env.USERNAME;
    if (username) {
      const identity = process.env.USERDOMAIN
        ? `${process.env.USERDOMAIN}\\${username}`
        : username;
      try {
        spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${identity}:F`, '/c'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // Keep the config usable when icacls is unavailable (for example in a test shim).
      }
    }
  }
}

async function writeDocument(document, configPath) {
  const resolved = path.resolve(configPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    hardenFilePermissions(temporary);
    await fs.rename(temporary, resolved);
    hardenFilePermissions(resolved);
  } catch (error) {
    try { await fs.unlink(temporary); } catch { /* best effort cleanup */ }
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Configuration file could not be written: ${resolved}.`);
  }
  return resolved;
}

async function readExistingDocument(resolved) {
  try {
    return (await readSettingsDocument(resolved)).raw;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (error.code === 'CONFIGURATION_NOT_FOUND' || error.code === 'CONFIGURATION_INVALID') return {};
    throw error;
  }
}

function legacyEnvironmentDocument(raw) {
  const normalized = normalizeUpdatePatch(isObject(raw) ? raw : {});
  const connectionSource = isObject(normalized.connection)
    ? normalized.connection
    : (isObject(normalized.mysql) ? normalized.mysql : normalized);
  const connection = {};
  for (const field of ['host', 'address', 'port', 'database', 'db', 'user', 'username', 'password', 'socketPath', 'socket', 'charset', 'timezone', 'ssl', 'tls']) {
    if (own(connectionSource, field)) connection[field] = connectionSource[field];
  }
  const permissions = isObject(normalized.permissions)
    ? { ...normalized.permissions }
    : {};
  const runtime = isObject(normalized.runtime)
    ? { ...normalized.runtime }
    : {};
  return {
    connection,
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(Object.keys(runtime).length ? { runtime } : {}),
  };
}

function toEnvironmentDocument(raw) {
  if (hasEnvironmentDocument(raw)) {
    const names = environmentNames(raw);
    const environments = {};
    for (const name of names) {
      if (!isObject(raw.environments[name])) {
        throw new ConfigError(`Environment '${name}' must be a JSON object.`, ['environment']);
      }
      environments[name] = deepMerge({}, raw.environments[name]);
    }
    const document = {
      ...deepMerge({}, raw),
      schemaVersion: raw.schemaVersion === undefined ? CONFIG_SCHEMA_VERSION : raw.schemaVersion,
      adapter: raw.adapter || 'mysql',
      environments,
    };
    // A multi-environment document must not accidentally retain legacy
    // connection fields that look like shared credentials.
    delete document.connection;
    delete document.mysql;
    // `environment` is a request-scoping field, never persisted state.
    delete document.environment;
    delete document.activeEnvironment;
    if (raw.defaultEnvironment !== undefined && raw.defaultEnvironment !== null) {
      document.defaultEnvironment = environmentValue(raw.defaultEnvironment, 'defaultEnvironment');
    } else {
      delete document.defaultEnvironment;
    }
    if (isObject(raw.permissions)) document.permissions = deepMerge({}, raw.permissions);
    if (isObject(raw.runtime)) document.runtime = deepMerge({}, raw.runtime);
    return document;
  }
  const legacy = legacyEnvironmentDocument(raw);
  const hasLegacyConnection = Object.keys(legacy.connection || {}).length > 0;
  return {
    schemaVersion: raw?.schemaVersion === undefined ? CONFIG_SCHEMA_VERSION : raw.schemaVersion,
    adapter: raw?.adapter || 'mysql',
    ...(hasLegacyConnection ? { defaultEnvironment: DEFAULT_ENVIRONMENT } : {}),
    environments: { [DEFAULT_ENVIRONMENT]: legacy },
  };
}

function resolveOptionsPath(options) {
  const optionObject = options || {};
  const hasExplicitOptions = own(optionObject, 'configPath') || own(optionObject, 'env');
  const configPath = optionObject.configPath;
  const env = hasExplicitOptions
    ? (optionObject.env || process.env)
    : (options && Object.keys(optionObject).length ? optionObject : process.env);
  return path.resolve(configPath || resolveConfigPath(env));
}

function environmentSummary(raw, configPath, name) {
  try {
    const config = canonicalSettings(raw, configPath, { environment: name, requireCredentials: false });
    const missing = config.missing || [];
    return {
      name,
      configured: missing.length === 0,
      missing,
      configuration: summarizeConfig(config),
    };
  } catch (error) {
    const configError = error instanceof ConfigError
      ? error
      : new ConfigError('Environment could not be loaded.');
    return {
      name,
      configured: false,
      missing: configError.missing || [],
      error: { code: configError.code, message: configError.message },
    };
  }
}

/** Return non-sensitive information about every configured environment. */
export async function listEnvironments(options) {
  const resolved = resolveOptionsPath(options);
  const document = await readSettingsDocument(resolved);
  const names = environmentNames(document.raw);
  const legacy = !hasEnvironmentDocument(document.raw);
  const defaultEnvironment = legacy
    ? null
    : (document.raw.defaultEnvironment === undefined || document.raw.defaultEnvironment === null
      ? null
      : environmentValue(document.raw.defaultEnvironment, 'defaultEnvironment'));
  const environments = names.map((name) => environmentSummary(document.raw, resolved, name));
  const defaultEnvironmentError = !legacy && defaultEnvironment && !own(document.raw.environments, defaultEnvironment)
    ? {
      code: 'DEFAULT_ENVIRONMENT_NOT_FOUND',
      message: `defaultEnvironment '${defaultEnvironment}' is not configured.`,
    }
    : null;
  return {
    path: resolved,
    schemaVersion: integerValue(document.raw.schemaVersion, 'schemaVersion', CONFIG_SCHEMA_VERSION, 1, CONFIG_SCHEMA_VERSION),
    adapter: String(document.raw.adapter || 'mysql').trim().toLowerCase(),
    legacySingleEnvironment: legacy,
    defaultEnvironment,
    defaultEnvironmentError,
    environmentRequired: !legacy && !defaultEnvironment,
    environments,
  };
}

/** Persist a complete validated configuration with an atomic rename and private permissions. */
export async function writeConfig(configOrRaw, configPath = resolveConfigPath()) {
  const resolved = path.resolve(configPath);
  if (isObject(configOrRaw) && hasEnvironmentDocument(configOrRaw)) {
    const document = toEnvironmentDocument(configOrRaw);
    if (document.defaultEnvironment !== undefined
      && !own(document.environments, document.defaultEnvironment)) {
      throw new ConfigError(
        `defaultEnvironment '${document.defaultEnvironment}' is not configured.`,
        ['defaultEnvironment'],
        'DEFAULT_ENVIRONMENT_NOT_FOUND',
      );
    }
    for (const name of Object.keys(document.environments)) {
      canonicalSettings(document, resolved, { environment: name, requireCredentials: false });
    }
    await writeDocument(document, resolved);
    const selected = document.defaultEnvironment || Object.keys(document.environments)[0];
    return {
      path: resolved,
      config: selected
        ? canonicalSettings(document, resolved, { environment: selected, requireCredentials: false })
        : null,
    };
  }
  const config = configOrRaw?.host !== undefined && configOrRaw?.passwordSource !== undefined
    ? configOrRaw
    : canonicalSettings(configOrRaw, resolved);
  const document = canonicalForFile(config);
  await writeDocument(document, resolved);
  return { path: resolved, config: canonicalSettings(document, resolved) };
}

/** Merge a user supplied patch into the existing JSON document, preserving omitted secrets. */
export async function updateConfig(patch, configPath = resolveConfigPath(), options = {}) {
  if (!isObject(patch)) throw new ConfigError('Configuration update must be a JSON object.');
  const resolved = path.resolve(configPath);
  const targetEnvironment = options.environment !== undefined ? options.environment : patch.environment;
  const existing = await readExistingDocument(resolved);
  if (hasEnvironmentDocument(existing)
    && targetEnvironment === undefined
    && !hasEnvironmentDocument(patch)
    && !own(patch, 'defaultEnvironment')
    && !own(patch, 'setAsDefault')
    && hasEnvironmentScopedFields(patch)) {
    if (existing.defaultEnvironment !== undefined && existing.defaultEnvironment !== null) {
      return updateEnvironmentConfig(patch, existing.defaultEnvironment, resolved, options);
    }
    throw new ConfigError(
      'A multi-environment configuration has no default. Specify environment explicitly.',
      ['environment'],
      'ENVIRONMENT_REQUIRED',
    );
  }
  if (targetEnvironment !== undefined || hasEnvironmentDocument(patch) || hasEnvironmentDocument(existing)
    || own(patch, 'defaultEnvironment') || own(patch, 'setAsDefault')) {
    if (targetEnvironment === undefined && hasEnvironmentDocument(patch)) {
      // A complete multi-environment document can be supplied directly.
      const documentPatch = { ...patch };
      delete documentPatch.environment;
      delete documentPatch.setAsDefault;
      const merged = deepMerge(existing, documentPatch);
      const document = toEnvironmentDocument(merged);
      if (document.defaultEnvironment !== undefined
        && !own(document.environments, document.defaultEnvironment)) {
        throw new ConfigError(
          `defaultEnvironment '${document.defaultEnvironment}' is not configured.`,
          ['defaultEnvironment'],
          'DEFAULT_ENVIRONMENT_NOT_FOUND',
        );
      }
      // Validate every environment without requiring all of them to be complete;
      // this permits a user to stage credentials one environment at a time.
      for (const name of Object.keys(document.environments)) {
        canonicalSettings(document, resolved, { environment: name, requireCredentials: false });
      }
      await writeDocument(document, resolved);
      const selected = document.defaultEnvironment || Object.keys(document.environments)[0];
      return {
        path: resolved,
        config: selected
          ? canonicalSettings(document, resolved, { environment: selected, requireCredentials: false })
          : null,
      };
    }
    if (targetEnvironment === undefined && hasEnvironmentDocument(existing)) {
      const metadataPatch = normalizeUpdatePatch(patch);
      delete metadataPatch.environment;
      delete metadataPatch.setAsDefault;
      const merged = deepMerge(existing, metadataPatch);
      const document = toEnvironmentDocument(merged);
      if (own(patch, 'defaultEnvironment')) {
        document.defaultEnvironment = patch.defaultEnvironment === null
          ? undefined
          : environmentValue(patch.defaultEnvironment, 'defaultEnvironment');
        if (document.defaultEnvironment === undefined) delete document.defaultEnvironment;
      }
      if (own(patch, 'setAsDefault') && patch.setAsDefault === true) {
        throw new ConfigError('setAsDefault requires an explicit environment.', ['environment']);
      }
      if (document.defaultEnvironment !== undefined
        && !own(document.environments, document.defaultEnvironment)) {
        throw new ConfigError(
          `defaultEnvironment '${document.defaultEnvironment}' is not configured.`,
          ['defaultEnvironment'],
          'DEFAULT_ENVIRONMENT_NOT_FOUND',
        );
      }
      for (const name of Object.keys(document.environments)) {
        canonicalSettings(document, resolved, { environment: name, requireCredentials: false });
      }
      await writeDocument(document, resolved);
      const selected = document.defaultEnvironment || Object.keys(document.environments)[0];
      return {
        path: resolved,
        config: selected
          ? canonicalSettings(document, resolved, { environment: selected, requireCredentials: false })
          : null,
      };
    }
    if (targetEnvironment === undefined && !hasEnvironmentDocument(existing)
      && (own(patch, 'defaultEnvironment') || own(patch, 'setAsDefault'))) {
      if (patch.setAsDefault === true) {
        throw new ConfigError('setAsDefault requires an explicit environment.', ['environment']);
      }
      const document = toEnvironmentDocument(existing);
      if (patch.defaultEnvironment === null) {
        delete document.defaultEnvironment;
      } else if (patch.defaultEnvironment !== undefined) {
        const name = environmentValue(patch.defaultEnvironment, 'defaultEnvironment');
        if (!own(document.environments, name)) {
          throw new ConfigError(
            `Environment '${name}' is not configured.`,
            ['defaultEnvironment'],
            'ENVIRONMENT_NOT_FOUND',
          );
        }
        document.defaultEnvironment = name;
      }
      await writeDocument(document, resolved);
      const selected = document.defaultEnvironment || Object.keys(document.environments)[0];
      return {
        path: resolved,
        config: selected
          ? canonicalSettings(document, resolved, { environment: selected, requireCredentials: false })
          : null,
      };
    }
    return updateEnvironmentConfig(patch, targetEnvironment, resolved, options);
  }
  const merged = deepMerge(existing, normalizeUpdatePatch(patch));
  return writeConfig(merged, resolved);
}

/**
 * Update one named environment while preserving every other environment and
 * omitted passwords. `allowIncomplete` is useful for a staged setup; the MCP
 * tool uses the default strict mode so a typo cannot silently create a dead
 * connection.
 */
export async function updateEnvironmentConfig(
  patch,
  environment,
  configPath = resolveConfigPath(),
  { setAsDefault = false, allowIncomplete = false } = {},
) {
  if (!isObject(patch)) throw new ConfigError('Configuration update must be a JSON object.');
  const name = environmentValue(environment);
  const resolved = path.resolve(configPath);
  const existing = await readExistingDocument(resolved);
  const document = Object.keys(existing).length === 0
    ? { schemaVersion: CONFIG_SCHEMA_VERSION, adapter: 'mysql', environments: {} }
    : toEnvironmentDocument(existing);
  const normalizedPatch = normalizeUpdatePatch(patch);
  if (normalizedPatch.adapter !== undefined) {
    document.adapter = normalizedPatch.adapter;
    delete normalizedPatch.adapter;
  }
  if (normalizedPatch.schemaVersion !== undefined) {
    document.schemaVersion = normalizedPatch.schemaVersion;
    delete normalizedPatch.schemaVersion;
  }
  delete normalizedPatch.environment;
  delete normalizedPatch.defaultEnvironment;
  delete normalizedPatch.setAsDefault;
  delete normalizedPatch.environments;
  document.environments[name] = deepMerge(document.environments[name] || {}, normalizedPatch);
  if (setAsDefault) document.defaultEnvironment = name;
  if (document.defaultEnvironment !== undefined
    && document.defaultEnvironment !== null
    && !own(document.environments, document.defaultEnvironment)) {
    throw new ConfigError(
      `defaultEnvironment '${document.defaultEnvironment}' is not configured.`,
      ['defaultEnvironment'],
      'DEFAULT_ENVIRONMENT_NOT_FOUND',
    );
  }
  const validation = canonicalSettings(document, resolved, {
    environment: name,
    requireCredentials: !allowIncomplete,
  });
  await writeDocument(document, resolved);
  return { path: resolved, config: validation };
}

/** Set the optional default environment used when a tool omits `environment`. */
export async function setDefaultEnvironment(environment, configPath = resolveConfigPath()) {
  const name = environmentValue(environment, 'defaultEnvironment');
  const resolved = path.resolve(configPath);
  const existing = await readExistingDocument(resolved);
  const document = toEnvironmentDocument(existing);
  if (!own(document.environments, name)) {
    throw new ConfigError(
      `Environment '${name}' is not configured.`,
      ['defaultEnvironment'],
      'ENVIRONMENT_NOT_FOUND',
    );
  }
  document.defaultEnvironment = name;
  await writeDocument(document, resolved);
  return {
    path: resolved,
    config: canonicalSettings(document, resolved, { environment: name, requireCredentials: false }),
  };
}

export function summarizeConfig(config) {
  if (!config) return { configured: false };
  const summary = {
    configured: !Array.isArray(config.missing) || config.missing.length === 0,
    schemaVersion: config.schemaVersion,
    adapter: config.adapter,
    configPath: config.configPath,
    ...(config.missing?.length ? { missing: config.missing } : {}),
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    passwordConfigured: Boolean(config.passwordSource && config.passwordSource !== 'missing'),
    passwordSource: config.passwordSource,
    socketPath: config.socketPath || null,
    sslMode: config.sslMode,
    permissions: {
      allowWrite: config.allowWrite,
      allowDdl: config.allowDdl,
      allowDestructive: config.allowDestructive,
    },
    runtime: {
      connectionLimit: config.connectionLimit,
      connectTimeoutMs: config.connectTimeoutMs,
      queryTimeoutMs: config.queryTimeoutMs,
    },
  };
  if (config.environment !== undefined) summary.environment = config.environment;
  if (config.defaultEnvironment !== undefined) summary.defaultEnvironment = config.defaultEnvironment;
  if (config.availableEnvironments !== undefined) summary.availableEnvironments = config.availableEnvironments;
  return summary;
}

export async function configurationStatus(options) {
  const supplied = options !== undefined;
  const optionObject = options || {};
  const hasExplicitOptions = own(optionObject, 'configPath') || own(optionObject, 'env') || own(optionObject, 'environment');
  const configPath = optionObject.configPath;
  const env = hasExplicitOptions
    ? (optionObject.env || process.env)
    : (supplied && Object.keys(optionObject).length ? optionObject : process.env);
  const resolved = path.resolve(configPath || resolveConfigPath(env));
  try {
    const document = await readSettingsDocument(resolved);
    const catalog = await listEnvironments({ configPath: resolved });
    const requestedEnvironment = optionObject.environment
      ?? catalog.defaultEnvironment
      ?? (catalog.legacySingleEnvironment ? DEFAULT_ENVIRONMENT : undefined);
    let selectedConfig = null;
    let selectedError = null;
    if (requestedEnvironment !== undefined) {
      try {
        selectedConfig = canonicalSettings(document.raw, resolved, { environment: requestedEnvironment });
      } catch (error) {
        selectedError = error instanceof ConfigError
          ? error
          : new ConfigError('Selected environment could not be loaded.');
      }
    }
    const missing = selectedError?.missing || selectedConfig?.missing || [];
    const configuration = selectedConfig
      ? summarizeConfig(selectedConfig)
      : {
        configured: false,
        configPath: resolved,
        environment: requestedEnvironment || null,
        defaultEnvironment: catalog.defaultEnvironment,
        availableEnvironments: catalog.environments.map((item) => item.name),
        ...(missing.length ? { missing } : {}),
      };
    return {
      path: resolved,
      exists: true,
      schemaVersion: catalog.schemaVersion,
      defaultEnvironment: catalog.defaultEnvironment,
      defaultEnvironmentError: catalog.defaultEnvironmentError,
      environmentRequired: catalog.environmentRequired,
      environments: catalog.environments,
      configuration,
      missing,
      error: selectedError
        ? { code: selectedError.code, message: selectedError.message }
        : null,
      nextSteps: [
        catalog.defaultEnvironment || catalog.legacySingleEnvironment
          ? (catalog.legacySingleEnvironment
            ? '调用 database_ping 验证单一环境连接；也可以在工具参数中显式传 environment。'
            : '调用 database_ping 验证默认环境连接；也可以在工具参数中显式传 environment。')
          : '调用 database_environment_list 查看环境；未设置默认环境时，请在数据库工具参数中显式传 environment。',
        '配置变更后调用 database_config_reload。',
      ],
    };
  } catch (error) {
    const configError = error instanceof ConfigError
      ? error
      : new ConfigError('Configuration could not be loaded.');
    return {
      path: resolved,
      exists: configError.code !== 'CONFIGURATION_NOT_FOUND',
      schemaVersion: CONFIG_SCHEMA_VERSION,
      configuration: {
        configured: false,
        configPath: resolved,
        missing: configError.missing || [],
      },
      defaultEnvironment: null,
      environmentRequired: false,
      environments: [],
      missing: configError.missing || [],
      error: { code: configError.code, message: configError.message },
      nextSteps: [
        `编辑 ${resolved}，或调用 database_configure 写入连接字段。`,
        '配置完成后调用 database_config_reload，再调用 database_ping。',
      ],
    };
  }
}

export function exampleSettings() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    adapter: 'mysql',
    connection: {
      host: '127.0.0.1',
      port: 3306,
      database: 'your_database',
      user: 'your_user',
      password: 'change_me',
      charset: 'utf8mb4',
      timezone: 'Z',
      ssl: { mode: 'disabled' },
    },
    permissions: {
      allowWrite: false,
      allowDdl: false,
      allowDestructive: false,
    },
    runtime: {
      connectionLimit: DEFAULT_CONNECTION_LIMIT,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    },
  };
}
