import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { displayUserName } from '@/lib/users/display';
import {
  assertBridgeDeviceOwner, BRIDGE_DEVICES_PREF_KEY, BRIDGE_DEVICE_STALE_MS, BridgeDeviceError,
  decodeBridgeDevices, MAX_BRIDGE_DEVICES, mutateBridgeDevices, writeBridgeDevices,
  type BridgeDeviceRecord,
} from './devices';
import { BRIDGE_TOOLS, type BridgeBinding, type BridgeLogin, type BridgeTool, type ListedBridgeBinding } from './device-binding-types';

type Actor = Pick<SessionUser, 'id' | 'name' | 'username' | 'role'>;
type Report = Omit<BridgeBinding, 'editedBy' | 'lastSeenAt' | 'disabled' | 'disabledReason' | 'archived'>;
type EditablePatch = Partial<Pick<BridgeBinding, 'machineName' | 'profileName' | 'shared'>> & {
  tools?: Partial<Record<BridgeTool, { accept?: boolean; dailyCap?: number }>>;
};
type BindingPatch = EditablePatch & Partial<Pick<BridgeBinding, 'disabled' | 'disabledReason' | 'archived'>> & { ownerUserId?: string };
const FACT_FIELDS = ['login', 'account', 'accountKey', 'tabOpen', 'checkedAt', 'platform', 'extVersion', 'chromeEmail'];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeDeviceError('请求内容必须是对象', 400);
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function timestamp(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function boolean(value: unknown, field: string) {
  if (typeof value !== 'boolean') throw new BridgeDeviceError(field + ' 必须为是或否', 400);
  return value;
}
function dailyCap(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BridgeDeviceError('每日上限必须是数字', 400);
  return Math.max(0, Math.min(500, Math.trunc(value)));
}
function maskEmail(value: unknown) {
  const email = text(value, 80);
  if (!email) return '';
  const parts = email.split('@');
  return parts[0].slice(0, 1) + '***' + (parts.length === 2 ? '@' + parts[1] : '');
}
function account(value: unknown) {
  const valueText = text(value, 80);
  return valueText.includes('@') ? maskEmail(valueText) : valueText;
}
export function bindingDeviceId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new BridgeDeviceError('deviceId 不能为空且不能超过100字', 400);
  return value.trim();
}

export function parseBindingReport(value: unknown): Report {
  const body = object(value);
  const rawTools = body.tools === undefined ? {} : object(body.tools);
  const tools = {} as BridgeBinding['tools'];
  for (const tool of BRIDGE_TOOLS) {
    const raw = rawTools[tool] === undefined ? {} : object(rawTools[tool]);
    const login: BridgeLogin = raw.login === 'ok' || raw.login === 'none' || raw.login === 'blocked' ? raw.login : 'unknown';
    tools[tool] = {
      accept: raw.accept === true, login, account: account(raw.account), accountKey: text(raw.accountKey, 80),
      tabOpen: raw.tabOpen === true, checkedAt: timestamp(raw.checkedAt),
      ...(tool === 'midjourney' && raw.dailyCap !== undefined ? { dailyCap: dailyCap(raw.dailyCap) } : {}),
    };
  }
  return {
    deviceId: bindingDeviceId(body.deviceId), machineName: text(body.machineName, 40),
    profileName: text(body.profileName, 40), chromeEmail: maskEmail(body.chromeEmail),
    platform: text(body.platform, 20), extVersion: text(body.extVersion, 40), shared: body.shared === true,
    editedAt: timestamp(body.editedAt), tools,
  };
}

/** Legacy records get a read projection, not a migration or invented last edit. */
export function presentBinding(device: BridgeDeviceRecord): BridgeBinding {
  const tools = {} as BridgeBinding['tools'];
  for (const tool of BRIDGE_TOOLS) {
    const current = device.tools?.[tool];
    const legacy = device.sites?.[tool];
    tools[tool] = current ? { ...current } : {
      accept: false, login: legacy ? (legacy.loggedIn ? 'ok' : 'none') : 'unknown',
      account: account(legacy?.account), accountKey: '', tabOpen: false, checkedAt: 0,
    };
  }
  return {
    deviceId: device.deviceId, machineName: device.machineName ?? device.deviceName,
    profileName: device.profileName ?? device.chromeProfile, chromeEmail: device.chromeEmail ?? '',
    platform: device.platform ?? '', extVersion: device.extVersion, shared: device.shared ?? false,
    editedAt: device.editedAt ?? 0, editedBy: device.editedBy ?? '',
    lastSeenAt: device.lastSeenAt ?? (Date.parse(device.lastSeen) || 0),
    disabled: device.disabled ?? false, disabledReason: device.disabledReason ?? '', archived: device.archived ?? false, tools,
  };
}

export async function reportBinding(me: Actor, input: unknown) {
  const report = parseBindingReport(input);
  return mutateBridgeDevices(async (stores, tx) => {
    assertBridgeDeviceOwner(stores, me.id, report.deviceId);
    const list = stores.find(s => s.userId === me.id)?.devices || [];
    const previous = list.find(d => d.deviceId === report.deviceId);
    if (!previous && list.length >= MAX_BRIDGE_DEVICES) throw new BridgeDeviceError('每人最多保留50条设备记录', 409);
    const now = Date.now();
    const takeEdits = previous?.editedAt === undefined || report.editedAt > previous.editedAt;
    const prior = previous ? presentBinding(previous) : null;
    const tools = {} as BridgeBinding['tools'];
    for (const tool of BRIDGE_TOOLS) {
      tools[tool] = {
        ...report.tools[tool],
        accept: takeEdits ? report.tools[tool].accept : prior!.tools[tool].accept,
      };
      if (tool === 'midjourney') {
        const cap = takeEdits ? report.tools[tool].dailyCap : prior!.tools[tool].dailyCap;
        if (cap !== undefined) tools[tool].dailyCap = cap;
        else delete tools[tool].dailyCap;
      }
    }
    const binding: BridgeBinding = {
      ...report, tools,
      machineName: takeEdits ? report.machineName : prior!.machineName,
      profileName: takeEdits ? report.profileName : prior!.profileName,
      shared: takeEdits ? report.shared : prior!.shared,
      editedAt: takeEdits ? report.editedAt : prior!.editedAt,
      editedBy: takeEdits ? displayUserName(me) : prior!.editedBy,
      disabled: prior?.disabled ?? false, disabledReason: prior?.disabledReason ?? '',
      archived: prior?.archived ?? false, lastSeenAt: now,
    };
    // Keep the original names/sites when present; they still mean the old plugin's last report.
    const record: BridgeDeviceRecord = {
      deviceName: previous?.deviceName ?? binding.machineName,
      chromeProfile: previous?.chromeProfile ?? binding.profileName,
      sites: previous?.sites ?? Object.fromEntries(BRIDGE_TOOLS.map(tool => [tool, {
        loggedIn: binding.tools[tool].login === 'ok', ...(binding.tools[tool].account ? { account: binding.tools[tool].account } : {}),
      }])),
      ...previous, ...binding, lastSeen: new Date(now).toISOString(),
    };
    const next = [record, ...list.filter(d => d.deviceId !== report.deviceId)];
    await writeBridgeDevices(tx, me.id, next);
    const active = next.filter(d => !d.archived).map(presentBinding);
    return {
      binding,
      mine: active.map(d => ({
        deviceId: d.deviceId, machineName: d.machineName, profileName: d.profileName, lastSeenAt: d.lastSeenAt,
        tools: Object.fromEntries(BRIDGE_TOOLS.map(tool => [tool, { accountKey: d.tools[tool].accountKey, login: d.tools[tool].login }])),
      })),
      possibleSameAs: active.filter(d => d.deviceId !== binding.deviceId && d.machineName === binding.machineName
        && d.profileName === binding.profileName && d.platform === binding.platform && now - d.lastSeenAt > BRIDGE_DEVICE_STALE_MS)
        .map(d => ({ deviceId: d.deviceId, machineName: d.machineName, profileName: d.profileName, lastSeenAt: d.lastSeenAt })),
    };
  });
}

export async function adoptBinding(me: Actor, input: unknown) {
  const body = object(input), deviceId = bindingDeviceId(body.deviceId), fromDeviceId = bindingDeviceId(body.fromDeviceId);
  if (deviceId === fromDeviceId) throw new BridgeDeviceError('不能接管当前设备自己', 400);
  return mutateBridgeDevices(async (stores, tx) => {
    assertBridgeDeviceOwner(stores, me.id, deviceId);
    assertBridgeDeviceOwner(stores, me.id, fromDeviceId);
    const list = stores.find(s => s.userId === me.id)?.devices || [];
    const current = list.find(d => d.deviceId === deviceId), old = list.find(d => d.deviceId === fromDeviceId);
    if (!current || !old) throw new BridgeDeviceError('只能接管本人已有设备', 404);
    if (old.archived || current.archived) throw new BridgeDeviceError('设备已归档，请刷新设备列表', 409);
    const before = presentBinding(old), binding = presentBinding(current);
    binding.machineName = before.machineName;
    binding.profileName = before.profileName;
    binding.shared = before.shared;
    for (const tool of BRIDGE_TOOLS) binding.tools[tool].accept = before.tools[tool].accept;
    if (before.tools.midjourney.dailyCap === undefined) delete binding.tools.midjourney.dailyCap;
    else binding.tools.midjourney.dailyCap = before.tools.midjourney.dailyCap;
    binding.editedAt = Date.now();
    binding.editedBy = displayUserName(me);
    await writeBridgeDevices(tx, me.id, list.map(d => d.deviceId === deviceId ? { ...d, ...binding }
      : d.deviceId === fromDeviceId ? { ...d, archived: true } : d));
    return binding;
  });
}

export async function listBindings(me: Actor, scope = 'mine', includeArchived = false): Promise<ListedBridgeBinding[]> {
  if (scope !== 'mine' && scope !== 'all') throw new BridgeDeviceError('scope 仅支持 mine 或 all', 400);
  if (scope === 'all' && me.role !== 'admin') throw new BridgeDeviceError('仅管理员可查看所有设备', 403);
  const rows = await prisma.userPreference.findMany({
    where: { key: BRIDGE_DEVICES_PREF_KEY, ...(scope === 'mine' ? { user_id: me.id } : {}) },
    select: { value_json: true, user: { select: { id: true, name: true, username: true, avatar_url: true } } },
  });
  const now = Date.now();
  return rows.flatMap(row => decodeBridgeDevices(row.value_json).filter(d => includeArchived || !d.archived).map(d => {
    const binding = presentBinding(d);
    return { ...binding, owner: { id: row.user.id, name: displayUserName(row.user), avatar_url: row.user.avatar_url },
      online: binding.lastSeenAt > 0 && now - binding.lastSeenAt < BRIDGE_DEVICE_STALE_MS };
  })).sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.deviceId.localeCompare(b.deviceId));
}

function parseBindingPatch(input: unknown, me: Actor): BindingPatch {
  const body = object(input);
  if (FACT_FIELDS.some(key => key in body) || 'sites' in body) throw new BridgeDeviceError('登录和账号状态只能由插件上报', 400);
  const adminFields = ['disabled', 'disabledReason', 'ownerUserId', 'archived'];
  if (me.role !== 'admin' && adminFields.some(key => key in body)) throw new BridgeDeviceError('仅管理员可以停用、归档或更改归属', 403);
  const patch: BindingPatch = {};
  for (const field of ['machineName', 'profileName'] as const) {
    if (field in body) {
      if (typeof body[field] !== 'string') throw new BridgeDeviceError('名称必须是文字', 400);
      patch[field] = text(body[field], 40);
    }
  }
  for (const field of ['shared', 'disabled', 'archived'] as const) if (field in body) patch[field] = boolean(body[field], field);
  if ('disabledReason' in body) patch.disabledReason = text(body.disabledReason, 200);
  if ('ownerUserId' in body) patch.ownerUserId = bindingDeviceId(body.ownerUserId);
  if ('tools' in body) {
    const rawTools = object(body.tools);
    const tools: NonNullable<EditablePatch['tools']> = {};
    for (const tool of BRIDGE_TOOLS) {
      if (!(tool in rawTools)) continue;
      const raw = object(rawTools[tool]);
      if (FACT_FIELDS.some(key => key in raw)) throw new BridgeDeviceError('登录和账号状态只能由插件上报', 400);
      const item: { accept?: boolean; dailyCap?: number } = {};
      if ('accept' in raw) item.accept = boolean(raw.accept, '允许接单');
      if (tool === 'midjourney' && 'dailyCap' in raw) item.dailyCap = dailyCap(raw.dailyCap);
      if (Object.keys(item).length) tools[tool] = item;
    }
    if (Object.keys(tools).length) patch.tools = tools;
  }
  if (!Object.keys(patch).length) throw new BridgeDeviceError('没有可修改的内容', 400);
  return patch;
}

export async function patchBinding(me: Actor, rawId: string, input: unknown) {
  const deviceId = bindingDeviceId(rawId), patch = parseBindingPatch(input, me);
  return mutateBridgeDevices(async (stores, tx) => {
    const matches = stores.filter(s => s.devices.some(d => d.deviceId === deviceId));
    if (!matches.length) throw new BridgeDeviceError('设备不存在', 404);
    if (matches.length !== 1) throw new BridgeDeviceError('设备归属重复，请联系管理员核对', 409);
    const source = matches[0];
    if (source.userId !== me.id && me.role !== 'admin') throw new BridgeDeviceError('只能修改本人设备', 403);
    const device = source.devices.find(d => d.deviceId === deviceId)!;
    const before = presentBinding(device), binding = presentBinding(device);
    const { tools, ownerUserId = source.userId, ...fields } = patch;
    Object.assign(binding, fields, { editedAt: Date.now(), editedBy: displayUserName(me) });
    for (const tool of BRIDGE_TOOLS) if (tools?.[tool]) Object.assign(binding.tools[tool], tools[tool]);
    const updated = { ...device, ...binding };
    if (ownerUserId !== source.userId) {
      const owner = await tx.user.findUnique({ where: { id: ownerUserId }, select: { status: true } });
      if (!owner || owner.status === 'deleted') throw new BridgeDeviceError('归属用户不存在', 400);
      const target = stores.find(s => s.userId === ownerUserId)?.devices || [];
      if (target.length >= MAX_BRIDGE_DEVICES) throw new BridgeDeviceError('目标用户已达到50条设备上限', 409);
      await writeBridgeDevices(tx, source.userId, source.devices.filter(d => d.deviceId !== deviceId));
      await writeBridgeDevices(tx, ownerUserId, [updated, ...target]);
    } else {
      await writeBridgeDevices(tx, source.userId, source.devices.map(d => d.deviceId === deviceId ? updated : d));
    }
    if (me.role === 'admin') await tx.operationLog.create({ data: {
      operator_id: me.id, action: 'bridge_binding_edit', target_type: 'bridge_device', target_id: deviceId,
      detail: JSON.stringify({ before: { ...before, ownerUserId: source.userId }, after: { ...binding, ownerUserId } }),
    } });
    return binding;
  });
}
