import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function frame(message) {
  return `${JSON.stringify(message)}\n`;
}

function createMessageReader(stream) {
  const lines = readline.createInterface({ input: stream })[Symbol.asyncIterator]();
  return async () => {
    const next = await lines.next();
    if (next.done) throw new Error('MCP server closed stdout before sending a response.');
    return JSON.parse(next.value);
  };
}

async function makeConfigPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'database-mcp-protocol-'));
  return path.join(directory, 'settings.json');
}

function spawnServer(configPath) {
  return spawn(process.execPath, [path.join(root, 'src/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_CONFIG_PATH: configPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function initializeServer(child) {
  const readMessage = createMessageReader(child.stdout);
  child.stdin.write(frame({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'protocol-test', version: '1' },
    },
  }));
  const response = await readMessage();
  child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }));
  return { response, readMessage };
}

async function stop(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('completes MCP handshake and exposes generic tools without a database', async () => {
  const configPath = await makeConfigPath();
  const child = spawnServer(configPath);
  const { response: initResponse, readMessage } = await initializeServer(child);
  try {
    assert.equal(initResponse.id, 1);
    assert.equal(initResponse.result.serverInfo.name, 'database-mcp');
    assert.match(initResponse.result.instructions, /settings\.json/);
    assert.match(initResponse.result.instructions, /database_configure/);

    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    const list = await readMessage();
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'database_config_reload',
      'database_config_status',
      'database_configure',
      'database_describe_table',
      'database_environment_list',
      'database_environment_set_default',
      'database_execute',
      'database_list_tables',
      'database_ping',
      'database_query',
    ]);

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'database_config_status', arguments: {} },
    }));
    const status = await readMessage();
    assert.equal(status.id, 3);
    const statusJson = JSON.parse(status.result.content[0].text);
    assert.equal(statusJson.file.exists, false);
    assert.equal(statusJson.file.configuration.configured, false);
    assert.equal(statusJson.policy.multipleStatements, true);
    assert.equal(statusJson.policy.functionRestrictions, false);
    assert.equal(statusJson.policy.whereClauseRequired, false);
    assert.equal(statusJson.policy.resultLimits, false);
    assert.equal(statusJson.environmentRequired, false);

    const queryTool = list.result.tools.find((tool) => tool.name === 'database_query');
    assert.equal(queryTool.inputSchema.properties.maxRows, undefined);
    assert.equal(queryTool.inputSchema.properties.maxResultBytes, undefined);

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'database_query', arguments: { sql: 'SELECT 1' } },
    }));
    const queryResponse = await readMessage();
    assert.equal(queryResponse.result.isError, true);
    assert.match(queryResponse.result.content[0].text, /CONFIGURATION/);
  } finally {
    await stop(child);
  }
});

test('configures named environments and requires an explicit environment without a default', async () => {
  const configPath = await makeConfigPath();
  const child = spawnServer(configPath);
  const { readMessage } = await initializeServer(child);
  try {
    const configure = (id, arguments_) => {
      child.stdin.write(frame({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'database_configure', arguments: arguments_ },
      }));
      return readMessage();
    };
    const devResponse = await configure(2, {
      environment: 'dev',
      host: 'dev.example',
      database: 'app_dev',
      user: 'dev_user',
      password: 'dev-password',
    });
    assert.equal(devResponse.result.isError, undefined);
    const prodResponse = await configure(3, {
      environment: 'prod',
      host: 'prod.example',
      database: 'app_prod',
      user: 'prod_user',
      password: 'prod-password',
    });
    assert.equal(prodResponse.result.isError, undefined);
    const document = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(document.environments.dev.connection.host, 'dev.example');
    assert.equal(document.environments.prod.connection.host, 'prod.example');
    assert.equal(document.defaultEnvironment, undefined);
    assert.equal(JSON.stringify(document).includes('dev-password'), true);

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'database_ping', arguments: {} },
    }));
    const missingEnvironment = await readMessage();
    assert.equal(missingEnvironment.result.isError, true);
    assert.match(missingEnvironment.result.content[0].text, /ENVIRONMENT_REQUIRED/);

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'database_environment_set_default', arguments: { environment: 'dev' } },
    }));
    const selected = await readMessage();
    assert.equal(selected.result.isError, undefined);
    const selectedPayload = JSON.parse(selected.result.content[0].text);
    assert.equal(selectedPayload.defaultEnvironment, 'dev');
    assert.equal(JSON.stringify(selectedPayload).includes('dev-password'), false);
  } finally {
    await stop(child);
  }
});

test('configures and reloads a user settings file without returning the password', async () => {
  const configPath = await makeConfigPath();
  const child = spawnServer(configPath);
  const { readMessage } = await initializeServer(child);
  try {
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'database_configure',
        arguments: {
          host: 'db.example',
          port: 3307,
          database: 'sales',
          user: 'assistant',
          password: 'protocol-test-password',
        },
      },
    }));
    const configured = await readMessage();
    assert.equal(configured.result.isError, undefined);
    const configuredJson = JSON.parse(configured.result.content[0].text);
    assert.equal(configuredJson.saved, true);
    assert.equal(configuredJson.configuration.host, 'db.example');
    assert.equal(JSON.stringify(configuredJson).includes('protocol-test-password'), false);

    const document = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(document.connection.password, 'protocol-test-password');

    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'database_config_status', arguments: {} },
    }));
    const status = await readMessage();
    const statusJson = JSON.parse(status.result.content[0].text);
    assert.equal(statusJson.file.configuration.passwordConfigured, true);
    assert.equal(JSON.stringify(statusJson).includes('protocol-test-password'), false);
  } finally {
    await stop(child);
  }
});

test('accepts the documented nested settings object', async () => {
  const configPath = await makeConfigPath();
  const child = spawnServer(configPath);
  const { readMessage } = await initializeServer(child);
  try {
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'database_configure',
        arguments: {
          settings: {
            schemaVersion: 1,
            adapter: 'mysql',
            connection: {
              host: 'nested.example',
              database: 'nested_db',
              user: 'nested_user',
              password: 'nested-password',
            },
          },
        },
      },
    }));
    const response = await readMessage();
    assert.equal(response.result.isError, undefined);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.configuration.host, 'nested.example');
    assert.equal(JSON.stringify(payload).includes('nested-password'), false);
  } finally {
    await stop(child);
  }
});

test('accepts connection, permissions, and runtime objects directly', async () => {
  const configPath = await makeConfigPath();
  const child = spawnServer(configPath);
  const { readMessage } = await initializeServer(child);
  try {
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'database_configure',
        arguments: {
          connection: { host: 'direct.example', database: 'direct_db', user: 'direct_user', password: 'direct-password' },
          permissions: { allowWrite: true },
          runtime: { connectionLimit: 2 },
        },
      },
    }));
    const response = await readMessage();
    assert.equal(response.result.isError, undefined);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.configuration.host, 'direct.example');
    assert.equal(payload.configuration.permissions.allowWrite, true);
    assert.equal(payload.configuration.runtime.connectionLimit, 2);
    assert.equal(JSON.stringify(payload).includes('direct-password'), false);
  } finally {
    await stop(child);
  }
});
