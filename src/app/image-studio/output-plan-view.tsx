import type { PublicImageOutputPlan } from '@/lib/image-generation/output-plan';

export function imagePlanSize(plan: PublicImageOutputPlan | null | undefined, frozenSize?: string | null) {
  const size = plan?.outputSize || frozenSize;
  const dimensions = typeof size === 'string' ? /^(\d+)x(\d+)$/.exec(size) : null;
  if (dimensions) return `${dimensions[1]} × ${dimensions[2]} px`;
  return typeof size === 'string' && /^(?:0\.5|1|2|4)K$/.test(size) ? `${size}（尺寸由模型确定）` : null;
}

export function ImageOutputPlansSummary({ plans }: { plans?: Array<{ ordinal: number; outputPlan: PublicImageOutputPlan | null }> }) {
  if (!plans?.length) return null;
  const sizes = Array.from(new Set(plans.map(item => imagePlanSize(item.outputPlan) || '尺寸待确认')));
  return <div>
    <p>{sizes.length === 1 ? `预计提交：${sizes[0]}` : `预计提交：${sizes.length} 种尺寸，按各张主图计算`}</p>
    {plans.length > 1 && <details><summary>逐张尺寸 · {plans.length} 项</summary>
      {plans.map(item => <p key={item.ordinal}>第 {item.ordinal} 项：{imagePlanSize(item.outputPlan) || '尺寸待确认'}</p>)}
    </details>}
  </div>;
}

export function ImageOutputPlanDetails({ plan, frozenSize, resolution, ratio, width, height, className }: {
  plan?: PublicImageOutputPlan | null; frozenSize?: string | null; resolution?: string | null;
  ratio?: string | null; width?: number | null; height?: number | null; className?: string;
}) {
  const submitted = imagePlanSize(plan, frozenSize);
  if (!submitted && !plan) return null;
  const selectedResolution = plan?.requestedResolution || resolution;
  const selectedRatio = plan?.requestedRatio || ratio;
  const automaticRatio = plan?.aspectRatioSource === 'reference' ? '跟随主图比例'
    : plan?.aspectRatioSource === 'model-default' ? '模型默认比例' : '自动比例';
  const selected = [selectedResolution, selectedRatio === 'auto' ? automaticRatio : selectedRatio].filter(Boolean).join(' · ');
  return <details className={className}>
    <summary>图片规格</summary>
    <p>所选：{selected || '历史选择未记录'}</p>
    <p>提交：{submitted || '尺寸未记录'}</p>
    <p>返回：{width && height ? `${width} × ${height} px` : '尚无可确认的图片尺寸'}</p>
  </details>;
}
