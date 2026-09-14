import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * 安全响应头（对应原 Flask after_request）。CSP 用每请求 nonce：
 * Next 会把请求头里 CSP 的 nonce 应用到自己的内联脚本；主题脚本在 layout 里读取 x-nonce。
 * script-src 保持不放宽；style-src 需要 unsafe-inline（React/Radix 内联样式属性）。
 */
export default function proxy(req: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  // React 开发模式用 eval 做调试栈还原；生产构建不含 eval，保持严格。
  const scriptSrc =
    process.env.NODE_ENV === 'development'
      ? `script-src 'self' 'unsafe-eval' 'nonce-${nonce}' 'strict-dynamic'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export const config = {
  // Next 静态资源缓存由框架管理，图标缓存由 next.config.ts 设置。
  matcher: ['/((?!_next/static|icon.svg|_next/image).*)'],
};
