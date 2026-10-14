/** Read-only projection: only proven normal delivery supersedes prior polling copy. */
export function studioGenerationDetailSuperseded(status: string, checkpoint: { phase?: string; code?: string } | null,
  receipt: { state: string; waitingStatus?: string } | null): boolean {
  return ['running', 'channel_running'].includes(status)
    && Boolean(checkpoint && ['download', 'validate', 'save'].includes(checkpoint.phase || '') && !checkpoint.code)
    && receipt?.state === 'success' && receipt.waitingStatus === 'pending';
}
