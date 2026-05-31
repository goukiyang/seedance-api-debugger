'use client';

interface PaginationControlsProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
  label?: string;
}

export default function PaginationControls({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  label = '记录',
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
        <button
          className="btn btn-secondary"
          type="button"
          disabled={clampedPage <= 1}
          onClick={() => onPageChange(clampedPage - 1)}
        >
          上一页
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={clampedPage >= totalPages}
          onClick={() => onPageChange(clampedPage + 1)}
        >
          下一页
        </button>
      </div>
    </nav>
  );
}
