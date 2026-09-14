/** SQLite 数据层：better-sqlite3，schema 与幂等迁移同 Python 版一致。 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function dataRoot(): string {
  const root = process.env.LEDGER_DATA_DIR || path.join(process.cwd(), 'data');
  if (!fs.existsSync(/* turbopackIgnore: true */ root)) fs.mkdirSync(/* turbopackIgnore: true */ root, { recursive: true, mode: 0o700 });
  return root;
}

let cached: { dir: string; conn: Database.Database } | null = null;

export function db(): Database.Database {
  const root = dataRoot();
  if (cached && cached.dir === root) return cached.conn;
  if (cached) cached.conn.close();
  const file = path.join(root, 'ledger.sqlite3');
  const conn = new Database(file);
  conn.pragma('busy_timeout = 15000');
  migrate(conn);
  try {
    fs.chmodSync(/* turbopackIgnore: true */ file, 0o600);
  } catch {
    // Windows 等平台无 POSIX 权限语义，忽略。
  }
  cached = { dir: root, conn };
  return conn;
}

function migrate(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS renewals (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, actual_date TEXT NOT NULL, previous_date TEXT NOT NULL, next_date TEXT NOT NULL, amount_cents INTEGER, recorded_at TEXT);
    CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, start REAL NOT NULL);
  `);
  // 旧库迁移：早期续费历史没有金额与记录时间，补列后保持 NULL，表示“未记录”。
  const columns = new Set(
    (conn.prepare('PRAGMA table_info(renewals)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const [name, kind] of [['amount_cents', 'INTEGER'], ['recorded_at', 'TEXT']] as const) {
    if (!columns.has(name)) conn.exec(`ALTER TABLE renewals ADD COLUMN ${name} ${kind}`);
  }
}

/** 测试用：关闭并丢弃缓存连接与缓存的密钥，配合新的 LEDGER_DATA_DIR 使用。 */
export function resetStateForTests(): void {
  if (cached) {
    cached.conn.close();
    cached = null;
  }
}
