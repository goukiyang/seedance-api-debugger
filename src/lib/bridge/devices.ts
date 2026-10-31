import { prisma } from '@/lib/prisma';

/** 存在 UserPreference（按 user_id 隔离），无需新表/迁移。 */
export const BRIDGE_DEVICES_PREF_KEY = 'bridge_devices_v1';
export const BRIDGE_DEVICE_STALE_MS = 10 * 60 * 1000;
const MAX_DEVICES = 20;
const SITES = ['chatgpt', 'midjourney', 'jimeng'] as const;
export type BridgeSite = typeof SITES[number];

export type BridgeSiteStatus = { loggedIn: boolean; account?: string };
export type BridgeDeviceRecord = {
  deviceId: string;
  deviceName: string;
  chromeProfile: string;
  extVersion: string;
  sites: Partial<Record<BridgeSite, BridgeSiteStatus>>;
  lastSeen: string;
};

function str(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function parseDeviceStatus(body: unknown): Omit<BridgeDeviceRecord, 'lastSeen'> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const deviceId = str(b.deviceId, 100);
  if (!deviceId) return null;
  const sites: BridgeDeviceRecord['sites'] = {};
  const rawSites = b.sites && typeof b.sites === 'object' ? b.sites as Record<string, unknown> : {};
  for (const site of SITES) {
    const v = rawSites[site];
    if (!v || typeof v !== 'object') continue;
    const row = v as Record<string, unknown>;
    const account = str(row.account, 120);
    sites[site] = { loggedIn: row.loggedIn === true, ...(account ? { account } : {}) };
  }
  return {
    deviceId,
    deviceName: str(b.deviceName, 100),
    chromeProfile: str(b.chromeProfile, 100),
    extVersion: str(b.extVersion, 40),
    sites,
  };
}

export async function readBridgeDevices(userId: string): Promise<BridgeDeviceRecord[]> {
  const row = await prisma.userPreference.findUnique({
    where: { user_id_key: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY } },
  });
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value_json);
    return Array.isArray(parsed) ? parsed as BridgeDeviceRecord[] : [];
  } catch {
    return [];
  }
}

export async function upsertBridgeDevice(userId: string, status: Omit<BridgeDeviceRecord, 'lastSeen'>) {
  const list = (await readBridgeDevices(userId)).filter((d) => d.deviceId !== status.deviceId);
  const record: BridgeDeviceRecord = { ...status, lastSeen: new Date().toISOString() };
  const next = [record, ...list].slice(0, MAX_DEVICES);
  const value_json = JSON.stringify(next);
  await prisma.userPreference.upsert({
    where: { user_id_key: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY } },
    update: { value_json },
    create: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY, value_json },
  });
  return record;
}

export function withStale(devices: BridgeDeviceRecord[], now = Date.now()) {
  return devices.map((d) => ({ ...d, stale: now - Date.parse(d.lastSeen) > BRIDGE_DEVICE_STALE_MS }));
}
