'use strict';

const { spawn } = require('node:child_process');

const JS_SAFE_INTEGER_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const JS_SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SESSION_ID_BATCH = 100;
const MAX_SESSION_ID_LENGTH = 200;

function loadNodeSqlite() {
  try {
    return require('node:sqlite');
  } catch (_) {
    return null;
  }
}

function parameterCount(sql) {
  const text = String(sql || '');
  let count = 0;
  let state = 'plain';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'single') {
      if (ch === "'" && next === "'") i++;
      else if (ch === "'") state = 'plain';
      continue;
    }
    if (state === 'double') {
      if (ch === '"' && next === '"') i++;
      else if (ch === '"') state = 'plain';
      continue;
    }
    if (state === 'backtick') {
      if (ch === '`' && next === '`') i++;
      else if (ch === '`') state = 'plain';
      continue;
    }
    if (state === 'bracket') {
      if (ch === ']') state = 'plain';
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n' || ch === '\r') state = 'plain';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'plain'; i++; }
      continue;
    }
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'backtick';
    else if (ch === '[') state = 'bracket';
    else if (ch === '-' && next === '-') { state = 'line-comment'; i++; }
    else if (ch === '/' && next === '*') { state = 'block-comment'; i++; }
    else if (ch === '?') count++;
  }
  return count;
}

function assertParameterCount(sql, params) {
  if (!Array.isArray(params)) throw new TypeError('sqlite 参数必须是数组');
  const expected = parameterCount(sql);
  if (expected !== params.length) {
    throw new Error(`sqlite 参数数量不匹配: SQL 需要 ${expected} 个，实际收到 ${params.length} 个`);
  }
}

function assertNoSqliteMetaCommands(sql) {
  const text = String(sql || '');
  let state = 'plain';
  let lineOnlyWhitespace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\r' || ch === '\n') {
      if (state === 'line-comment') state = 'plain';
      lineOnlyWhitespace = true;
      continue;
    }
    if (state === 'single') {
      if (ch === "'" && next === "'") { lineOnlyWhitespace = false; i++; }
      else if (ch === "'") state = 'plain';
      if (ch !== ' ' && ch !== '\t') lineOnlyWhitespace = false;
      continue;
    }
    if (state === 'double') {
      if (ch === '"' && next === '"') { lineOnlyWhitespace = false; i++; }
      else if (ch === '"') state = 'plain';
      if (ch !== ' ' && ch !== '\t') lineOnlyWhitespace = false;
      continue;
    }
    if (state === 'backtick') {
      if (ch === '`' && next === '`') { lineOnlyWhitespace = false; i++; }
      else if (ch === '`') state = 'plain';
      if (ch !== ' ' && ch !== '\t') lineOnlyWhitespace = false;
      continue;
    }
    if (state === 'bracket') {
      if (ch === ']') state = 'plain';
      if (ch !== ' ' && ch !== '\t') lineOnlyWhitespace = false;
      continue;
    }
    if (state === 'line-comment') {
      if (ch !== ' ' && ch !== '\t') lineOnlyWhitespace = false;
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { lineOnlyWhitespace = false; state = 'plain'; i++; }
      else if (ch !== ' ' && ch !== '\t') lineOnlyWhitespace = false;
      continue;
    }
    if (lineOnlyWhitespace && ch === '.') {
      throw new Error('sqlite SQL 不允许 CLI 点命令 (dot command)');
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\ufeff') lineOnlyWhitespace = false;
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'backtick';
    else if (ch === '[') state = 'bracket';
    else if (ch === '-' && next === '-') { state = 'line-comment'; i++; }
    else if (ch === '/' && next === '*') { state = 'block-comment'; i++; }
  }
}

function leadingSqlKeyword(sql) {
  const text = String(sql || '');
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (text[index] === '-' && text[index + 1] === '-') {
      index += 2;
      while (index < text.length && text[index] !== '\r' && text[index] !== '\n') index++;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) return '';
      index = end + 2;
      continue;
    }
    break;
  }
  const match = /^[A-Za-z]+/.exec(text.slice(index));
  return match ? match[0].toUpperCase() : '';
}

function assertNoTransactionControl(sql) {
  const keyword = leadingSqlKeyword(sql);
  if (new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']).has(keyword)) {
    throw new Error(`sqlite 事务 item 不允许事务控制语句: ${keyword}`);
  }
}

function assertSingleStatement(sql) {
  if (typeof sql !== 'string') throw new TypeError('sqlite 事务 SQL 必须是字符串');
  let state = 'plain';
  let hasContent = false;
  let hasTrailingSemicolon = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'single') {
      if (ch === "'" && next === "'") i++;
      else if (ch === "'") state = 'plain';
      continue;
    }
    if (state === 'double') {
      if (ch === '"' && next === '"') i++;
      else if (ch === '"') state = 'plain';
      continue;
    }
    if (state === 'backtick') {
      if (ch === '`' && next === '`') i++;
      else if (ch === '`') state = 'plain';
      continue;
    }
    if (state === 'bracket') {
      if (ch === ']') state = 'plain';
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n' || ch === '\r') state = 'plain';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'plain'; i++; }
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (ch === '-' && next === '-') { state = 'line-comment'; i++; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; i++; continue; }
    if (ch === ';') {
      if (hasTrailingSemicolon) throw new Error('sqlite 事务的每个 item 只能包含单条 SQL 语句');
      hasTrailingSemicolon = true;
      continue;
    }
    if (hasTrailingSemicolon) throw new Error('sqlite 事务的每个 item 只能包含单条 SQL 语句');
    hasContent = true;
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'backtick';
    else if (ch === '[') state = 'bracket';
  }
  if (state === 'single' || state === 'double' || state === 'backtick' || state === 'bracket' || state === 'block-comment') {
    throw new Error('sqlite 事务 SQL 包含未闭合的引号、标识符或注释');
  }
  if (!hasContent) throw new Error('sqlite 事务的每个 item 必须包含单条 SQL 语句');
  return { hasTrailingSemicolon };
}

function normalizeParameters(sql, params) {
  assertNoSqliteMetaCommands(sql);
  assertParameterCount(sql, params);
  return params.map((value) => {
    if (value === null) return value;
    if (typeof value === 'string') {
      if (value.includes('\0')) throw new TypeError('sqlite 文本参数不能包含 NUL 字符');
      return value;
    }
    if (typeof value === 'bigint') {
      if (value < JS_SAFE_INTEGER_MIN || value > JS_SAFE_INTEGER_MAX) {
        throw new RangeError('sqlite bigint 参数必须在 JavaScript 安全整数范围内');
      }
      return value;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new RangeError('sqlite number 整数参数必须在 JavaScript 安全整数范围内');
      }
      return value;
    }
    throw new TypeError(`sqlite 不支持参数类型: ${value === undefined ? 'undefined' : typeof value}`);
  });
}

function normalizeTransactionStatements(statements) {
  if (!Array.isArray(statements) || !statements.length) throw new Error('sqlite 事务至少需要一条语句');
  return statements.map((statement) => {
    if (!statement || typeof statement.sql !== 'string') throw new TypeError('sqlite 事务语句无效');
    const statementInfo = assertSingleStatement(statement.sql);
    assertNoTransactionControl(statement.sql);
    return {
      sql: statement.sql,
      params: normalizeParameters(statement.sql, statement.params || []),
      hasTrailingSemicolon: statementInfo.hasTrailingSemicolon,
    };
  });
}

function normalizeSessionIdBatch(value, options = {}) {
  if (!Array.isArray(value)) throw new TypeError('会话 ID 批次必须是数组');
  // Most batch endpoints keep the defensive cap. Destructive deletion passes
  // maxBatch:null after validating every ID and matching it back to the DB,
  // so large user selections are processed as one logical request.
  const maxBatch = options && options.maxBatch === null ? null : MAX_SESSION_ID_BATCH;
  if (maxBatch !== null && value.length > maxBatch) {
    throw new RangeError(`单次最多接收 ${MAX_SESSION_ID_BATCH} 个会话 ID`);
  }
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item) throw new TypeError('会话 ID 必须是非空字符串');
    if (item.length > MAX_SESSION_ID_LENGTH) {
      throw new RangeError(`会话 ID 长度不能超过 ${MAX_SESSION_ID_LENGTH} 个字符`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function cliLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('sqlite 数值参数必须是有限数值');
    return String(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'string') throw new TypeError(`sqlite CLI 不支持参数类型: ${typeof value}`);
  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
}

function bindCliSql(sql, params = []) {
  const values = normalizeParameters(sql, params);
  const text = String(sql || '');
  let output = '';
  let index = 0;
  let state = 'plain';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    output += ch;
    if (state === 'single') {
      if (ch === "'" && next === "'") { output += next; i++; }
      else if (ch === "'") state = 'plain';
      continue;
    }
    if (state === 'double') {
      if (ch === '"' && next === '"') { output += next; i++; }
      else if (ch === '"') state = 'plain';
      continue;
    }
    if (state === 'backtick') {
      if (ch === '`' && next === '`') { output += next; i++; }
      else if (ch === '`') state = 'plain';
      continue;
    }
    if (state === 'bracket') {
      if (ch === ']') state = 'plain';
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n' || ch === '\r') state = 'plain';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { output += next; i++; state = 'plain'; }
      continue;
    }
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'backtick';
    else if (ch === '[') state = 'bracket';
    else if (ch === '-' && next === '-') { output += next; i++; state = 'line-comment'; }
    else if (ch === '/' && next === '*') { output += next; i++; state = 'block-comment'; }
    else if (ch === '?') {
      output = output.slice(0, -1) + cliLiteral(values[index++]);
    }
  }
  return output;
}

function runCli(command, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(new Error(`sqlite3 CLI 不可用: ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => {
      settle(new Error(`sqlite3 CLI 不可用: ${error.message}`));
    });
    child.stdin.once('error', (error) => {
      stdinError = error;
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = String(stderr || stdout).trim().slice(0, 500);
        if (/(?:unknown|unrecognized|bad) option.*json|unknown command.*json/i.test(detail)) {
          settle(new Error('sqlite3 CLI 不支持 -json，无法安全解析结构化结果'));
          return;
        }
        settle(new Error(`sqlite3 CLI 执行失败(${code}): ${detail || (stdinError && stdinError.message) || '未知错误'}`));
        return;
      }
      if (stdinError) {
        settle(new Error(`sqlite3 CLI stdin 写入失败: ${stdinError.message}`));
        return;
      }
      settle(null, stdout);
    });
    try {
      child.stdin.end(String(input || ''), 'utf8');
    } catch (error) {
      try { child.kill(); } catch (_) {}
      settle(new Error(`sqlite3 CLI stdin 写入失败: ${error.message}`));
    }
  });
}

function createSessionDb(options = {}) {
  const dbPath = String(options.dbPath || '');
  if (!dbPath) throw new Error('缺少 sqlite 数据库路径');
  const sqliteModule = options.disableNodeSqlite
    ? null
    : (Object.prototype.hasOwnProperty.call(options, 'nodeSqlite') ? options.nodeSqlite : loadNodeSqlite());
  const sqliteCommand = options.sqliteCommand || process.env.WORKDADDY_SQLITE3 || 'sqlite3';

  if (sqliteModule && typeof sqliteModule.DatabaseSync === 'function') {
    return {
      backend: 'node:sqlite',
      async all(sql, params = []) {
        const values = normalizeParameters(sql, params);
        let db;
        try {
          db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
          return db.prepare(sql).all(...values).map((row) => Object.fromEntries(Object.entries(row)));
        } catch (error) {
          throw new Error(`sqlite 查询失败: ${error.message}`);
        } finally {
          if (db) { try { db.close(); } catch (_) {} }
        }
      },
      async run(sql, params = []) {
        const values = normalizeParameters(sql, params);
        let db;
        try {
          db = new sqliteModule.DatabaseSync(dbPath);
          const result = db.prepare(sql).run(...values);
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        } catch (error) {
          throw new Error(`sqlite 写入失败: ${error.message}`);
        } finally {
          if (db) { try { db.close(); } catch (_) {} }
        }
      },
      async transaction(statements) {
        const preparedStatements = normalizeTransactionStatements(statements);
        let db;
        try {
          db = new sqliteModule.DatabaseSync(dbPath);
          db.exec('BEGIN IMMEDIATE');
          const results = preparedStatements.map((statement) => {
            const result = db.prepare(statement.sql).run(...statement.params);
            return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
          });
          db.exec('COMMIT');
          return results;
        } catch (error) {
          if (db) { try { db.exec('ROLLBACK'); } catch (_) {} }
          throw new Error(`sqlite 事务失败: ${error.message}`);
        } finally {
          if (db) { try { db.close(); } catch (_) {} }
        }
      },
    };
  }

  return {
    backend: 'sqlite3-cli',
    async all(sql, params = []) {
      const compiled = bindCliSql(sql, params);
      const stdout = await runCli(sqliteCommand, ['-readonly', '-json', dbPath], `${compiled}\n`);
      if (!stdout.trim()) return [];
      try {
        const rows = JSON.parse(stdout);
        if (!Array.isArray(rows)) throw new Error('结果不是数组');
        return rows;
      } catch (error) {
        throw new Error(`sqlite3 CLI 不支持可靠的 -json 结构化输出: ${error.message}`);
      }
    },
    async run(sql, params = []) {
      const compiled = bindCliSql(sql, params);
      await runCli(sqliteCommand, [dbPath], `${compiled}\n`);
      return { changes: null, lastInsertRowid: null };
    },
    async transaction(statements) {
      const preparedStatements = normalizeTransactionStatements(statements);
      const sql = preparedStatements.map((statement) => {
        const compiled = bindCliSql(statement.sql, statement.params);
        return statement.hasTrailingSemicolon ? compiled : compiled + '\n;';
      }).join('\n');
      await runCli(sqliteCommand, ['-bail', dbPath], `BEGIN IMMEDIATE;\n${sql}\nCOMMIT;\n`);
      return preparedStatements.map(() => ({ changes: null, lastInsertRowid: null }));
    },
  };
}

module.exports = {
  bindCliSql,
  createSessionDb,
  normalizeSessionIdBatch,
  parameterCount,
};
