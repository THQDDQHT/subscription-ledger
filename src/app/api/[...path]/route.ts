// 全部 /api/* 请求统一进入 handleApi：鉴权、CSRF、限流等横切语义集中在
// src/server/api.ts 一处实现（对应原 Flask before_request），且测试可直接调用。
import { handleApi } from '@/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(req: Request): Promise<Response> {
  return handleApi(req);
}

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
