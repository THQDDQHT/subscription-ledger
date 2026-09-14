/** 移植自 scripts/session_regression.cjs：401 时清空会话态并刷新 CSRF；离线时保持清空。 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, setCsrf, setSessionExpiredHandler, ApiError } from '@/lib/api';

type FakeResponse = { status: number; body: unknown };

function fakeFetch(queue: Array<FakeResponse | Error>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('fake fetch 队列已空');
    if (next instanceof Error) throw next;
    return {
      ok: next.status === 200,
      status: next.status,
      json: async () => next.body,
    } as Response;
  });
}

describe('会话失效处理', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setSessionExpiredHandler(() => {});
  });

  test.each([false, true])('401 清理并尝试刷新 CSRF（刷新失败=%s）', async (failRefresh) => {
    setCsrf('stale');
    let expiredCalls = 0;
    setSessionExpiredHandler(() => {
      expiredCalls += 1;
    });
    const queue: Array<FakeResponse | Error> = [
      { status: 401, body: { error: 'expired' } },
      failRefresh ? new Error('offline') : { status: 200, body: { csrf: 'fresh' } },
    ];
    vi.stubGlobal('fetch', fakeFetch(queue));
    await expect(api('/api/items')).rejects.toBeInstanceOf(ApiError);
    expect(expiredCalls).toBe(1);
    // 再发一次请求，观察带出的 CSRF：刷新成功为 fresh，失败为空
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)['X-CSRF-Token'] ?? ''));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    await api('/api/items');
    expect(seen[0]).toBe(failRefresh ? '' : 'fresh');
  });
});
