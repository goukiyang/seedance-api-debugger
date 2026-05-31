import type { ReactNode } from 'react';
import Link from 'next/link';

interface PageBannerProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  backHref?: string;
  backLabel?: string;
  tone?: 'default' | 'dark';
}

export default function PageBanner({
  eyebrow,
  title,
  description,
  actions,
  backHref,
  backLabel = '返回',
  tone = 'default',
}: PageBannerProps) {
  return (
    <header className={`page-banner page-banner-${tone}`}>
      <div className="page-banner-main">
        {backHref && (
          <Link className="page-banner-back" href={backHref}>
            {backLabel}
          </Link>
        )}
        {eyebrow && <div className="page-banner-eyebrow">{eyebrow}</div>}
        <h1 className="page-banner-title">{title}</h1>
        {description && <p className="page-banner-description">{description}</p>}
      </div>
      {actions && <div className="page-banner-actions">{actions}</div>}
    </header>
  );
}
