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
    CREATE TABLE IF NOT EXISTS balance_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      subscription_id TEXT NOT NULL, kind TEXT NOT NULL, period_date TEXT,
      payload TEXT NOT NULL, UNIQUE(subscription_id, kind, period_date)
    );
    CREATE INDEX IF NOT EXISTS balance_entries_account ON balance_entries(subscription_id, sequence);
    CREATE TABLE IF NOT EXISTS api_requests (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (
      notification_key TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS worker_state (id INTEGER PRIMARY KEY CHECK(id=1), checked_at TEXT NOT NULL, error TEXT);
  `);
  // 旧库迁移：早期续费历史没有金额与记录时间，补列后保持 NULL，表示“未记录”。
  const columns = new Set(
    (conn.prepare('PRAGMA table_info(renewals)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const [name, kind] of [['amount_cents', 'INTEGER'], ['recorded_at', 'TEXT']] as const) {
    if (!columns.has(name)) conn.exec(`ALTER TABLE renewals ADD COLUMN ${name} ${kind}`);
  }
}

/** 关闭当前进程持有的数据库连接。 */
export function closeDatabase(): void {
  if (cached) {
    cached.conn.close();
    cached = null;
  }
}

export const resetStateForTests = closeDatabase;
