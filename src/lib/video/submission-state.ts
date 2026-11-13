type VideoSubmissionState = {
  status?: string | null;
  local_status?: string | null;
  error_code?: string | null;
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
