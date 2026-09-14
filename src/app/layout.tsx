import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: '订阅账本',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {/* 首帧前应用手动选择的深浅色；未选择时由 CSS 跟随系统。仅存偏好，不含任何账本数据。 */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
