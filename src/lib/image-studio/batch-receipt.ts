export async function readBatchResponse(response: Response, expectBatch = false) {
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('批次回执无效，请查询原提交，不要新建任务');
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '批次操作失败，请重试');
  if (expectBatch && (!data.batch || !/^[a-f0-9]{64}$/.test(data.batch.id) || typeof data.batch.moduleId !== 'string'
    || !['preparing', 'ready', 'paused', 'blocked', 'cancelled', 'uncertain', 'complete'].includes(data.batch.state)
    || !['total', 'generated', 'failed', 'uncertain', 'active', 'pending', 'prepared', 'budget', 'committedCredits', 'unitCredits'].every(key => Number.isInteger(data.batch[key]) && data.batch[key] >= 0))) throw new Error('批次回执尚未确认，请查询原提交，不会重新生成');
  return data;
}
