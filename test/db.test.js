import test from 'node:test';
import assert from 'node:assert/strict';
import { MySqlDatabase } from '../src/db.js';

function config(overrides = {}) {
  return {
    environment: 'dev',
    host: 'db.example',
    port: 3306,
    database: 'sales',
    user: 'assistant',
    password: 'secret',
    socketPath: undefined,
    charset: 'utf8mb4',
    timezone: 'Z',
    ssl: undefined,
    connectionLimit: 2,
    queryTimeoutMs: 1000,
    connectTimeoutMs: 1000,
    allowWrite: true,
    allowDdl: false,
    allowDestructive: false,
    ...overrides,
  };
}

test('enables multi-statements and returns every row from every read result set', async () => {
  const calls = [];
  const pool = {
    query: async (options) => {
      calls.push(options);
      if (options.sql.includes(';')) {
        return [
          [[{ id: 1 }, { id: 2 }, { id: 3 }], [{ table_name: 'users' }]],
          [
            [{ name: 'id', columnType: 3, columnLength: 11, decimals: 0 }],
            [{ name: 'table_name', columnType: 253, columnLength: 255, decimals: 0 }],
          ],
        ];
      }
      return [
        [{ id: 4 }],
        [{ name: 'id', columnType: 3, columnLength: 11, decimals: 0 }],
      ];
    },
    end: async () => {},
  };
  const db = new MySqlDatabase(config(), { createPool: (options) => {
    assert.equal(options.multipleStatements, true);
    assert.equal(options.password, 'secret');
    return pool;
  } });

  const output = await db.query('SELECT id FROM users; SHOW TABLES', []);
  assert.equal(output.environment, 'dev');
  assert.equal(output.statementCount, 2);
  assert.equal(output.results[0].rowCount, 3);
  assert.equal(output.results[0].rows.length, 3);
  assert.equal(output.results[1].rowCount, 1);
  assert.equal(output.results[1].rows[0].table_name, 'users');
  assert.equal(output.results[0].returnedRows, undefined);
  assert.equal(output.results[0].truncated, undefined);
  assert.equal(output.results[0].columns[0].typeCode, 3);
  assert.equal(typeof output.results[0].columns[0].type, 'string');
  assert.deepEqual(calls[0].values, []);
  assert.equal(calls[0].timeout, 1000);

  const single = await db.query('SELECT id FROM users', []);
  assert.equal(single.statementCount, 1);
  assert.deepEqual(single.rows, [{ id: 4 }]);
  await assert.rejects(() => db.query('SELECT id FROM users', 'not-an-array'), /params must be an array/);
  await assert.rejects(() => db.query('SELECT id FROM users', [{ unsafe: true }]), /only strings, numbers/);
  await db.close();
});

test('returns per-statement write metadata for multi-statement execution', async () => {
  const pool = {
    query: async () => [[
      { affectedRows: 2, changedRows: 2, insertId: 11, warningStatus: 0, info: 'inserted' },
      { affectedRows: 3, changedRows: 1, insertId: 0, warningStatus: 1, info: 'updated' },
    ]],
    end: async () => {},
  };
  const db = new MySqlDatabase(config(), { createPool: () => pool });
  const output = await db.execute(
    'INSERT INTO orders (total) VALUES (?); UPDATE orders SET total = total + 1',
    [10],
    true,
  );
  assert.equal(output.statementCount, 2);
  assert.equal(output.results[0].affectedRows, 2);
  assert.equal(output.results[0].insertId, 11);
  assert.equal(output.results[1].affectedRows, 3);
  assert.equal(output.results[1].warningCount, 1);
  await db.close();
});

test('describes tables with parameterized metadata queries', async () => {
  const calls = [];
  const pool = {
    query: async (options) => {
      calls.push(options);
      return [[], []];
    },
    end: async () => {},
  };
  const db = new MySqlDatabase(config(), { createPool: () => pool });
  const output = await db.describeTable('orders_2026');
  assert.equal(output.table, 'orders_2026');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['orders_2026']);
  assert.deepEqual(calls[1].values, ['orders_2026']);
  assert.equal(output.columnsTruncated, undefined);
  assert.equal(output.indexesTruncated, undefined);
  await db.describeTable('订单明细');
  assert.deepEqual(calls[2].values, ['订单明细']);
  await db.close();
});
