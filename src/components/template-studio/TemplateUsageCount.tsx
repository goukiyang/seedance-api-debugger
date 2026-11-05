export default function TemplateUsageCount({ count }: { count?: number | null }) {
  if (count === undefined) return null;
  return <span title="按已有生成提交统计；一批多张图片算一次，原请求重试和刷新不增加，失败或取消不回减。历史未记录模板归属的提交不猜算。">
    {count === null ? '次数待读取' : `使用 ${count.toLocaleString('zh-CN')} 次`}
  </span>;
}
