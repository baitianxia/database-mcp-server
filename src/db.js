import mysql from 'mysql2/promise';
import { assertSingleStatement, validateReadSql, validateExecuteSql } from './sql.js';

const MYSQL_TYPE_NAMES = new Map(
  Object.entries(mysql.Types || {}).map(([name, code]) => [Number(code), name]),
);

export class DatabaseError extends Error {
  constructor(message, code = 'DATABASE_ERROR') {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

export { assertSingleStatement };

function jsonSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64') };
  if (value instanceof Uint8Array) return { type: 'Buffer', base64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = jsonSafe(item, seen);
    seen.delete(value);
    return output;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function fieldSummary(field) {
  return {
    name: field.name,
    table: field.orgTable || field.table || undefined,
    database: field.db || field.database || undefined,
    typeCode: field.columnType,
    type: MYSQL_TYPE_NAMES.get(Number(field.columnType)) || undefined,
    length: field.columnLength,
    decimals: field.decimals,
  };
}

function normalizedParams(params) {
  if (!Array.isArray(params)) {
    throw new DatabaseError('SQL params must be an array.', 'INVALID_PARAMETERS');
  }
  for (const value of params) {
    const validScalar = value === null
      || typeof value === 'string'
      || (typeof value === 'number' && Number.isFinite(value))
      || typeof value === 'boolean';
    const validArray = Array.isArray(value) && value.every((item) => item === null
      || typeof item === 'string'
      || (typeof item === 'number' && Number.isFinite(item))
      || typeof item === 'boolean');
    if (!validScalar && !validArray) {
      throw new DatabaseError(
        'SQL params must contain only strings, numbers, booleans, nulls, or arrays of those values.',
        'INVALID_PARAMETERS',
      );
    }
  }
  return params;
}

function identifier(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new DatabaseError('Table name must be 1–64 printable characters.', 'INVALID_IDENTIFIER');
  }
  return value;
}

function queryOptions(sql, values, timeout) {
  return { sql, values, timeout };
}

function queryResult(statement, rows, fields) {
  const rowArray = Array.isArray(rows) ? rows : [];
  return {
    statementType: statement.kind,
    sql: statement.sql,
    rowCount: rowArray.length,
    columns: Array.isArray(fields) ? fields.map(fieldSummary) : [],
    rows: rowArray.map((row) => jsonSafe(row)),
  };
}

function environmentField(config) {
  return config?.environment ? { environment: config.environment } : {};
}

function executeResult(statement, result) {
  return {
    statementType: statement.kind,
    sql: statement.sql,
    affectedRows: Number(result?.affectedRows || 0),
    changedRows: Number(result?.changedRows || 0),
    insertId: jsonSafe(result?.insertId ?? null),
    warningCount: Number(result?.warningStatus || result?.warningCount || 0),
    info: result?.info || undefined,
  };
}

export class MySqlDatabase {
  constructor(config, { createPool = mysql.createPool } = {}) {
    this.config = config;
    this.createPool = createPool;
    this.pool = null;
  }

  getPool() {
    if (!this.pool) {
      this.pool = this.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        socketPath: this.config.socketPath,
        charset: this.config.charset,
        timezone: this.config.timezone,
        ssl: this.config.ssl,
        waitForConnections: true,
        connectionLimit: this.config.connectionLimit,
        queueLimit: 0,
        connectTimeout: this.config.connectTimeoutMs,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        multipleStatements: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
    }
    return this.pool;
  }

  async query(sql, params = []) {
    const inspected = validateReadSql(sql);
    const values = normalizedParams(params);
    const [rows, fields] = await this.getPool().query(
      queryOptions(inspected.sql, values, this.config.queryTimeoutMs),
    );
    const results = inspected.statements.map((statement, index) => queryResult(
      statement,
      inspected.statements.length > 1 ? rows?.[index] : rows,
      inspected.statements.length > 1 ? fields?.[index] : fields,
    ));
    if (results.length === 1) return { ...environmentField(this.config), statementCount: 1, ...results[0] };
    return { ...environmentField(this.config), statementCount: results.length, results };
  }

  async execute(sql, params = [], confirm = false) {
    const inspected = validateExecuteSql(sql, this.config, confirm);
    const values = normalizedParams(params);
    const [result] = await this.getPool().query(
      queryOptions(inspected.sql, values, this.config.queryTimeoutMs),
    );
    const results = inspected.statements.map((statement, index) => executeResult(
      statement,
      inspected.statements.length > 1 ? result?.[index] : result,
    ));
    if (results.length === 1) return { ...environmentField(this.config), statementCount: 1, ...results[0] };
    return { ...environmentField(this.config), statementCount: results.length, results };
  }

  async ping() {
    const [rows] = await this.getPool().query(queryOptions(
      'SELECT VERSION() AS version, DATABASE() AS database_name, CURRENT_USER() AS current_user_name',
      [],
      this.config.queryTimeoutMs,
    ));
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return {
      reachable: true,
      ...environmentField(this.config),
      version: row?.version ?? null,
      database: row?.database_name ?? null,
      currentUser: row?.current_user_name ?? null,
    };
  }

  async listTables() {
    const result = await this.query(
      `SELECT TABLE_NAME AS table_name,
              TABLE_TYPE AS table_type,
              ENGINE AS engine,
              TABLE_ROWS AS estimated_rows,
              TABLE_COMMENT AS table_comment
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME`,
      [],
    );
    return { ...environmentField(this.config), database: this.config.database, ...result };
  }

  async describeTable(tableName) {
    const table = identifier(tableName);
    const columns = await this.query(
      `SELECT ORDINAL_POSITION AS ordinal_position,
              COLUMN_NAME AS column_name,
              COLUMN_TYPE AS column_type,
              IS_NULLABLE AS is_nullable,
              COLUMN_DEFAULT AS column_default,
              COLUMN_KEY AS column_key,
              EXTRA AS extra,
              COLUMN_COMMENT AS column_comment
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table],
    );
    const indexes = await this.query(
      `SELECT INDEX_NAME AS index_name,
              NON_UNIQUE AS non_unique,
              SEQ_IN_INDEX AS sequence_in_index,
              COLUMN_NAME AS column_name,
              INDEX_TYPE AS index_type
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [table],
    );
    return {
      ...environmentField(this.config),
      database: this.config.database,
      table,
      tableExists: columns.rows.length > 0 || indexes.rows.length > 0,
      columns: columns.rows,
      indexes: indexes.rows,
    };
  }

  async close() {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.end();
  }
}

// The adapter name remains an implementation detail while the MCP surface stays generic.
export const MysqlDatabase = MySqlDatabase;

export function createDatabase(config, options) {
  if (config?.adapter && config.adapter !== 'mysql') {
    throw new DatabaseError(`Unsupported database adapter: ${config.adapter}.`, 'UNSUPPORTED_ADAPTER');
  }
  return new MySqlDatabase(config, options);
}
