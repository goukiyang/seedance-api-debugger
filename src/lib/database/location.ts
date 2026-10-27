import path from 'node:path';
export function sqliteDatabaseFile(input: string) {
  if (!input.startsWith('file:')) throw new Error('sqlite_file_url_required');
  const name = input.slice(5).split('?')[0];
  if (!name || name.includes('\0') || name === ':memory:' || name.startsWith('file:')) throw new Error('sqlite_file_url_required');
  return path.isAbsolute(name) ? name : path.resolve(process.cwd(), 'prisma', name);
}
