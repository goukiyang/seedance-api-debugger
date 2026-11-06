/** Plugin 0.3.1 binding contract; safe to import from the admin client. */
export const BRIDGE_TOOLS = ['midjourney', 'chatgpt', 'jimeng'] as const;
export type BridgeTool = typeof BRIDGE_TOOLS[number];
export type BridgeLogin = 'ok' | 'none' | 'unknown' | 'blocked';
export const BRIDGE_TOOL_LABELS: Record<BridgeTool, string> = {
  midjourney: 'Midjourney', chatgpt: 'ChatGPT', jimeng: '即梦',
};

export type BridgeToolBinding = {
  accept: boolean;
  login: BridgeLogin;
  account: string;
  accountKey: string;
  tabOpen: boolean;
  checkedAt: number;
  dailyCap?: number;
};

export type BridgeBinding = {
  deviceId: string;
  machineName: string;
  profileName: string;
  chromeEmail: string;
  platform: string;
  extVersion: string;
  shared: boolean;
  editedAt: number;
  editedBy: string;
  lastSeenAt: number;
  disabled: boolean;
  disabledReason: string;
  archived: boolean;
  tools: Record<BridgeTool, BridgeToolBinding>;
};

export type BridgeBindingOwner = { id: string; name: string; avatar_url: string | null };
export type ListedBridgeBinding = BridgeBinding & { owner: BridgeBindingOwner; editor?: BridgeBindingOwner; online: boolean };
