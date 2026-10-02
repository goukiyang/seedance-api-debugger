import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板工作台分开显示文案与视频状态；复用历史输入只新建模块。图片记录刷新和加载更多保留已有内容，恢复入口明确为查询状态；视频模型与LoRA按通道识别，模块称呼和记录时间更清楚。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
