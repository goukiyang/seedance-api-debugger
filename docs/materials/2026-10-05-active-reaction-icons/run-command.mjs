import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const [name, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name || '') || !command) throw Error('Expected unique log name and command');
const log = path.join(directory, `${name}.log`);
const fd = fs.openSync(log, 'wx');
const startedAt = new Date().toISOString();
const child = spawn(command, args, { stdio: ['ignore', fd, fd] });
child.on('error', error => fs.writeSync(fd, String(error)));
child.on('close', (code, signal) => {
  fs.closeSync(fd);
  const result = { command, args, cwd: process.cwd(), startedAt, finishedAt: new Date().toISOString(), exitCode: code, signal, log };
  fs.writeFileSync(path.join(directory, `${name}.command.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(fs.readFileSync(log, 'utf8').slice(-3500));
  process.exitCode = code ?? 1;
});
