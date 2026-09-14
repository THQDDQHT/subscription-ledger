/** 测试客户端：对应 Flask test_client，维护 Cookie 罐与 CSRF。 */
import { handleApi } from '@/server/api';

export class TestClient {
  private cookies = new Map<string, string>();
  token = '';

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

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

  async request(method: string, path: string, body?: unknown, withCsrf = true): Promise<Response> {
    const headers: Record<string, string> = { Cookie: this.cookieHeader() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (withCsrf && this.token) headers['X-CSRF-Token'] = this.token;
    const res = await handleApi(
      new Request(`http://test.local${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    this.storeCookies(res);
    return res;
  }

  get(path: string): Promise<Response> {
    return this.request('GET', path);
  }

  post(path: string, body?: unknown, withCsrf = true): Promise<Response> {
    return this.request('POST', path, body, withCsrf);
  }

  put(path: string, body?: unknown): Promise<Response> {
    return this.request('PUT', path, body);
  }

  delete(path: string, body?: unknown): Promise<Response> {
    return this.request('DELETE', path, body);
  }

  async json(path: string): Promise<unknown> {
    const res = await this.get(path);
    return res.json();
  }

  /** 对应 pytest 的 client fixture：匿名取 CSRF → 带 CSRF 登录 → 记录登录后的新 CSRF。 */
  async login(password = 'test-password-123'): Promise<void> {
    const session = (await (await this.get('/api/session')).json()) as { csrf: string };
    this.token = session.csrf;
    const res = await this.post('/api/login', { password });
    if (res.status !== 200) throw new Error(`登录失败：${res.status} ${JSON.stringify(await res.json())}`);
    const data = (await res.json()) as { csrf: string };
    this.token = data.csrf;
  }
}

/** post() 辅助，对应 pytest 的 post(c, url, data)。 */
export function post(client: TestClient, url: string, data: unknown, method: 'post' | 'put' | 'delete' = 'post'): Promise<Response> {
  return client.request(method.toUpperCase(), url, data);
}
