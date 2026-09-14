/** 真实 TCP HTTP 验收：隔离临时数据 + 随机 loopback 端口，跑生产构建产物。
 *  需要先用 `pnpm build` 生成 .next/standalone。不涉及常驻服务、生产秘密或用户数据。
 *  运行：`pnpm smoke`
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/server/auth';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = path.join(ROOT, '.next', 'standalone', 'server.js');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address !== 'object' || !address) return reject(new Error('无法分配端口'));
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (res.status === 200) return;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('HTTP 服务未在限定时间内就绪');
}

class HttpClient {
  private cookies = new Map<string, string>();
  constructor(public base: string) {}

  private storeCookies(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/Max-Age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  hasHttpOnlyCookie(): boolean {
    return this.cookies.size > 0;
  }

  async request(
    pathName: string,
    method = 'GET',
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; data: any; headers: Headers }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    };
    if (token !== undefined) headers['X-CSRF-Token'] = token;
    const res = await fetch(this.base + pathName, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    this.storeCookies(res);
    const raw = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    return { status: res.status, data: isJson ? JSON.parse(raw) : raw, headers: res.headers };
  }
}

async function startServer(dataDir: string): Promise<{ proc: ChildProcess; port: number }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [STANDALONE], {
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', LEDGER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  await waitReady(port);
  return { proc, port };
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  proc.kill('SIGTERM');
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    timer.unref?.();
  });
  await Promise.race([exited, timeout]);
  if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
}

async function main(): Promise<void> {
  if (!fs.existsSync(STANDALONE)) {
    throw new Error('未找到 .next/standalone/server.js，请先运行 pnpm build');
  }
  const checks: string[] = [];
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ledger-http-'));
  try {
    const password = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(path.join(root, 'password.hash'), hashPassword(password), { mode: 0o600 });

    let { proc, port } = await startServer(root);
    const client = new HttpClient(`http://127.0.0.1:${port}`);
    try {
      assert((await client.request('/')).status === 200, '首页 200');
      assert((await client.request('/icon.svg')).status === 200, 'favicon 200');
      assert((await client.request('/api/items')).status === 401, '未登录 401');
      checks.push('HTTP 未登录隔离/HTML及静态资源');

      const session = await client.request('/api/session');
      let token: string = session.data.csrf;
      assert(client.hasHttpOnlyCookie(), '会话 Cookie 已写入');
      assert((await client.request('/api/login', 'POST', { password }, 'invalid')).status === 403, '错误 CSRF 403');
      const login = await client.request('/api/login', 'POST', { password }, token);
      assert(login.status === 200, '登录成功');
      token = login.data.csrf;
      checks.push('真实 Cookie 登录及 CSRF');

      const record = {
        name: 'HTTP验收 <script>', amount: '19.99', cycle: 'monthly', days: null,
        next_date: '2024-01-31', status: 'active', auto_renew: true,
        url: 'https://example.com/manage', notes: '临时测试，不是用户数据', end_date: null,
      };
      const created = await client.request('/api/items', 'POST', record, token);
      assert(created.status === 201, '新增 201');
      const ident = created.data.id as string;
      record.amount = '20.01';
      assert((await client.request(`/api/items/${ident}`, 'PUT', record, token)).status === 200, '编辑 200');
      assert(
        (await client.request(`/api/items/${ident}/renew`, 'POST', { actual_date: '2024-01-31', next_date: '2024-02-29', confirm: true }, token)).status === 200,
        '月底续费 200',
      );
      const items1 = (await client.request('/api/items')).data as Array<{ suggested_next: string }>;
      assert(items1[0].suggested_next === '2024-03-31', '月底锚点推进');
      checks.push('HTTP 新增/编辑/月底续费');

      const quarterly = { ...record, name: 'HTTP季付验收', cycle: 'quarterly', next_date: '2024-01-31' };
      const q = await client.request('/api/items', 'POST', quarterly, token);
      assert(q.status === 201, '季付新增 201');
      const qid = q.data.id as string;
      assert(
        (await client.request(`/api/items/${qid}/renew`, 'POST', { actual_date: '2024-01-31', next_date: '2024-04-30', confirm: true }, token)).status === 200,
        '季付续费 200',
      );
      const items2 = (await client.request('/api/items')).data as Array<{ id: string; suggested_next: string }>;
      assert(items2.find((r) => r.id === qid)!.suggested_next === '2024-07-31', '季付锚点推进');

      let history = (await client.request(`/api/items/${ident}/renewals`)).data as Array<{ id: string; amount: string; undoable: boolean }>;
      assert(history[0].amount === '20.01' && history[0].undoable === true, '历史默认取每期金额且可撤销');
      assert(
        (await client.request(`/api/items/${ident}/renew`, 'POST', { actual_date: '2024-02-29', next_date: '2024-03-31', amount: '21.00', confirm: true }, token)).status === 200,
        '显式实付续费 200',
      );
      history = (await client.request(`/api/items/${ident}/renewals`)).data as typeof history;
      assert(history.map((h) => h.amount).join() === '21.00,20.01', '历史金额顺序');
      assert(history.map((h) => h.undoable).join() === 'true,false', '仅最近可撤销');
      assert(
        (await client.request(`/api/items/${ident}/renewals/${history[1].id}/undo`, 'POST', { confirm: true }, token)).status === 400,
        '撤销非最近一次 400',
      );
      const undone = await client.request(`/api/items/${ident}/renewals/${history[0].id}/undo`, 'POST', { confirm: true }, token);
      assert(undone.status === 200 && undone.data.next_date === '2024-02-29', '撤销退回原计划日期');
      const current = ((await client.request('/api/items')).data as Array<{ id: string; next_date: string; suggested_next: string; amount: string }>).find(
        (r) => r.id === ident,
      )!;
      assert(current.next_date === '2024-02-29' && current.suggested_next === '2024-03-31' && current.amount === '20.01', '撤销不改金额与锚点');
      assert(((await client.request(`/api/items/${ident}/renewals`)).data as unknown[]).length === 1, '撤销后历史剩一条');
      checks.push('HTTP 续费实付金额/历史列表/撤销最近一次');

      const original = (await client.request('/api/export')).data;
      assert(original.renewals[0].amount_cents === 2001 && original.renewals[0].recorded_at, '导出含金额与记录时间');
      assert((await client.request('/api/restore', 'POST', { confirm: true, backup: { bad: 1 } }, token)).status === 400, '坏备份 400');
      assert(JSON.stringify((await client.request('/api/export')).data) === JSON.stringify(original), '坏备份不改库');
      assert((await client.request('/api/restore', 'POST', { confirm: true, backup: original }, token)).status === 200, '恢复 200');
      assert(JSON.stringify((await client.request('/api/export')).data) === JSON.stringify(original), '恢复往返一致');
      const items3 = (await client.request('/api/items')).data as Array<{ id: string; suggested_next: string }>;
      assert(items3.find((r) => r.id === qid)!.suggested_next === '2024-07-31', '恢复后季付锚点保持');
      checks.push('HTTP 季付月底续费及混合周期备份恢复');

      assert(fs.readdirSync(path.join(root, 'backups')).filter((f) => f.endsWith('.sqlite3')).length === 1, '恢复前已备份旧库');
      checks.push('HTTP 导出/坏输入保护/恢复前备份');

      assert((await client.request('/api/summary')).status === 200, '统计 200');

      await stopServer(proc);
      ({ proc, port } = await startServer(root));
      // 复用旧 Cookie 与 CSRF：会话密钥持久化在数据目录，重启后会话与数据仍有效
      client.base = `http://127.0.0.1:${port}`;
      const items4 = (await client.request('/api/items')).data as Array<{ amount: string }>;
      assert(items4[0].amount === '20.01', '重启后数据与会话仍在');
      checks.push('进程真实重启后数据库及会话持久化');

      assert((await client.request(`/api/items/${ident}`, 'DELETE', { confirm: true }, token)).status === 200, '删除 1');
      assert((await client.request(`/api/items/${qid}`, 'DELETE', { confirm: true }, token)).status === 200, '删除 2');
      assert(((await client.request('/api/items')).data as unknown[]).length === 0, '删除后为空');
      assert((await client.request('/api/logout', 'POST', {}, token)).status === 200, '退出 200');
      assert((await client.request('/api/export')).status === 401, '退出后拒绝读取');
      checks.push('HTTP 删除/退出后拒绝读取');
    } finally {
      await stopServer(proc);
    }
    const closed = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection({ port, host: '127.0.0.1' });
      probe.once('error', () => resolve(true));
      probe.once('connect', () => {
        probe.end();
        resolve(false);
      });
    });
    assert(closed, '端口已关闭');
    checks.push('临时服务停止、端口关闭；临时库退出后删除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(checks.map((c) => 'PASS ' + c).join('\n'));
  console.log(`HTTP SMOKE: ${checks.length} groups passed`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
