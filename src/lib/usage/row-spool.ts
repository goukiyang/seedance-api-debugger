import 'server-only';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type UsageRows<T> = { length: number; metrics: { maxBatchRows: number; peakMergeReaders: number };
  values: (offset?: number, limit?: number) => AsyncGenerator<T>; dispose: () => Promise<void> };

/** Per-request whitelist metadata only. These files are not a durable export job or accounting source. */
export async function usageRowSpool<T>(compare: (left: T, right: T) => number) {
  const root = await mkdtemp(path.join(tmpdir(), 'sd2-usage-')); await chmod(root, 0o700);
  const runs: string[] = []; let sequence = 0, count = 0, finalFile: string | null = null, disposed = false;
  const metrics = { maxBatchRows: 0, peakMergeReaders: 0 };
  const name = () => path.join(root, `${sequence++}.jsonl`);
  async function* read(file: string): AsyncGenerator<T> {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) yield JSON.parse(line) as T; }
    finally { lines.close(); stream.destroy(); }
  }
  const merge = async (files: string[]) => {
    metrics.peakMergeReaders = Math.max(metrics.peakMergeReaders, files.length);
    const target = name(), output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const readers = files.map(file => read(file)), heads: IteratorResult<T>[] = [];
    let writeError: Error | null = null;
    output.on('error', error => { writeError = error; });
    try {
      heads.push(...await Promise.all(readers.map(reader => reader.next())));
      for (;;) {
        let next = -1;
        for (let index = 0; index < heads.length; index++) if (!heads[index].done
          && (next < 0 || compare(heads[index].value!, heads[next].value!) < 0)) next = index;
        if (next < 0) break;
        if (writeError) throw writeError;
        if (!output.write(`${JSON.stringify(heads[next].value)}\n`)) await once(output, 'drain');
        heads[next] = await readers[next].next();
      }
      output.end(); await once(output, 'finish');
      if (writeError) throw writeError;
    } finally {
      output.destroy(); await Promise.all(readers.map(reader => reader.return(undefined)));
    }
    for (const file of files) await rm(file);
    return target;
  };
  return {
    async add(rows: T[]) {
      if (disposed || finalFile) throw new Error('usage_spool_closed');
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500).sort(compare), file = name();
        metrics.maxBatchRows = Math.max(metrics.maxBatchRows, batch.length);
        await writeFile(file, batch.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        runs.push(file); count += batch.length;
      }
    },
    async finish(): Promise<UsageRows<T>> {
      if (disposed) throw new Error('usage_spool_closed');
      while (runs.length > 1) {
        const current = runs.splice(0);
        for (let offset = 0; offset < current.length; offset += 16) runs.push(await merge(current.slice(offset, offset + 16)));
      }
      finalFile = runs[0] || null;
      return { length: count, metrics: { ...metrics }, values: async function* (offset = 0, limit = Number.MAX_SAFE_INTEGER) {
        if (disposed) throw new Error('usage_spool_closed');
        if (!finalFile || limit <= 0) return;
        let index = 0, delivered = 0;
        for await (const row of read(finalFile)) {
          if (index++ < offset) continue;
          yield row;
          if (++delivered >= limit) break;
        }
      }, dispose: async () => { if (!disposed) { disposed = true; await rm(root, { recursive: true, force: true }); } } };
    },
    async dispose() { if (!disposed) { disposed = true; await rm(root, { recursive: true, force: true }); } },
  };
}
