'use client';
import { ChevronFirst, ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationControlsProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
  label?: string;
  busy?: boolean;
}

export default function PaginationControls({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  label = '记录',
  busy = false,
}: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  const start = pageSize ? (clampedPage - 1) * pageSize + 1 : null;
  const end = pageSize ? Math.min(total, clampedPage * pageSize) : null;

  return (
    <nav className="page-pagination" aria-label="分页">
      <span className="page-pagination-summary">
        第 {clampedPage} / {totalPages} 页，共 {total} 条{label}
        {start !== null && end !== null ? `，当前 ${start}-${end}` : ''}
      </span>
      <div className="page-pagination-actions">
        <button className="btn btn-secondary" type="button" aria-label="回到第一页" title="回到第一页"
          disabled={busy || clampedPage <= 1} onClick={() => onPageChange(1)}><ChevronFirst size={17} /></button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={busy || clampedPage <= 1}
          aria-label="上一页" title="上一页"
          onClick={() => onPageChange(clampedPage - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={busy || clampedPage >= totalPages}
          aria-label="下一页" title="下一页"
          onClick={() => onPageChange(clampedPage + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </nav>
  );
}
