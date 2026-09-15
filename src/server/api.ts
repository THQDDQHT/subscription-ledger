/**
 * API 核心：与原 Flask app.py 逐端点等价。框架无关（只依赖 web 标准 Request/Response），
 * 由 src/app/api/[...path]/route.ts 暴露给 Next.js，由测试直接调用。
 * 单入口路由表对应原 before_request 的集中鉴权与 CSRF 语义。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, dataRoot } from './db';
import { rows, getRow, command, HttpError, entries, type Source } from './ledger';
import { authenticateAgent, createToken, listTokens } from './agent-auth';
import { reminders, notificationStatus, saveSettings, sendTelegram, telegramChats } from './notifications';
import { openapi } from './openapi';
import { validateBalanceEntries } from './balance-backup';
import {
  DomainError, validate, parseDate, parseAmount, parseCents, parseTimestamp,
  money, summary, domain, todayInShanghai, nowIsoInShanghai,
  type SubscriptionRecord,
} from './domain';
import {
  passwordHash, readSessionFrom, sessionSetCookie, sessionClearCookie,
  checkPassword, safeEqual, type SessionData,
} from './auth';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{32}$/;
let restoringDatabase = false;

function json(data: unknown, status = 200, headers: Record<string, string> = {}, cookies: string[] = []): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  for (const cookie of cookies) h.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function newId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function newCsrf(): string {
  return crypto.randomBytes(32).toString('base64url');
}

interface Ctx {
  req: Request;
  session: SessionData;
  params: Record<string, string>;
  body: unknown;
  source?: Source;
  principal?: string;
}

// ---------- 数据访问（对应 app.py 的 rows/get_row/history_view） ----------

interface SubscriptionRow extends SubscriptionRecord {
  id: string;
}

interface RenewalRow {
  id: string;
  subscription_id: string;
  actual_date: string;
  previous_date: string;
  next_date: string;
  amount_cents: number | null;
  recorded_at: string | null;
}

function withAmount(h: RenewalRow): RenewalRow & { amount: string | null } {
  return { ...h, amount: h.amount_cents === null ? null : money(h.amount_cents) };
}

function historyView(r: SubscriptionRow): Array<RenewalRow & { amount: string | null; undoable: boolean }> {
  /** 最新在前；只有最近一次、且 next_date 仍与计划一致的确认可以撤销。 */
  const rows = db()
    .prepare('SELECT * FROM renewals WHERE subscription_id = ? ORDER BY (recorded_at IS NULL), recorded_at DESC, rowid DESC')
    .all(r.id) as RenewalRow[];
  return rows.map((h, index) => ({ ...withAmount(h), undoable: index === 0 && h.next_date === r.next_date }));
}

// ---------- 端点 ----------

function sessionInfo(ctx: Ctx): Response {
  return json({ authenticated: ctx.session.authenticated, csrf: ctx.session.csrf, configured: Boolean(passwordHash()) });
}

function login(ctx: Ctx): Response {
  const supplied = (ctx.body as Record<string, unknown>).password;
  if (typeof supplied !== 'string' || supplied.length > 1024) throw new DomainError('密码格式不正确');
  const stored = passwordHash();
  if (!stored) return json({ error: '请先在服务器运行 init-password 初始化密码' }, 503);
  // 不信任 X-Forwarded-For：Node 路由层拿不到对端地址，反代与直连统一共用一个限速桶。
  const ip = 'local';
  const now = Date.now() / 1000;
  const conn = db();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const attempt = conn.prepare('SELECT * FROM attempts WHERE ip = ?').get(ip) as { count: number; start: number } | undefined;
    const count = attempt && now - attempt.start < 900 ? attempt.count : 0;
    const start = count ? (attempt as { start: number }).start : now;
    if (count >= 5) {
      conn.exec('ROLLBACK');
      return json(
        { error: '尝试过多，请在 15 分钟窗口结束后重试' },
        429,
        { 'Retry-After': String(Math.max(1, Math.floor(900 - (now - start)))) },
      );
    }
    if (!checkPassword(stored, supplied)) {
      conn.prepare('INSERT OR REPLACE INTO attempts VALUES (?,?,?)').run(ip, count + 1, start);
      conn.exec('COMMIT');
      return json({ error: '密码错误' }, 401);
    }
    conn.prepare('DELETE FROM attempts WHERE ip = ?').run(ip);
    conn.exec('COMMIT');
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
  // 登录成功：重建会话（固定会话防护），返回新 CSRF。
  const session = { authenticated: true, csrf: newCsrf() };
  return json({ ok: true, csrf: session.csrf }, 200, {}, [sessionSetCookie(session)]);
}

function logout(): Response {
  return json({ ok: true }, 200, {}, [sessionClearCookie()]);
}

function listItems(): Response {
  const result = rows();
  for (const r of result) r.suggested_next = domain.advance(r);
  result.sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0));
  return json(result);
}

function stats(): Response {
  return json(summary(rows(), todayInShanghai()));
}

function itemCommand(ctx: Ctx, action: string): Response {
  const result = command(action, ctx.params.id ?? '', ctx.body as Record<string, unknown>, {
    source: ctx.source ?? 'web', principal: ctx.principal,
    key: ctx.req.headers.get('Idempotency-Key') ?? undefined,
  });
  return json(result.data, result.status ?? 200);
}

function addItem(ctx: Ctx): Response { return itemCommand(ctx, 'create'); }
function changeItem(ctx: Ctx): Response { return itemCommand(ctx, ctx.req.method === 'DELETE' ? 'delete' : 'edit'); }

function renew(ctx: Ctx): Response {
  const ident = ctx.params.id;
  const conn = db();
  const result = command('renew', ident, ctx.body as Record<string, unknown>, { source: ctx.source ?? 'web', principal: ctx.principal, key: ctx.req.headers.get('Idempotency-Key') ?? undefined }, () => {
    const r = getRow(ident);
    if (!r) {
      throw new HttpError(404, '记录不存在');
    }
    if (r.kind === 'prepaid') throw new DomainError('余额账户会按计划自动扣减，请使用充值或校正操作');
    const data = ctx.body as Record<string, unknown>;
    if (data.confirm !== true) throw new DomainError('续费需要明确确认');
    if (r.status !== 'active' && r.status !== 'cancelling') {
      throw new DomainError('取消或结束记录不能确认续费，请先修改状态');
    }
    const actual = parseDate(data.actual_date);
    const nxt = parseDate(data.next_date);
    const today = todayInShanghai();
    if (actual > today) throw new DomainError('实际续费日期不能在未来');
    if (nxt <= actual || nxt <= parseDate(r.next_date)) throw new DomainError('下一次日期须晚于实际续费日期和原计划日期');
    // 实付金额默认取当前每期金额；传入 amount 时按订阅金额同样的规则校验。不改订阅本身的金额。
    const cents = data.amount === undefined || data.amount === null ? r.amount_cents : parseAmount(data.amount);
    const recorded = nowIsoInShanghai();
    const rid = newId();
    conn
      .prepare('INSERT INTO renewals (id,subscription_id,actual_date,previous_date,next_date,amount_cents,recorded_at) VALUES (?,?,?,?,?,?,?)')
      .run(rid, ident, actual, r.next_date, nxt, cents, recorded);
    const { id: _omit, ...rest } = r;
    const updated = { ...rest, next_date: nxt };
    conn.prepare('UPDATE subscriptions SET payload = ? WHERE id = ?').run(JSON.stringify(updated), ident);
    return { data: { ok: true, renewal_id: rid } };
  });
  return json(result.data, result.status ?? 200);
}

function listRenewals(ctx: Ctx): Response {
  const r = getRow(ctx.params.id);
  if (r === null) return json({ error: '记录不存在' }, 404);
  return json(historyView(r));
}

function undoRenewal(ctx: Ctx): Response {
  const { id: ident, rid } = ctx.params;
  const conn = db();
  const result = command('undoRenewal', ident, { ...(ctx.body as Record<string, unknown>), ...(ctx.params.rid ? { renewal_id: ctx.params.rid } : {}) }, { source: ctx.source ?? 'web', principal: ctx.principal, key: ctx.req.headers.get('Idempotency-Key') ?? undefined }, () => {
    const r = getRow(ident);
    if (!r) {
      throw new HttpError(404, '记录不存在');
    }
    if ((ctx.body as Record<string, unknown>).confirm !== true) throw new DomainError('撤销续费需要明确确认');
    const history = historyView(r);
    const target = history.find((h) => h.id === rid);
    if (!target) {
      throw new HttpError(404, '续费记录不存在');
    }
    if (history[0].id !== rid) throw new DomainError('只能撤销最近一次续费');
    if (!target.undoable) throw new DomainError('续费后计划日期已被修改，无法撤销；如需调整请直接编辑日期');
    // 撤销只退回计划日期并删除这条历史；金额、状态与日期锚点都不动。
    conn.prepare('DELETE FROM renewals WHERE id = ?').run(rid);
    const { id: _omit, ...rest } = r;
    conn.prepare('UPDATE subscriptions SET payload = ? WHERE id = ?').run(JSON.stringify({ ...rest, next_date: target.previous_date }), ident);
    return { data: { ok: true, next_date: target.previous_date } };
  });
  return json(result.data, result.status ?? 200);
}

function exportData(): Response {
  return db().transaction(exportSnapshot)();
}

function exportSnapshot(): Response {
  // 续费历史按写入顺序导出，恢复时按列表顺序写回，早期无时间戳的记录仍保持先后关系。
  const items = rows().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const renewals = (db().prepare('SELECT * FROM renewals ORDER BY rowid').all() as RenewalRow[]).map(withAmount);
  const balances = entries();
  const version = items.some(r => r.kind === 'prepaid') ? 2 : 1;
  return json(
    { format: 'subscription-ledger', version, currency: 'CNY', items, renewals, ...(version === 2 ? { balance_entries: balances } : {}) },
    200,
    { 'Content-Disposition': 'attachment; filename="subscription-ledger.json"' },
  );
}

async function restore(ctx: Ctx): Promise<Response> {
  const data = ctx.body as Record<string, unknown>;
  if (data.confirm !== true) throw new DomainError('恢复覆盖需要明确确认');
  const backup = data.backup as Record<string, unknown> | null;
  if (
    typeof backup !== 'object' || backup === null || Array.isArray(backup) ||
    backup.format !== 'subscription-ledger' || ![1, 2].includes(backup.version as number) || backup.currency !== 'CNY'
  ) {
    throw new DomainError('备份格式/版本不支持（仅人民币）');
  }
  const items = backup.items;
  const history = backup.renewals;
  if (!Array.isArray(items) || items.length > 2000 || !Array.isArray(history) || history.length > 10000) {
    throw new DomainError('备份列表无效或超限');
  }
  const identifier = (value: unknown): string => {
    if (typeof value !== 'string' || !ID_RE.test(value)) throw new DomainError('备份 ID 无效');
    return value;
  };
  const prepared: Array<[string, string]> = [];
  const ids = new Set<string>();
  const itemMap = new Map<string, SubscriptionRecord>();
  for (const r of items) {
    const clean = validate(r, undefined, true);
    const ident = identifier((r as Record<string, unknown>).id);
    if (backup.version === 1 && clean.kind === 'prepaid') throw new DomainError('余额账户需要 v2 备份与完整流水');
    if (ids.has(ident)) throw new DomainError('备份存在重复记录');
    ids.add(ident);
    itemMap.set(ident, clean);
    prepared.push([ident, JSON.stringify(clean)]);
  }
  const balanceEntries = validateBalanceEntries(backup.version === 2 ? backup.balance_entries : [], itemMap);
  const preparedHistory: Array<[string, string, string, string, string, number | null, string | null]> = [];
  const historyIds = new Set<string>();
  for (const h of history) {
    if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new DomainError('续费历史无效');
    const row = h as Record<string, unknown>;
    const ident = identifier(row.id);
    const sub = identifier(row.subscription_id);
    if (historyIds.has(ident) || !ids.has(sub)) throw new DomainError('续费历史引用/ID 无效');
    if (itemMap.get(sub)?.kind === 'prepaid') throw new DomainError('余额账户不能包含订阅续费历史');
    const actual = parseDate(row.actual_date);
    const prev = parseDate(row.previous_date);
    const nxt = parseDate(row.next_date);
    if (nxt <= actual || nxt <= prev) throw new DomainError('续费历史日期无效');
    // 早期备份没有金额与记录时间；缺失或 null 视为未记录，不用当前金额冒充。
    const cents = row.amount_cents === undefined || row.amount_cents === null ? null : parseCents(row.amount_cents);
    const recorded = row.recorded_at === undefined || row.recorded_at === null ? null : parseTimestamp(row.recorded_at);
    historyIds.add(ident);
    preparedHistory.push([ident, sub, actual, prev, nxt, cents, recorded]);
  }
  // 先拿写锁再备份同一个已提交快照，随后在同一事务内覆盖。
  const conn = db();
  const root = dataRoot();
  const backupsDir = path.join(root, 'backups');
  const stamp = nowIsoInShanghai().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(backupsDir, `${stamp}-${crypto.randomBytes(6).toString('hex')}.sqlite3`);
  restoringDatabase = true;
  try {
    conn.exec('BEGIN IMMEDIATE');
    fs.mkdirSync(/* turbopackIgnore: true */ backupsDir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(/* turbopackIgnore: true */ target, 'wx', 0o600);
    fs.closeSync(fd);
    // better-sqlite3 的 backup 不能跑在持有写事务的同一连接上；另开只读连接，
    // 主连接的 BEGIN IMMEDIATE（RESERVED 锁）不阻塞读取，语义与 Python 版一致。
    const reader = new Database(/* turbopackIgnore: true */ path.join(root, 'ledger.sqlite3'), { readonly: true, fileMustExist: true });
    try {
      await reader.backup(target);
    } finally {
      reader.close();
    }
    conn.prepare('DELETE FROM renewals').run();
    conn.prepare('DELETE FROM balance_entries').run();
    conn.prepare('DELETE FROM notifications').run();
    conn.prepare('DELETE FROM subscriptions').run();
    const insertItem = conn.prepare('INSERT INTO subscriptions VALUES (?,?)');
    for (const [ident, payloadText] of prepared) insertItem.run(ident, payloadText);
    const insertHistory = conn.prepare(
      'INSERT INTO renewals (id,subscription_id,actual_date,previous_date,next_date,amount_cents,recorded_at) VALUES (?,?,?,?,?,?,?)',
    );
    for (const entry of preparedHistory) insertHistory.run(...entry);
    const insertBalance = conn.prepare('INSERT INTO balance_entries(id,subscription_id,kind,period_date,payload) VALUES (?,?,?,?,?)');
    for (const e of balanceEntries) insertBalance.run(e.id, e.subscription_id, e.kind, e.period_date, JSON.stringify(e));
    conn.exec('COMMIT');
  } catch (error) {
    try { conn.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw error;
  } finally {
    restoringDatabase = false;
  }
  return json({ ok: true, backup_file: path.basename(target) });
}

// ---------- 路由与守卫（对应 before_request） ----------

type Handler = (ctx: Ctx) => Response | Promise<Response>;

const PUBLIC_PATHS = new Set(['/api/login', '/api/session']);

const ROUTES: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pathPattern: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = pathPattern.replace(/<(\w+)>/g, (_all, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  ROUTES.push({ method, pattern: new RegExp(`^${pattern}$`), keys, handler });
}

route('GET', '/api/openapi.json', () => json(openapi));
route('GET', '/api/session', sessionInfo);
route('POST', '/api/login', login);
route('POST', '/api/logout', logout);
route('GET', '/api/items', listItems);
route('GET', '/api/items/<id>', ctx => {
  const r = getRow(ctx.params.id);
  return r ? json({ ...r, suggested_next: domain.advance(r) }) : json({ error: '记录不存在' }, 404);
});
route('GET', '/api/summary', stats);
route('POST', '/api/items', addItem);
route('GET', '/api/items/<id>/balance-entries', ctx => getRow(ctx.params.id) ? json(entries(ctx.params.id)) : json({ error: '记录不存在' }, 404));
for (const action of ['topup', 'reconcile', 'bill']) route('POST', `/api/items/<id>/${action}`, ctx => {
  if (!ctx.req.headers.get('Idempotency-Key')) throw new DomainError('余额操作需要 Idempotency-Key 请求标识');
  return itemCommand(ctx, action);
});
route('GET', '/api/reminders', () => json(db().transaction(() => reminders())()));
route('GET', '/api/notifications', () => json(notificationStatus()));
route('PUT', '/api/notifications', ctx => json(saveSettings(ctx.body as Record<string, unknown>)));
route('POST', '/api/notifications/test', async ctx => {
  if ((ctx.body as Record<string, unknown>).confirm !== true) throw new DomainError('发送测试通知需要确认');
  try { await sendTelegram('订阅账本：独立 Telegram 通知测试成功。'); }
  catch (error) { return json({ error: error instanceof Error ? error.message : '发送失败' }, 502); }
  return json({ ok: true });
});
route('POST', '/api/notifications/chats', async ctx => {
  try { return json(await telegramChats((ctx.body as Record<string, unknown>).token)); }
  catch (error) { if (error instanceof DomainError) throw error; return json({ error: error instanceof Error ? error.message : '读取失败' }, 502); }
});
route('GET', '/api/tokens', () => json(listTokens()));
route('POST', '/api/tokens', ctx => json(createToken(ctx.body as Record<string, unknown>), 201));
route('DELETE', '/api/tokens/<id>', ctx => {
  db().prepare('DELETE FROM agent_tokens WHERE id=?').run(ctx.params.id);
  return json({ ok: true });
});
route('PUT', '/api/items/<id>', changeItem);
route('DELETE', '/api/items/<id>', changeItem);
route('POST', '/api/items/<id>/renew', renew);
route('GET', '/api/items/<id>/renewals', listRenewals);
route('POST', '/api/items/<id>/renewals/<rid>/undo', undoRenewal);
route('GET', '/api/export', exportData);
route('POST', '/api/restore', restore);

async function readJsonBody(req: Request): Promise<unknown> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new PayloadTooLarge();
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new PayloadTooLarge();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DomainError('请求必须为 JSON 对象');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new DomainError('请求必须为 JSON 对象');
  return data;
}

class PayloadTooLarge extends Error {}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isAgent = url.pathname.startsWith('/api/v1/');
  const pathname = isAgent ? url.pathname.replace('/api/v1/', '/api/') : url.pathname;
  try {
    if (restoringDatabase) return json({ error: '正在恢复备份，请稍后重试' }, 503);
    const agent = isAgent ? authenticateAgent(req) : null;
    if (isAgent && !agent) return json({ error: 'Agent 访问令牌无效或已撤销' }, 401);
    if (isAgent && !/^\/api\/(items(?:\/[a-f0-9]{32}(?:\/(?:renew|renewals|balance-entries|topup|reconcile|bill)(?:\/[a-f0-9]{32}\/undo)?)?)?|summary|reminders|openapi\.json)$/.test(pathname)) return json({ error: 'Agent 无权访问此接口' }, 403);
    const needsBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (isAgent && needsBody && agent?.scope !== 'write') return json({ error: '此令牌仅允许读取' }, 403);
    if (isAgent && needsBody && !req.headers.get('Idempotency-Key')) return json({ error: '写操作需要 Idempotency-Key 请求标识' }, 400);
    const existing = isAgent ? { authenticated: true, csrf: '', exp: 0 } : readSessionFrom(req);
    const fresh = existing === null;
    const session = existing ?? { authenticated: false, csrf: newCsrf(), exp: 0 };
    if (!PUBLIC_PATHS.has(pathname) && !session.authenticated) {
      return json({ error: '请先登录' }, 401);
    }
    if (needsBody && !isAgent) {
      const token = req.headers.get('x-csrf-token') ?? '';
      if (!safeEqual(token, session.csrf)) return json({ error: 'CSRF 校验失败，请刷新重试' }, 403);
    }
    const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(pathname) })).find(({ r, m }) => r.method === req.method && m);
    if (!match || !match.m) return json({ error: '接口不存在' }, 404);
    const params: Record<string, string> = {};
    match.r.keys.forEach((key, index) => {
      params[key] = decodeURIComponent((match.m as RegExpExecArray)[index + 1]);
    });
    const body = needsBody ? await readJsonBody(req) : {};
    const response = await match.r.handler({ req, session, params, body, source: isAgent ? 'agent' : 'web', principal: agent?.id });
    // 首次建立匿名会话：下发带 CSRF 的会话 Cookie（对应 Flask 的 session.setdefault）；
    // 登录/退出等已自带会话 Cookie 的响应除外。
    if (fresh && !response.headers.has('Set-Cookie')) {
      const h = new Headers(response.headers);
      h.append('Set-Cookie', sessionSetCookie({ authenticated: false, csrf: session.csrf }));
      return new Response(response.body, { status: response.status, headers: h });
    }
    return response;
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof DomainError) return badRequest(error.message);
    if (error instanceof PayloadTooLarge) return json({ error: '文件过大，限制 16 MiB' }, 413);
    console.error('API 内部错误', error);
    return json({ error: '服务器内部错误' }, 500);
  }
}
