'use client';

type ProjectActionKind = 'archive' | 'restore' | 'delete';

type ProjectActionConfirmModalProps = {
  action: ProjectActionKind;
  projectName: string;
  meta?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

const ACTION_COPY: Record<ProjectActionKind, { title: string; description: string; confirmLabel: string }> = {
  archive: {
    title: '归档项目',
    description: '归档后项目仍可查看，历史任务和图集会保留，但不能继续生成或新增素材。',
    confirmLabel: '确认归档',
  },
  restore: {
    title: '恢复项目',
    description: '恢复后项目可继续生成和新增素材。',
    confirmLabel: '确认恢复',
  },
  delete: {
    title: '删除空项目',
    description: '空项目删除后不会再出现在项目列表。',
    confirmLabel: '确认删除',
  },
};

export default function ProjectActionConfirmModal({
  action,
  projectName,
  meta,
  busy = false,
  onCancel,
  onConfirm,
}: ProjectActionConfirmModalProps) {
  const copy = ACTION_COPY[action];
  const confirmClassName = action === 'restore' ? 'btn btn-primary' : 'btn btn-danger';

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={`${copy.title}确认`}>
      <div className="modal-panel project-removal-modal">
        <div className="modal-header">
          <div>
            <h2>{copy.title}</h2>
            <p>{copy.description}</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="project-removal-summary" data-action={action}>
          <strong>{projectName}</strong>
          {meta && <span>{meta}</span>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className={confirmClassName} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中...' : copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
