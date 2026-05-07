import Link from 'next/link';

interface PagePlaceholderProps {
  title: string;
  description: string;
  currentPath: string;
}

export default function PagePlaceholder({
  title,
  description,
  currentPath,
}: PagePlaceholderProps) {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <p className="page-description">{description}</p>
      </div>

      <div className="card placeholder-card">
        <div className="placeholder-meta">
          <span className="placeholder-label">当前路径</span>
          <code className="placeholder-code">{currentPath}</code>
        </div>
        <div className="placeholder-meta">
          <span className="placeholder-label">状态</span>
          <span className="placeholder-status">内容建设中，后续版本将补充正式功能。</span>
        </div>
        <div className="placeholder-actions">
          <Link href="/dashboard" className="btn btn-primary">
            返回控制台
          </Link>
        </div>
      </div>
    </div>
  );
}
