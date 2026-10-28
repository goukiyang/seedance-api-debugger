export function videoFeishuErrorText(code: unknown) {
  const messages: Record<string, string> = {
    not_authenticated: '请先登录后核对飞书设置', account_unavailable: '账号状态已变化，请重新登录',
    preference_unavailable: '飞书设置暂不可读取', preference_changed: '飞书设置已变化，请重新读取后保存',
    binding_unavailable: '当前账号暂不能发送到飞书，请核对本人绑定', invalid_preference: '飞书设置格式无效，请重新读取',
    invalid_notification_choice: '飞书通知选择无效，请重新读取设置', notification_source_forbidden: '此任务不支持发送到飞书',
    task_unavailable: '任务不存在或当前无权查看', notification_unavailable: '发送记录暂不可核对',
    notification_cannot_cancel: '已开始准备或发送，当前不能取消；请刷新查看结果',
    notification_changed: '发送状态已变化，请重新读取', notification_event_conflict: '原发送记录不一致，请保留原任务并联系管理员',
  };
  return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : '飞书通知暂不可核对，请稍后重新读取';
}
