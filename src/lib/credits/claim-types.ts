export type ClaimCampaignConfig = {
  name: string; amount: number; startsAt: string; endsAt: string; enabled: boolean;
  audience: 'all' | 'internal' | 'external';
};
export type ClaimCampaign = ClaimCampaignConfig & {
  id: string; revision: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
};
export type CreditClaimReceipt = {
  campaignId: string; userId: string; amount: number; claimedAt: string; ledgerId: string;
  campaignName: string; campaignRevision: number; balanceAfter: number;
};
export type ClaimCampaignView = ClaimCampaign & { receipt: CreditClaimReceipt | null; claimedCount?: number };
export type ClaimCampaignList = { actorId: string; serverTime: string; campaigns: ClaimCampaignView[]; nextCursor: string | null };
export type ClaimCampaignSave = { id: string; expectedRevision: number; operationId: string; config: ClaimCampaignConfig };

export function claimCampaignState(campaign: ClaimCampaignConfig, receipt: CreditClaimReceipt | null, now: number) {
  if (receipt) return 'claimed';
  if (!campaign.enabled) return 'paused';
  if (now < Date.parse(campaign.startsAt)) return 'upcoming';
  if (now >= Date.parse(campaign.endsAt)) return 'ended';
  return 'available';
}
export const claimAudienceLabels = { all: '全部登录账号', internal: '内部账号', external: '外部账号' };
export function claimDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
