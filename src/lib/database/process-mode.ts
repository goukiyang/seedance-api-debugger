export type DatabaseProcessMode = 'writer' | 'readonly';
export function resolveDatabaseProcessMode(env: NodeJS.ProcessEnv): DatabaseProcessMode {
  if (env.SD2_DATABASE_MODE === 'writer' || env.SD2_DATABASE_MODE === 'readonly') return env.SD2_DATABASE_MODE;
  if (env.SD2_DATABASE_MODE !== undefined || env.NODE_ENV === 'production') throw new Error('database_process_mode_required');
  return 'writer';
}
// Captured before lazy clients or query dispatch. Runtime mode changes are not supported.
export const databaseProcessMode = resolveDatabaseProcessMode(process.env);
export function assertDatabaseWriterMode() {
  if (databaseProcessMode !== 'writer') throw new Error('readonly_process_writer_forbidden');
}
