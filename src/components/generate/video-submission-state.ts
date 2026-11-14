type VideoSubmissionState = {
  status?: string | null;
  local_status?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  message?: string | null;
  submission_unconfirmed?: boolean;
};

export function isVideoSubmissionUnconfirmed(task: VideoSubmissionState) {
  return task.submission_unconfirmed === true
    || task.error_code === 'IP_SUBMISSION_UNCONFIRMED'
    || (task.local_status ?? task.status) === 'submission_unknown';
}

export function videoPendingStatusLabel(status: string | null | undefined): string | null {
  if (status === 'submission_unknown') return '提交结果待确认';
  if (status === 'retry_wait') return '等待安全重试';
  if (status === 'retry_submitting') return '正在提交';
  return null;
}

export function videoSubmissionUnknownMessage(task: VideoSubmissionState): string | null {
  if (!isVideoSubmissionUnconfirmed(task)) return null;
  return task.error_message?.trim() || task.message?.trim()
    || '原提交结果和费用仍待核对，原预留保留；可离开页面，稍后打开原任务查看，请勿重复提交。';
}
