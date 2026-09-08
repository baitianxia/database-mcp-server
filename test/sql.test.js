import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSingleStatement,
  inspectSql,
  splitStatements,
  validateExecuteSql,
  validateReadSql,
} from '../src/sql.js';

const readConfig = {
  allowWrite: false,
  allowDdl: false,
  allowDestructive: false,
};

test('accepts multiple statements and ignores semicolons in literals and comments', () => {
  const sql = " /* note */ SELECT ';' AS value; SELECT 2 /* ; */; ";
  assert.equal(assertSingleStatement(sql), sql.trim());
  assert.equal(assertSingleStatement('SELECT 1;'), 'SELECT 1');
  const statements = splitStatements(sql);
  assert.equal(statements.length, 2);
  assert.equal(statements[0].kind, 'SELECT');
  assert.equal(statements[1].kind, 'SELECT');
  assert.equal(inspectSql(sql).kind, 'MULTI');
  assert.match(inspectSql('SELECT 1 -- comment\n; SELECT 2').sql, /comment\n;\nSELECT 2/);
  assert.equal(splitStatements('SELECT 1; -- an empty segment\n; SELECT 2').length, 2);
  assert.throws(
    () => splitStatements("SELECT 'escaped\\'; DELETE FROM users"),
    /NO_BACKSLASH_ESCAPES/,
  );
});

test('classifies read statements and masks keywords in literals', () => {
  assert.equal(validateReadSql("SELECT 'DROP TABLE users' AS text").kind, 'SELECT');
  assert.equal(validateReadSql("SELECT '/*! not executable */' AS text").kind, 'SELECT');
  assert.equal(validateReadSql('WITH recent AS (SELECT 1) SELECT * FROM recent').kind, 'WITH_READ');
  assert.equal(inspectSql('WITH x AS (SELECT 1) UPDATE users SET name = ? WHERE id = ?').kind, 'WITH_WRITE');
  assert.equal(validateReadSql('SELECT LOAD_FILE(?)').statements[0].kind, 'SELECT');
  assert.equal(validateReadSql('SELECT SLEEP(?)').statements[0].kind, 'SELECT');
  assert.throws(() => validateReadSql('UPDATE users SET name = ? WHERE id = ?'), /only accepts read-form/);
  assert.throws(() => validateReadSql('/*!50000 SELECT 1 */'), /executable comments/);
  assert.throws(() => validateReadSql('/*M!100100 SELECT 1 */'), /executable comments/);
  assert.throws(() => validateReadSql('SELECT 1 /*!50000 SELECT 2 */'), /executable comments/);
  assert.throws(() => validateReadSql('SELECT 1 INTO OUTFILE \'/tmp/export.txt\''), /file export/);
});

test('validates every statement in a multi-statement read or write call', () => {
  const reads = validateReadSql('SELECT 1; SHOW TABLES');
  assert.equal(reads.statements.length, 2);
  assert.throws(() => validateReadSql('SELECT 1; UPDATE users SET enabled = 0'), /only accepts read-form/);

  const writes = validateExecuteSql(
    'UPDATE users SET name = ?; DELETE FROM users',
    { ...readConfig, allowWrite: true },
    true,
  );
  assert.equal(writes.statements.length, 2);
  assert.equal(writes.statements[0].kind, 'UPDATE');
  assert.equal(writes.statements[1].kind, 'DELETE');
  assert.throws(
    () => validateExecuteSql('INSERT INTO users (name) VALUES (?); SELECT 1', { ...readConfig, allowWrite: true }, true),
    /Use database_query/,
  );
});

test('guards writes with configuration and explicit confirmation', () => {
  assert.throws(
    () => validateExecuteSql('INSERT INTO users (name) VALUES (?)', readConfig, true),
    /Writes are disabled/,
  );
  assert.throws(
    () => validateExecuteSql('INSERT INTO users (name) VALUES (?)', { ...readConfig, allowWrite: true }, false),
    /confirm=true/,
  );
  const inspected = validateExecuteSql(
    'DELETE FROM users',
    { ...readConfig, allowWrite: true },
    true,
  );
  assert.equal(inspected.kind, 'DELETE');
  assert.equal(
    validateExecuteSql(
      'WITH doomed AS (SELECT 1) DELETE FROM users',
      { ...readConfig, allowWrite: true },
      true,
    ).kind,
    'WITH_WRITE',
  );
  assert.doesNotThrow(() => validateExecuteSql(
    'UPDATE users SET name = LOAD_FILE(?)',
    { ...readConfig, allowWrite: true },
    true,
  ));
});

test('requires separate switches for DDL and destructive statements', () => {
  assert.throws(() => validateExecuteSql('CREATE TABLE t (id INT)', readConfig, true), /DDL is disabled/);
  assert.throws(() => validateExecuteSql('DROP TABLE t', { ...readConfig, allowDdl: true }, true), /Destructive DDL/);
  assert.throws(() => validateExecuteSql('ALTER TABLE t DROP COLUMN name', { ...readConfig, allowDdl: true }, true), /Destructive DDL/);
  assert.throws(() => validateExecuteSql('CREATE OR REPLACE TABLE t (id INT)', { ...readConfig, allowDdl: true }, true), /Destructive DDL/);
  assert.equal(
    validateExecuteSql('ALTER TABLE t ADD COLUMN name VARCHAR(20)', { ...readConfig, allowDdl: true }, true).kind,
    'ALTER',
  );
  assert.throws(
    () => validateExecuteSql('CREATE USER assistant IDENTIFIED BY ?', { ...readConfig, allowDdl: true }, true),
    /administration is not available/,
  );
  assert.throws(
    () => validateExecuteSql('CREATE OR REPLACE USER assistant IDENTIFIED BY ?', { ...readConfig, allowDdl: true }, true),
    /administration is not available/,
  );
  assert.throws(
    () => validateExecuteSql('LOAD DATA INFILE \'/tmp/data.csv\' INTO TABLE users', { ...readConfig, allowWrite: true }, true),
    /file import and export/,
  );
});
