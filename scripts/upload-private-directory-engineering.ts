import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolvePrivateUploadDirectory,
  VerifiedUploadError,
  type PrivateUploadGroupProbeRequest,
  type PrivateUploadDirectoryRuntime,
} from '@/lib/assets/verified-upload';

type Filesystem = PrivateUploadDirectoryRuntime['filesystem'];
type GroupProbe = PrivateUploadDirectoryRuntime['probeTrustedGroupWritableParent'];
type Scenario = {
  root: string;
  cwd: string;
  storage: string;
  projectRoot: string;
  canonical: string;
  systemRoot: string;
  runtimeUid: number;
  runtimeGid: number;
};
type Metadata = {
  capacityBytes?: number;
  dataDevice?: number;
  device?: Map<string, number>;
  deniedAccess?: string;
  mode?: Map<string, number>;
  uid?: Map<string, number>;
  gid?: Map<string, number>;
};
type ProbeResult = {
  schema: string;
  directory: string;
  runtimeUid: number;
  runtimeGid: number;
  primaryGroupUids: number[];
  explicitMemberUids: number[];
  passwdSources: string[];
  groupSources: string[];
  accessAclAbsent: boolean;
  defaultAclAbsent: boolean;
};

const checks: string[] = [];
const forbiddenCalls = { network: 0, productionWrites: 0 };
const DATA_DEVICE = 2202;
const SYSTEM_DEVICE = 1101;
const RUNTIME_UID = 4242;
const RUNTIME_GID = 4343;
const HIGH_CAPACITY = 8 * 1024 ** 3;

function within(root: string, entry: string) {
  const relative = path.relative(root, entry);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertFixturePath(scenario: Scenario, entry: string) {
  assert.ok(within(scenario.root, entry), `fixture write escaped its temporary root: ${entry}`);
}
async function mkdir(scenario: Scenario, directory: string, mode = 0o755) {
  assertFixturePath(scenario, directory);
  await fs.mkdir(directory, { recursive: true, mode });
  await fs.chmod(directory, mode);
}
async function symlink(scenario: Scenario, target: string, link: string) {
  assertFixturePath(scenario, target);
  assertFixturePath(scenario, link);
  await fs.symlink(target, link);
}
function decorateStat<T extends Awaited<ReturnType<typeof fs.lstat>>>(stat: T, entry: string, scenario: Scenario, metadata: Metadata): T {
  const normalized = path.resolve(entry);
  const uid = metadata.uid?.get(normalized) ?? (normalized === scenario.systemRoot || normalized === path.dirname(scenario.projectRoot) ? 0 : scenario.runtimeUid);
  const gid = metadata.gid?.get(normalized) ?? (normalized === scenario.systemRoot || normalized === path.dirname(scenario.projectRoot) ? 0 : scenario.runtimeGid);
  const device = metadata.device?.get(normalized)
    ?? (normalized === scenario.systemRoot ? SYSTEM_DEVICE : (metadata.dataDevice ?? DATA_DEVICE));
  const permissions = metadata.mode?.get(normalized);
  return new Proxy(stat, {
    get(target, property, receiver) {
      if (property === 'uid') return uid;
      if (property === 'gid') return gid;
      if (property === 'dev') return device;
      if (property === 'mode' && permissions !== undefined && !target.isSymbolicLink()) return (Number(target.mode) & ~0o7777) | permissions;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function filesystem(scenario: Scenario, metadata: Metadata = {}): Filesystem {
  return {
    access: async (entry: string, mode?: number) => {
      if (path.resolve(entry) === metadata.deniedAccess) {
        const error = new Error('synthetic access denial') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return fs.access(entry, mode);
    },
    lstat: async (entry: string) => decorateStat(await fs.lstat(entry), entry, scenario, metadata),
    mkdir: (entry: string, options?: Parameters<typeof fs.mkdir>[1]) => fs.mkdir(entry, options),
    readlink: (entry: string) => fs.readlink(entry),
    realpath: (entry: string) => fs.realpath(entry),
    stat: async (entry: string) => decorateStat(await fs.stat(entry), entry, scenario, metadata),
    statfs: async (entry: string) => {
      await fs.stat(entry);
      const bsize = 4096;
      return { bsize, bavail: Math.floor((metadata.capacityBytes ?? HIGH_CAPACITY) / bsize) } as Awaited<ReturnType<typeof fs.statfs>>;
    },
  } as unknown as Filesystem;
}
async function baseScenario(root: string): Promise<Scenario> {
  const projectRoot = path.join(root, 'data', 'video-api-debugger');
  const cwd = path.join(projectRoot, 'managed-releases', 'candidate');
  const storage = path.join(projectRoot, 'releases', 'storage-source');
  const canonical = path.join(projectRoot, 'var-lib', 'storage', 'verified-uploads');
  const systemRoot = path.join(root, 'system-root');
  const scenario = { root, cwd, storage, projectRoot, canonical, systemRoot, runtimeUid: RUNTIME_UID, runtimeGid: RUNTIME_GID };
  await mkdir(scenario, systemRoot);
  await mkdir(scenario, cwd);
  await mkdir(scenario, storage, 0o700);
  await mkdir(scenario, path.dirname(canonical));
  await symlink(scenario, storage, path.join(cwd, 'storage'));
  return scenario;
}
function trustedProbe(overrides: Partial<ProbeResult> = {}): GroupProbe {
  return async (request: PrivateUploadGroupProbeRequest) => JSON.stringify({
    schema: 'video-api-debugger.upload-private-parent.v1',
    directory: request.directory,
    runtimeUid: request.runtimeUid,
    runtimeGid: request.runtimeGid,
    primaryGroupUids: [request.runtimeUid],
    explicitMemberUids: [],
    passwdSources: ['files', 'systemd'],
    groupSources: ['files', 'systemd'],
    accessAclAbsent: true,
    defaultAclAbsent: true,
    ...overrides,
  } satisfies ProbeResult);
}
function runtime(scenario: Scenario, metadata: Metadata = {}, probe: GroupProbe = trustedProbe()): PrivateUploadDirectoryRuntime {
  return {
    filesystem: filesystem(scenario, metadata),
    platform: 'linux',
    cwd: scenario.cwd,
    runtimeUid: scenario.runtimeUid,
    runtimeGid: scenario.runtimeGid,
    systemRoot: scenario.systemRoot,
    trustedProjectRoot: scenario.projectRoot,
    trustedCanonicalDirectory: scenario.canonical,
    probeTrustedGroupWritableParent: probe,
  };
}
async function expectAccepted(id: string, setup: (scenario: Scenario) => Promise<string>, metadata: Metadata = {},
  probe: GroupProbe = trustedProbe(), after?: () => void) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'upload-private-directory-')));
  try {
    const scenario = await baseScenario(root);
    const expected = await setup(scenario);
    assert.equal(await resolvePrivateUploadDirectory(runtime(scenario, metadata, probe)), expected);
    after?.();
    checks.push(id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function expectRejected(id: string, expectedCode: string, setup: (scenario: Scenario) => Promise<Metadata | void>,
  probe: GroupProbe = trustedProbe()) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'upload-private-directory-')));
  try {
    const scenario = await baseScenario(root);
    const metadata = await setup(scenario) || {};
    await assert.rejects(resolvePrivateUploadDirectory(runtime(scenario, metadata, probe)), error => {
      assert.ok(error instanceof VerifiedUploadError);
      assert.equal(error.code, expectedCode);
      return true;
    });
    checks.push(id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function main() {
  let directProbeCalls = 0;
  await expectAccepted('direct_private_directory_keeps_existing_behavior', async scenario => {
    const directory = path.join(scenario.storage, 'verified-uploads');
    await mkdir(scenario, directory, 0o700);
    return directory;
  }, {}, async () => {
    directProbeCalls += 1;
    throw new Error('ordinary private directory must not call compatibility probe');
  }, () => assert.equal(directProbeCalls, 0));
  await expectAccepted('current_storage_leaf_accepts_only_fixed_canonical_target', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return scenario.canonical;
  });
  let compatibilityProbeCalls = 0;
  const compatibilityProbe = trustedProbe();
  await expectAccepted('exact_0775_runtime_owned_canonical_parent_uses_trusted_probe', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return scenario.canonical;
  }, {}, async request => {
    compatibilityProbeCalls += 1;
    return compatibilityProbe(request);
  }, () => assert.equal(compatibilityProbeCalls, 1));
  await expectRejected('wrong_symlink_target_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    const rogue = path.join(scenario.projectRoot, 'var-lib', 'storage', 'rogue');
    await mkdir(scenario, rogue, 0o700);
    await symlink(scenario, rogue, path.join(scenario.storage, 'verified-uploads'));
  });
  await expectRejected('symlink_chain_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    const intermediate = path.join(scenario.projectRoot, 'var-lib', 'storage', 'intermediate');
    await symlink(scenario, scenario.canonical, intermediate);
    await symlink(scenario, intermediate, path.join(scenario.storage, 'verified-uploads'));
  });
  await expectRejected('canonical_final_symlink_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    const finalDirectory = path.join(scenario.projectRoot, 'var-lib', 'storage', 'final-directory');
    await mkdir(scenario, finalDirectory, 0o700);
    await symlink(scenario, finalDirectory, scenario.canonical);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  });
  await expectRejected('canonical_owner_must_match_runtime_uid', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { uid: new Map([[scenario.canonical, scenario.runtimeUid + 1]]) };
  });
  await expectRejected('canonical_mode_must_be_exactly_0700', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { mode: new Map([[scenario.canonical, 0o750]]) };
  });
  await expectRejected('canonical_special_mode_bits_are_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { mode: new Map([[scenario.canonical, 0o2700]]) };
  });
  await expectRejected('untrusted_writable_parent_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { mode: new Map([[path.join(scenario.projectRoot, 'var-lib'), 0o777]]) };
  });
  await expectRejected('canonical_0775_parent_gid_must_match_runtime', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { gid: new Map([[path.dirname(scenario.canonical), scenario.runtimeGid + 1]]) };
  });
  await expectRejected('group_probe_rejects_extra_primary_group_uid', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, trustedProbe({ primaryGroupUids: [RUNTIME_UID, RUNTIME_UID + 1] }));
  await expectRejected('group_probe_rejects_extra_explicit_member_uid', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, trustedProbe({ explicitMemberUids: [RUNTIME_UID + 1] }));
  await expectRejected('group_probe_rejects_access_acl', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, trustedProbe({ accessAclAbsent: false }));
  await expectRejected('group_probe_rejects_default_acl', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, trustedProbe({ defaultAclAbsent: false }));
  await expectRejected('group_probe_rejects_unknown_nss_source', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, trustedProbe({ passwdSources: ['files', 'unknown'] }));
  await expectRejected('group_probe_failure_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, async () => { throw new Error('synthetic probe failure'); });
  await expectRejected('group_probe_timeout_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, async () => {
    const error = new Error('synthetic probe timeout') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  });
  await expectRejected('group_probe_non_json_result_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, path.dirname(scenario.canonical), 0o775);
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
  }, async () => 'true');
  await expectRejected('system_device_storage_is_rejected', 'UPLOAD_DATA_MOUNT_REQUIRED', async scenario => {
    const directory = path.join(scenario.storage, 'verified-uploads');
    await mkdir(scenario, directory, 0o700);
    return { dataDevice: SYSTEM_DEVICE };
  });
  await expectRejected('canonical_cross_device_is_rejected', 'UPLOAD_DATA_MOUNT_REQUIRED', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { device: new Map([[scenario.canonical, DATA_DEVICE + 1]]) };
  });
  await expectRejected('low_capacity_is_rejected', 'UPLOAD_CAPACITY_GUARD', async scenario => {
    const directory = path.join(scenario.storage, 'verified-uploads');
    await mkdir(scenario, directory, 0o700);
    return { capacityBytes: 1024 ** 3 };
  });
  await expectRejected('canonical_access_denial_is_rejected', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await mkdir(scenario, scenario.canonical, 0o700);
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return { deniedAccess: scenario.canonical };
  });
  await expectRejected('missing_canonical_is_rejected_without_creation', 'UPLOAD_PRIVATE_DIRECTORY_INVALID', async scenario => {
    await symlink(scenario, scenario.canonical, path.join(scenario.storage, 'verified-uploads'));
    return undefined;
  });

  process.stdout.write(`UPLOAD_DIRECTORY_ENGINEERING=${JSON.stringify({ completed: true, checks, forbiddenCalls })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
