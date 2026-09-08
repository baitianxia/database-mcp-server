const MAX_SQL_LENGTH = 100_000;

export class SqlValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlValidationError';
    this.code = 'INVALID_SQL';
  }
}

function isDashCommentStart(sql, index) {
  if (sql[index] !== '-' || sql[index + 1] !== '-') return false;
  const next = sql[index + 2];
  return next === undefined || /[\s\u0000]/.test(next);
}

// Replace quoted strings, identifiers, and comments with spaces while keeping
// unquoted words and punctuation at their original positions. This lets the
// policy checks and statement splitter ignore SQL-looking text supplied as data.
export function maskSql(sql, { backslashEscapes = true } = {}) {
  const chars = sql.split('');
  let state = 'normal';
  for (let i = 0; i < chars.length; i += 1) {
    const current = sql[i];
    const next = sql[i + 1];
    if (state === 'line-comment') {
      chars[i] = ' ';
      if (current === '\n' || current === '\r') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      chars[i] = ' ';
      if (current === '*' && next === '/') {
        chars[i + 1] = ' ';
        i += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'backtick') {
      chars[i] = ' ';
      const terminator = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
      if (backslashEscapes && current === '\\' && next !== undefined) {
        chars[i + 1] = ' ';
        i += 1;
      } else if (current === terminator) {
        if (next === terminator) {
          chars[i + 1] = ' ';
          i += 1;
        } else {
          state = 'normal';
        }
      }
      continue;
    }
    if (isDashCommentStart(sql, i)) {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 1;
      state = 'line-comment';
      continue;
    }
    if (current === '#') {
      chars[i] = ' ';
      state = 'line-comment';
      continue;
    }
    if (current === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 1;
      state = 'block-comment';
      continue;
    }
    if (current === "'") {
      chars[i] = ' ';
      state = 'single-quote';
      continue;
    }
    if (current === '"') {
      chars[i] = ' ';
      state = 'double-quote';
      continue;
    }
    if (current === '`') {
      chars[i] = ' ';
      state = 'backtick';
    }
  }
  return chars.join('');
}

function hasExecutableComment(sql) {
  let state = 'normal';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'backtick') {
      const terminator = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`';
      if (current === '\\' && next !== undefined) {
        index += 1;
      } else if (current === terminator) {
        if (next === terminator) index += 1;
        else state = 'normal';
      }
      continue;
    }
    if (isDashCommentStart(sql, index)) {
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (current === '#') {
      state = 'line-comment';
      continue;
    }
    if (current === '/' && next === '*') {
      const marker = sql[index + 2];
      const mariaMarker = marker?.toUpperCase() === 'M' && sql[index + 3] === '!';
      if (marker === '!' || mariaMarker) return true;
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (current === "'") state = 'single-quote';
    else if (current === '"') state = 'double-quote';
    else if (current === '`') state = 'backtick';
  }
  return false;
}

function normalizeSql(sql) {
  if (typeof sql !== 'string') throw new SqlValidationError('SQL must be a string.');
  const normalized = sql.trim();
  if (!normalized) throw new SqlValidationError('SQL cannot be empty.');
  if (sql.length > MAX_SQL_LENGTH) {
    throw new SqlValidationError(`SQL exceeds the ${MAX_SQL_LENGTH}-character limit.`);
  }
  return normalized;
}

// Kept for callers of the original module API. It now only normalizes input;
// multi-statement SQL is intentionally allowed and is exposed by splitStatements.
export function assertSingleStatement(sql) {
  const normalized = normalizeSql(sql);
  const statements = splitStatements(normalized);
  return statements.length === 1 ? statements[0].sql : normalized;
}

function inspectStatement(statement) {
  const masked = maskSql(statement).toUpperCase();
  const match = masked.match(/^\s*([A-Z_][A-Z0-9_$]*)/);
  const firstKeyword = match ? match[1] : '';
  let kind = firstKeyword;
  if (firstKeyword === 'WITH') {
    kind = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(masked) ? 'WITH_WRITE' : 'WITH_READ';
  }
  return { sql: statement, masked, firstKeyword, kind };
}

function isIgnorableStatement(statement) {
  for (let index = 0; index < statement.length;) {
    const current = statement[index];
    const next = statement[index + 1];
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (isDashCommentStart(statement, index)) {
      index += 2;
      while (index < statement.length && statement[index] !== '\n' && statement[index] !== '\r') index += 1;
      continue;
    }
    if (current === '#') {
      index += 1;
      while (index < statement.length && statement[index] !== '\n' && statement[index] !== '\r') index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      const end = statement.indexOf('*/', index + 2);
      if (end < 0 || /^\/\*(?:!|M!)/i.test(statement.slice(index))) return false;
      index = end + 2;
      continue;
    }
    return false;
  }
  return true;
}

export function splitStatements(sql) {
  const normalized = normalizeSql(sql);
  const masked = maskSql(normalized);
  // MySQL can run with NO_BACKSLASH_ESCAPES. If a semicolon is outside a
  // quoted value under one mode but inside it under the other, refusing the
  // ambiguous input keeps the read/write classification aligned with the
  // server's actual parser instead of allowing a hidden second statement.
  const noBackslashMasked = maskSql(normalized, { backslashEscapes: false });
  const statements = [];
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const delimiterWithEscapes = masked[index] === ';';
    const delimiterWithoutEscapes = noBackslashMasked[index] === ';';
    if (delimiterWithEscapes !== delimiterWithoutEscapes) {
      throw new SqlValidationError(
        'SQL contains a semicolon whose quoted-string interpretation depends on NO_BACKSLASH_ESCAPES.',
      );
    }
    if (!delimiterWithEscapes) continue;
    const statement = normalized.slice(start, index).trim();
    if (statement && !isIgnorableStatement(statement)) statements.push(inspectStatement(statement));
    start = index + 1;
  }
  const finalStatement = normalized.slice(start).trim();
  if (finalStatement && !isIgnorableStatement(finalStatement)) statements.push(inspectStatement(finalStatement));
  if (!statements.length) throw new SqlValidationError('SQL cannot be empty.');
  return statements;
}

export function inspectSql(sql) {
  const normalized = normalizeSql(sql);
  const statements = splitStatements(normalized);
  // Put the delimiter on its own line so a trailing `--` or `#` comment in
  // one statement cannot consume the separator after trimming whitespace.
  const canonicalSql = statements.map((statement) => statement.sql).join('\n;\n');
  if (statements.length === 1) {
    return { sql: canonicalSql, ...statements[0], statements };
  }
  return {
    sql: canonicalSql,
    masked: maskSql(canonicalSql).toUpperCase(),
    firstKeyword: statements[0].firstKeyword,
    kind: 'MULTI',
    statements,
  };
}

const READ_KINDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH_READ']);
const DML_KINDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH_WRITE']);
const DDL_KINDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);

function isDestructiveDdl(statement) {
  if (['DROP', 'TRUNCATE', 'RENAME'].includes(statement.kind)) return true;
  if (statement.kind === 'CREATE' && /\bOR\s+REPLACE\b/.test(statement.masked)) return true;
  return statement.kind === 'ALTER' && /\bDROP\b/.test(statement.masked);
}

function validateCommon(statement) {
  if (hasExecutableComment(statement.sql)) {
    throw new SqlValidationError('MySQL/MariaDB executable comments are not allowed.');
  }
}

export function validateReadSql(sql) {
  const inspected = inspectSql(sql);
  for (const statement of inspected.statements) {
    validateCommon(statement);
    if (!READ_KINDS.has(statement.kind)) {
      throw new SqlValidationError(
        `The query tool only accepts read-form SQL (SELECT, SHOW, DESCRIBE, EXPLAIN, or a read-form WITH query); received ${statement.firstKeyword || 'unknown'}.`,
      );
    }
    if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/.test(statement.masked)) {
      throw new SqlValidationError('Server-side file export is not available through this service.');
    }
    if (/\b(FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/.test(statement.masked)) {
      throw new SqlValidationError('Locking reads are not available through database_query.');
    }
  }
  return inspected;
}

export function validateExecuteSql(sql, config, confirm) {
  const inspected = inspectSql(sql);
  if (confirm !== true) {
    throw new SqlValidationError('Write operations require confirm=true in the tool arguments.');
  }
  for (const statement of inspected.statements) {
    validateCommon(statement);
    if (/\b(INTO\s+(OUTFILE|DUMPFILE)|LOAD\s+DATA)\b/.test(statement.masked)) {
      throw new SqlValidationError('Server-side file import and export are not available through this service.');
    }
    if (READ_KINDS.has(statement.kind)) {
      throw new SqlValidationError('Use database_query for read-form SQL.');
    }
    if (!DML_KINDS.has(statement.kind) && !DDL_KINDS.has(statement.kind)) {
      throw new SqlValidationError(
        `Statement type ${statement.firstKeyword || 'unknown'} is not enabled by this service.`,
      );
    }
    if (/^\s*(?:CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP|RENAME)\s+(USER|ROLE|DATABASE|SCHEMA|TABLESPACE|SERVER)\b/.test(statement.masked)) {
      throw new SqlValidationError('Account, server, and database-level administration is not available through this service.');
    }
    if (DML_KINDS.has(statement.kind) && !config.allowWrite) {
      throw new SqlValidationError('Writes are disabled. Set permissions.allowWrite=true in settings.json to enable them.');
    }
    if (DDL_KINDS.has(statement.kind) && !config.allowDdl) {
      throw new SqlValidationError('DDL is disabled. Set permissions.allowDdl=true in settings.json to enable it.');
    }
    if (isDestructiveDdl(statement) && !config.allowDestructive) {
      throw new SqlValidationError(
        'Destructive DDL is disabled. Set permissions.allowDestructive=true together with permissions.allowDdl=true in settings.json.',
      );
    }
  }
  return inspected;
}

export function isReadOnlyKind(kind) {
  return READ_KINDS.has(kind);
}
