import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '视频生成 API 调试器',
  description: '即梦/Seedance 视频生成 API 调试工具',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
