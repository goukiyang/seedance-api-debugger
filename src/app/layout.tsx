import type { Metadata } from 'next';
import './globals.css';
import './canvas-workspace.css';
import '@xyflow/react/dist/style.css';
import ClientLayout from './ClientLayout';

export const metadata: Metadata = {
  title: 'Seedance 2.0 内部平台',
  description: 'Seedance 2.0 统一工作台，覆盖生成、任务、素材与后台管理导航。',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
