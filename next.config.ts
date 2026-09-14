import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  // 安全响应头在 proxy.ts（原 middleware）里统一设置：CSP 需要每请求 nonce。
  // 开发期允许 127.0.0.1 与 localhost 互访 dev 资源（HMR）。
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Next 静态资源缓存由框架按环境管理；HTML 与 API 的 no-store 由 proxy.ts 统一设置。
  async headers() {
    return [
      {
        source: '/icon.svg',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
      },
    ];
  },
};

export default nextConfig;
