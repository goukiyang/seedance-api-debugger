import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { planImage25Activation, applyImage25Activation, readImageQualityOperation, type Image25ActivationPlan } from '../src/lib/integrations/image-quality-routing';

async function main() {
  const args = process.argv.slice(2), mode = args[0];
  if (!['--plan', '--apply', '--status'].includes(mode) || args.length !== (mode === '--plan' ? 9 : 5) || args[1] !== '--actor'
    || mode === '--plan' && (args[5] !== '--medium-channel' || args[7] !== '--max-channel')
    || args[3] !== (mode === '--apply' ? '--plan-file' : '--operation')) {
    throw new Error('Usage: --plan --actor <admin-id> --operation <original-id> --medium-channel <existing-id> --max-channel <existing-id>; --status --actor <admin-id> --operation <original-id>; --apply --actor <admin-id> --plan-file <private-json>');
  }
  const actorId = args[2];
  if (mode === '--plan') return planImage25Activation(actorId, args[4], { mediumChannelId: args[6], maxChannelId: args[8] });
  if (mode === '--status') {
    const result = await readImageQualityOperation(actorId, args[4]);
    return { operationId: args[4], found: Boolean(result), ...(result || { state: 'unknown' }) };
  }
  const file = path.resolve(args[4]), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077
    || stat.uid !== process.getuid?.() || stat.size > 262144 || stat.size === 0) throw new Error('Activation plan must be a private, owned regular JSON file');
  const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as Image25ActivationPlan;
  return applyImage25Activation(actorId, plan);
}
main().then(value => console.log(JSON.stringify(value))).catch(error => {
  const known = error instanceof Error && (error.name === 'ImageGenerationChannelError' || error.name === 'PricingAdminServiceError');
  console.error(JSON.stringify({ state: 'not_confirmed', error: known ? error.message : '激活未确认，请查询原操作；未自动重试，也不输出内部配置' }));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
