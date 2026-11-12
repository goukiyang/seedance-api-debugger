/** Provider/source errors can quote an internal recipe. External responses keep only an action. */
export function externalStudioErrorMessage(status: number, insufficientCredits = false) {
  if (insufficientCredits) return '可用点数不足，请申请点数或联系管理员后继续';
  if (status === 403 || status === 404) return '当前模板或素材暂不可使用；本人输入、原任务和结果仍保留';
  if (status === 409) return '设置、模板或报价已变化，请重新读取并核对原提交；输入仍保留';
  if (status === 429) return '当前队列或批次已达上限，请稍后继续';
  return status >= 500 ? '本次操作暂未确认，请保留输入并查询原编号，不要重复生成' : '本次设置无法使用，请核对当前输入和生成参数';
}

export function externalStudioTaskError(error: string | null | undefined, status: string) {
  if (!error) return error;
  return status === 'failed' ? '本次生成未完成，请保留原任务编号核对；没有重新生成'
    : status === 'cancelled' ? '未受理任务已取消，原记录保留'
      : '原任务状态或费用仍待核对，请继续查询原编号；没有重新生成';
}
