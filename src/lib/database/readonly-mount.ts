import path from 'node:path';
const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
export function assertReadonlyDatabaseMount(file: string, mountInfo: string, resolvedSidecars: string[] = []) {
  const mounts = mountInfo.trim().split('\n').map(line => {
    const fields = line.split(' ');
    if (fields.length < 10 || !line.includes(' - ')) throw new Error('readonly_mount_unknown');
    return { point: decode(fields[4]), readonly: fields[5].split(',').includes('ro') };
  }).sort((a, b) => b.point.length - a.point.length);
  for (const target of [file, ...['-wal', '-shm', '-journal'].map(suffix => file + suffix), ...resolvedSidecars]) {
    if (!path.isAbsolute(target)) throw new Error('readonly_mount_unknown');
    const mount = mounts.find(item => item.point === '/' || target === item.point || target.startsWith(item.point + '/'));
    if (!mount?.readonly) throw new Error('readonly_database_mount_required');
  }
}
