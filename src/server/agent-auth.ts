import crypto from 'node:crypto';
import { db } from './db';
import { DomainError, nowIsoInShanghai } from './domain';
import { newId } from './ledger';

export interface AgentToken { id: string; name: string; scope: 'read' | 'write'; created_at: string }
export function listTokens(): AgentToken[] {
  return db().prepare('SELECT id,name,scope,created_at FROM agent_tokens ORDER BY created_at DESC').all() as AgentToken[];
}
export function createToken(data: Record<string, unknown>): AgentToken & { token: string } {
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) throw new DomainError('请填写 1–80 字的令牌名称');
  if (data.scope !== 'read' && data.scope !== 'write') throw new DomainError('令牌权限须为只读或读写');
  const token = `ledger_${crypto.randomBytes(32).toString('base64url')}`;
  const record: AgentToken = { id: newId(), name: data.name.trim(), scope: data.scope, created_at: nowIsoInShanghai() };
  db().prepare('INSERT INTO agent_tokens VALUES (?,?,?,?,?)').run(record.id, record.name, hash(token), record.scope, record.created_at);
  return { ...record, token };
}
export function authenticateAgent(req: Request): AgentToken | null {
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer ledger_[A-Za-z0-9_-]{43}$/.test(auth)) return null;
  return db().prepare('SELECT id,name,scope,created_at FROM agent_tokens WHERE token_hash=?').get(hash(auth.slice(7))) as AgentToken | undefined ?? null;
}
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
