/**
 * API 客户端：JSON + X-CSRF-Token。401（登录接口除外）时清空本地会话态并重新取 CSRF，
 * 私界面数据由 onSessionExpired 回调通知上层清空（对应原 app.js 的 DOM/状态清理）。
 */

let csrf = '';
let sessionExpiredHandler: (() => void) | null = null;

export function setCsrf(token: string): void {
  csrf = token;
}

export function setSessionExpiredHandler(handler: () => void): void {
  sessionExpiredHandler = handler;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') {
      csrf = '';
      sessionExpiredHandler?.();
      try {
        const session = await api<{ csrf: string }>('/api/session');
        csrf = session.csrf;
      } catch {
        // 离线时保持清空状态；登录流程会重新取会话。
      }
    }
    throw new ApiError(data.error || `请求失败 ${response.status}`, response.status);
  }
  return data as T;
}
