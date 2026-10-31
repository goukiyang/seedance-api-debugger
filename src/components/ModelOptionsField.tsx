'use client';

export type ModelOption = {
  id: string;
  label: string;
  available?: boolean;
  reason?: string;
};

type Props = {
  id?: string;
  label: string;
  options: ModelOption[];
  /** 多选：选中的模型 id 列表 */
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  loading?: boolean;
  emptyHint?: string;
  hint?: string;
  /** 刷新按钮（一键拉上游） */
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
};

/**
 * 与抠图页同一套 ModelOption 形状；后台白名单用多选勾选（对照 admin-users-checkbox-stack）。
 * 单选场景可自行用 form-select，本组件专供多选白名单。
 */
export default function ModelOptionsField({
  id,
  label,
  options,
  value,
  onChange,
  max = 30,
  loading = false,
  emptyHint = '暂无模型，请先刷新上游列表',
  hint,
  onRefresh,
  refreshing = false,
  refreshLabel = '刷新模型列表',
}: Props) {
  const selected = new Set(value);

  const toggle = (modelId: string, checked: boolean) => {
    if (checked) {
      if (selected.has(modelId) || value.length >= max) return;
      onChange([...value, modelId].slice(0, max));
      return;
    }
    onChange(value.filter((id) => id !== modelId));
  };

  return (
    <div className="form-group" id={id}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <label className="form-label" style={{ marginBottom: 0 }}>{label}</label>
        {onRefresh ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={refreshing || loading}
            onClick={onRefresh}
          >
            {refreshing ? '刷新中…' : refreshLabel}
          </button>
        ) : null}
      </div>
      {loading ? <div className="form-hint">正在读取模型列表…</div> : null}
      {!loading && options.length === 0 ? <div className="form-hint">{emptyHint}</div> : null}
      {options.length > 0 ? (
        <div className="admin-users-checkbox-stack" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}>
          {options.map((model) => {
            const disabled = model.available === false || (!selected.has(model.id) && value.length >= max);
            return (
              <label key={model.id}>
                <input
                  type="checkbox"
                  checked={selected.has(model.id)}
                  disabled={disabled && !selected.has(model.id)}
                  onChange={(event) => toggle(model.id, event.target.checked)}
                />
                {' '}
                {model.label || model.id}
                {model.available === false ? `（不可用：${model.reason || '服务未就绪'}）` : ''}
              </label>
            );
          })}
        </div>
      ) : null}
      <div className="form-hint">
        已选 {value.length}/{max}
        {hint ? ` · ${hint}` : ''}
      </div>
    </div>
  );
}
