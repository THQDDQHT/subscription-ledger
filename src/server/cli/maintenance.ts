import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, dataRoot } from '../db';

async function run() {
  const action = process.argv[2];
  if (action === 'migrate') {
    db().close(); console.log('数据库迁移完成：余额流水、Agent 令牌与通知状态表已就绪');
  } else if (action === 'backup') {
    const folder = path.join(dataRoot(), 'backups');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const target = path.join(folder, `pre-upgrade-${Date.now()}.sqlite3`);
    const conn = new Database(path.join(dataRoot(), 'ledger.sqlite3'), { readonly: true, fileMustExist: true });
    try { await conn.backup(target); fs.chmodSync(target, 0o600); } finally { conn.close(); }
    console.log(path.basename(target));
  } else if (action === 'health') {
    const row = db().prepare('SELECT checked_at FROM worker_state WHERE id=1').get() as { checked_at: string } | undefined;
    if (!row || Date.now() - Date.parse(row.checked_at) > 180000) process.exitCode = 1;
    db().close();
  } else { console.error('用法：maintenance.cjs backup|migrate|health'); process.exitCode = 1; }
}
run().catch(() => { console.error('维护操作失败，请检查数据目录、权限及数据库状态'); process.exitCode = 1; });
