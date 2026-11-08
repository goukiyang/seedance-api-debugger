/** Only a rejected directory read can be restarted; mutations never use this helper. */
export async function readStudioDirectory<T>(cursor: string | undefined, read: (cursor?: string) => Promise<T>, onRestart: () => void) {
  try { return { page: await read(cursor), restarted: false }; }
  catch (error) {
    const failure = error as { status?: number; code?: string };
    if (failure?.status !== 409 || failure.code !== 'studio-directory-changed') throw error;
    onRestart();
    return { page: await read(), restarted: true };
  }
}
