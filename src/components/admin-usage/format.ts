import type { UsageMoney, UsageSummary } from '@/lib/admin/usage-types';

// Format integer micros without passing their total through an unsafe Number.
export function fixedDecimal(value: string | null | undefined, scale = 0, places = scale): string {
  if (value === null || value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return '待核';
  if (value.includes('.')) {
    const [whole, fraction] = value.split('.');
    return `${whole === '-0' ? '-0' : BigInt(whole).toLocaleString('zh-CN')}${fraction ? `.${fraction.replace(/0+$/, '') || '0'}` : ''}`;
  }
  const integer = BigInt(value);
  const negative = integer < BigInt(0);
  const absolute = negative ? -integer : integer;
  const divisor = BigInt('1' + '0'.repeat(scale));
  const target = BigInt('1' + '0'.repeat(places));
  const rounded = (absolute * target + divisor / BigInt(2)) / divisor;
  const whole = rounded / target;
  const fraction = places ? (rounded % target).toString().padStart(places, '0') : '';
  return `${negative ? '-' : ''}${whole.toLocaleString('zh-CN')}${fraction ? `.${fraction}` : ''}`;
}

export function points(value: string | null | undefined) { return fixedDecimal(value); }
export function money(value: string | null | undefined) { return value === null || value === undefined ? '待核' : `¥${fixedDecimal(value, 6, 2)}`; }
export function originalMoney(values: UsageMoney[]) {
  return values.length ? values.map(item => `${item.currency} ${fixedDecimal(item.amountMicros, 6, 6)}`).join(' · ') : '未接入或待核';
}
export function summaryCost(summary: UsageSummary) {
  if (summary.confirmedCostCnyMicros !== null) return money(summary.confirmedCostCnyMicros);
  return summary.confirmedCost.length ? originalMoney(summary.confirmedCost) : '待核 / 未接入';
}
export const KIND_LABELS: Record<string, string> = { video: '视频', image: '图片', text: '文字', flow: '工具流', cutout: '抠图' };
export const SOURCE_LABELS: Record<string, string> = {
  video_task: '视频生成', image_task: '图片生成', video_studio_run: '视频工作台文字', agent_text_step: '模板助手文字',
  role_run: '角色工作流', role_attempt: '角色文字调用', toolflow_run: '工具流', cutout_receipt: '抠图接续',
};
export const RESULT_LABELS: Record<string, string> = { ready: '文件已就绪', not_ready: '文件未就绪', unknown: '文件状态未知' };
export const RETENTION_LABELS: Record<string, string> = { active: '正常留存', user_deleted: '本人已删除', admin_hidden: '管理隐藏', retained: '保留中', unknown: '留存待确认' };
export const COST_LABELS: Record<string, string> = { confirmed: '费用已确认', pending: '费用待核', conflict: '费用冲突', unconnected: '费用未接入' };
export const ATTRIBUTION_LABELS: Record<string, string> = {
  frozen: '原使用归属', legacy_current: '历史按现有归属', legacy_snapshot: '历史快照归属', unassigned: '未归属', conflict: '归属冲突',
};
export const STATUS_LABELS: Record<string, string> = {
  succeeded: '已完成', success: '已完成', completed: '已完成', failed: '执行失败', cancelled: '已取消', canceled: '已取消',
  running: '执行中', processing: '处理中', pending: '待处理', queued: '排队中', submitted: '已提交',
  unknown: '执行待确认', pending_review: '待核对', awaiting_confirmation: '待核对',
  recorded: '调用已记录',
};
