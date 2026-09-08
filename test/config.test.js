import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  configurationStatus,
  exampleSettings,
  loadConfig,
  listEnvironments,
  parseConfig,
  resolveConfigPath,
  summarizeConfig,
  setDefaultEnvironment,
  updateConfig,
  updateEnvironmentConfig,
  writeConfig,
} from '../src/config.js';

async function tempConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'database-mcp-config-'));
  return { directory, file: path.join(directory, 'config', 'settings.json') };
}

test('resolves the user config path and supports DATABASE_CONFIG_PATH', () => {
  assert.equal(
    resolveConfigPath({ USERPROFILE: 'C:\\Users\\demo' }),
    path.join('C:\\Users\\demo', 'database-mcp-server', 'config', 'settings.json'),
  );
  assert.equal(resolveConfigPath({ DATABASE_CONFIG_PATH: '/tmp/custom-settings.json' }), '/tmp/custom-settings.json');
});

test('accepts an environment-like object only for selecting the JSON path', async () => {
  const { file } = await tempConfig();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(exampleSettings()));
  const config = await loadConfig({ DATABASE_CONFIG_PATH: file });
  assert.equal(config.configPath, path.resolve(file));
});

test('requires database, user, and password in the JSON document', () => {
  assert.throws(
    () => parseConfig({ schemaVersion: 1, adapter: 'mysql', connection: {} }, '/tmp/settings.json'),
    (error) => error instanceof ConfigError
      && error.missing.includes('connection.database')
      && error.missing.includes('connection.user')
      && error.missing.includes('connection.password'),
  );
});

test('loads connection and safety settings without exposing the password in the summary', () => {
  const raw = exampleSettings();
  raw.connection.host = 'db.example';
  raw.connection.port = '3307';
  raw.connection.database = 'sales';
  raw.connection.user = 'assistant';
  raw.connection.password = 'super-secret';
  raw.permissions.allowWrite = true;
  raw.permissions.allowDdl = true;
  const config = parseConfig(raw, '/tmp/settings.json');
  assert.equal(config.host, 'db.example');
  assert.equal(config.port, 3307);
  assert.equal(config.allowWrite, true);
  assert.equal(config.allowDdl, true);
  const summary = summarizeConfig(config);
  assert.equal(summary.passwordConfigured, true);
  assert.equal(summary.password, undefined);
  assert.equal(JSON.stringify(summary).includes('super-secret'), false);
  assert.equal(summary.permissions.allowDestructive, false);
  assert.equal(summary.runtime.connectionLimit, 4);
});

test('writes a canonical JSON config and preserves an omitted password during updates', async () => {
  const { file } = await tempConfig();
  const raw = exampleSettings();
  await updateConfig(raw, file);
  await updateConfig({ connection: { host: 'db.internal' } }, file);
  const config = await loadConfig({ configPath: file });
  assert.equal(config.host, 'db.internal');
  assert.equal(config.password, 'change_me');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(document.connection.password, 'change_me');
  const mode = (await fs.stat(file)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('normalizes flat connection and permission aliases during direct updates', async () => {
  const { file } = await tempConfig();
  await updateConfig(exampleSettings(), file);
  await updateConfig({ host: 'flat.internal', allowWrite: true, connectionLimit: 6 }, file);
  const config = await loadConfig({ configPath: file });
  assert.equal(config.host, 'flat.internal');
  assert.equal(config.allowWrite, true);
  assert.equal(config.connectionLimit, 6);
});

test('accepts address, db, and username aliases in a flat configuration', async () => {
  const config = await loadConfig({
    address: 'alias.internal',
    port: '3308',
    db: 'alias_db',
    username: 'alias_user',
    password: 'alias-password',
  });
  assert.equal(config.host, 'alias.internal');
  assert.equal(config.database, 'alias_db');
  assert.equal(config.user, 'alias_user');
  assert.equal(config.port, 3308);
});

test('reports a missing file without throwing and identifies the next configuration fields', async () => {
  const { file } = await tempConfig();
  const status = await configurationStatus({ configPath: file });
  assert.equal(status.exists, false);
  assert.equal(status.configuration.configured, false);
  assert.deepEqual(status.missing, ['configuration file']);
  assert.equal(JSON.stringify(status).includes('password'), false);
});

test('allows database_configure callers to repair malformed JSON', async () => {
  const { file } = await tempConfig();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{not-json');
  const raw = exampleSettings();
  raw.connection.database = 'repaired';
  await updateConfig(raw, file);
  assert.equal((await loadConfig({ configPath: file })).database, 'repaired');
});

test('accepts a UTF-8 BOM written by a Windows editor', async () => {
  const { file } = await tempConfig();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `\uFEFF${JSON.stringify(exampleSettings())}`, 'utf8');
  assert.equal((await loadConfig({ configPath: file })).adapter, 'mysql');
});

test('accepts the documented TLS file settings', async () => {
  const { directory } = await tempConfig();
  const caFile = path.join(directory, 'ca.pem');
  await fs.writeFile(caFile, 'CA DATA');
  const raw = exampleSettings();
  raw.connection.ssl = { mode: 'verify_ca', caFile: '../ca.pem' };
  const config = parseConfig(raw, path.join(directory, 'config', 'settings.json'));
  assert.equal(config.sslMode, 'verify_ca');
  assert.equal(config.ssl.ca, 'CA DATA');
});

test('selects independent multi-environment connections without exposing passwords', async () => {
  const { file } = await tempConfig();
  const document = {
    schemaVersion: 1,
    adapter: 'mysql',
    environments: {
      dev: {
        connection: { host: 'dev-db', database: 'app_dev', user: 'dev_user', password: 'dev-secret' },
      },
      prod: {
        connection: { host: 'prod-db', database: 'app_prod', user: 'prod_user', password: 'prod-secret' },
      },
    },
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(document));
  await assert.rejects(
    () => loadConfig({ configPath: file }),
    (error) => error.code === 'ENVIRONMENT_REQUIRED',
  );
  const prod = await loadConfig({ configPath: file, environment: 'prod' });
  assert.equal(prod.host, 'prod-db');
  assert.equal(prod.database, 'app_prod');
  assert.equal(prod.environment, 'prod');
  assert.deepEqual(prod.availableEnvironments, ['dev', 'prod']);
  const catalog = await listEnvironments({ configPath: file });
  assert.equal(catalog.defaultEnvironment, null);
  assert.equal(catalog.environments[0].configured, true);
  assert.equal(JSON.stringify(catalog).includes('prod-secret'), false);
});

test('updates one environment and preserves the other environment password', async () => {
  const { file } = await tempConfig();
  await updateEnvironmentConfig({
    connection: { host: 'dev-db', database: 'app_dev', user: 'dev_user', password: 'dev-secret' },
  }, 'dev', file);
  await updateEnvironmentConfig({
    connection: { host: 'prod-db', database: 'app_prod', user: 'prod_user', password: 'prod-secret' },
  }, 'prod', file);
  await setDefaultEnvironment('dev', file);
  await updateEnvironmentConfig({ connection: { host: 'dev-db-2' } }, 'dev', file);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(document.defaultEnvironment, 'dev');
  assert.equal(document.environments.dev.connection.host, 'dev-db-2');
  assert.equal(document.environments.dev.connection.password, 'dev-secret');
  assert.equal(document.environments.prod.connection.password, 'prod-secret');
  const selected = await loadConfig({ configPath: file });
  assert.equal(selected.environment, 'dev');
  assert.equal(selected.host, 'dev-db-2');
});

test('reports a valid multi-environment file without inventing a default', async () => {
  const { file } = await tempConfig();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    adapter: 'mysql',
    environments: {
      test: { connection: { database: 'test_db', user: 'tester', password: 'test-secret' } },
    },
  }));
  const status = await configurationStatus({ configPath: file });
  assert.equal(status.error, null);
  assert.equal(status.defaultEnvironment, null);
  assert.equal(status.configuration.configured, false);
  assert.deepEqual(status.environments.map((item) => item.name), ['test']);
  assert.equal(JSON.stringify(status).includes('test-secret'), false);
});

test('applies shared permission defaults and permits removing the configured default', async () => {
  const { file } = await tempConfig();
  await updateConfig({
    schemaVersion: 1,
    adapter: 'mysql',
    defaultEnvironment: 'dev',
    permissions: { allowWrite: true, allowDdl: false },
    runtime: { connectionLimit: 7 },
    environments: {
      dev: {
        connection: { database: 'app_dev', user: 'dev_user', password: 'dev-secret' },
        permissions: { allowWrite: false },
      },
    },
  }, file);
  const dev = await loadConfig({ configPath: file });
  assert.equal(dev.allowWrite, false);
  assert.equal(dev.allowDdl, false);
  assert.equal(dev.connectionLimit, 7);
  await updateConfig({ defaultEnvironment: null }, file);
  const catalog = await listEnvironments({ configPath: file });
  assert.equal(catalog.defaultEnvironment, null);
  await assert.rejects(() => loadConfig({ configPath: file }), (error) => error.code === 'ENVIRONMENT_REQUIRED');
});

test('writes a multi-environment document without requiring a default', async () => {
  const { file } = await tempConfig();
  const written = await writeConfig({
    schemaVersion: 1,
    adapter: 'mysql',
    environments: {
      qa: { connection: { database: 'qa_db', user: 'qa_user', password: 'qa-secret' } },
      prod: { connection: { database: 'prod_db', user: 'prod_user', password: 'prod-secret' } },
    },
  }, file);
  assert.equal(written.config.environment, 'qa');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).defaultEnvironment, undefined);
});

test('accepts a Unicode environment name and rejects unsafe names', () => {
  const raw = {
    schemaVersion: 1,
    adapter: 'mysql',
    environments: {
      开发: { connection: { database: 'dev_db', user: 'dev', password: 'secret' } },
    },
  };
  assert.equal(parseConfig(raw, '/tmp/settings.json', { environment: '开发' }).environment, '开发');
  assert.throws(
    () => parseConfig({ ...raw, environments: { '../prod': raw.environments.开发 } }, '/tmp/settings.json', { environment: '../prod' }),
    (error) => error.code === 'INVALID_ENVIRONMENT',
  );
});

test('preserves legacy mysql aliases when adding an environment', async () => {
  const { file } = await tempConfig();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    adapter: 'mysql',
    mysql: { host: 'legacy-db', database: 'legacy_db', user: 'legacy_user', password: 'legacy-secret' },
  }));
  await updateEnvironmentConfig({
    connection: { host: 'new-db', database: 'new_db', user: 'new_user', password: 'new-secret' },
  }, 'staging', file);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(document.environments.default.connection.host, 'legacy-db');
  assert.equal(document.environments.default.connection.password, 'legacy-secret');
  assert.equal(document.environments.staging.connection.database, 'new_db');
});

test('keeps adapter and schema metadata at the document level for environment updates', async () => {
  const { file } = await tempConfig();
  await updateEnvironmentConfig({
    schemaVersion: 1,
    adapter: 'mysql',
    connection: { database: 'app_db', user: 'app_user', password: 'app-secret' },
  }, 'dev', file);
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(document.adapter, 'mysql');
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.environments.dev.adapter, undefined);
  assert.equal(document.environments.dev.schemaVersion, undefined);
});
