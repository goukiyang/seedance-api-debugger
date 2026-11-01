import type { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import type { BridgeBinding } from './device-binding-types';

/** Existing per-user storage; legacy fields remain readable by old plugins. */
export const BRIDGE_DEVICES_PREF_KEY = 'bridge_devices_v1';
export const BRIDGE_DEVICE_STALE_MS = 10 * 60 * 1000;
export const MAX_BRIDGE_DEVICES = 50;
const SITES = ['chatgpt', 'midjourney', 'jimeng'] as const;
export type BridgeSite = typeof SITES[number];

export type BridgeSiteStatus = { loggedIn: boolean; account?: string };
export type LegacyBridgeDevice = {
  deviceId: string;
  deviceName: string;
  chromeProfile: string;
  extVersion: string;
  sites: Partial<Record<BridgeSite, BridgeSiteStatus>>;
  lastSeen: string;
};
export type BridgeDeviceRecord = LegacyBridgeDevice & Partial<BridgeBinding>;
export type BridgeDeviceStore = { userId: string; devices: BridgeDeviceRecord[] };

export class BridgeDeviceError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

function str(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function parseDeviceStatus(body: unknown): Omit<LegacyBridgeDevice, 'lastSeen'> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const deviceId = str(b.deviceId, 100);
  if (!deviceId) return null;
  const sites: LegacyBridgeDevice['sites'] = {};
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

export function decodeBridgeDevices(value: string): BridgeDeviceRecord[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(d => !d || typeof d !== 'object' || typeof d.deviceId !== 'string')) {
    throw new BridgeDeviceError('设备记录格式异常，请联系管理员', 409);
  }
  return parsed as BridgeDeviceRecord[];
}

export async function readBridgeDevices(userId: string): Promise<BridgeDeviceRecord[]> {
  const row = await prisma.userPreference.findUnique({
    where: { user_id_key: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY } },
  });
  if (!row) return [];
  try { return decodeBridgeDevices(row.value_json); } catch { return []; }
}

/** All writers share a SQLite transaction so heartbeat, transfer and admin edits cannot lose each other. */
export function mutateBridgeDevices<T>(mutate: (stores: BridgeDeviceStore[], tx: Prisma.TransactionClient) => Promise<T>) {
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    const rows = await tx.userPreference.findMany({
      where: { key: BRIDGE_DEVICES_PREF_KEY }, select: { user_id: true, value_json: true },
    });
    const stores = rows.map(row => ({ userId: row.user_id, devices: decodeBridgeDevices(row.value_json) }));
    return mutate(stores, tx);
  }));
}

export function writeBridgeDevices(tx: Prisma.TransactionClient, userId: string, devices: BridgeDeviceRecord[]) {
  const value_json = JSON.stringify(devices);
  return tx.userPreference.upsert({
    where: { user_id_key: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY } },
    update: { value_json },
    create: { user_id: userId, key: BRIDGE_DEVICES_PREF_KEY, value_json },
  });
}

export function assertBridgeDeviceOwner(stores: BridgeDeviceStore[], userId: string, deviceId: string) {
  if (stores.some(s => s.userId !== userId && s.devices.some(d => d.deviceId === deviceId))) {
    throw new BridgeDeviceError('这台设备已归属其他用户', 403);
  }
}

export async function upsertBridgeDevice(userId: string, status: Omit<LegacyBridgeDevice, 'lastSeen'>) {
  return mutateBridgeDevices(async (stores, tx) => {
    assertBridgeDeviceOwner(stores, userId, status.deviceId);
    const list = stores.find(s => s.userId === userId)?.devices || [];
    const previous = list.find(d => d.deviceId === status.deviceId);
    if (!previous && list.length >= MAX_BRIDGE_DEVICES) throw new BridgeDeviceError('每人最多保留50条设备记录', 409);
    const now = Date.now();
    const record: BridgeDeviceRecord = { ...previous, ...status, lastSeen: new Date(now).toISOString(),
      ...(previous?.lastSeenAt !== undefined ? { lastSeenAt: now } : {}) };
    await writeBridgeDevices(tx, userId, [record, ...list.filter(d => d.deviceId !== status.deviceId)]);
    return record;
  });
}

export function withStale(devices: BridgeDeviceRecord[], now = Date.now()) {
  return devices.map(d => ({ ...d, stale: now - Date.parse(d.lastSeen) > BRIDGE_DEVICE_STALE_MS }));
}
