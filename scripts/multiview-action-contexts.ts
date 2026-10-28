import './server-runtime.cjs';
import { loadEnvConfig } from '@next/env';

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.DATABASE_URL?.startsWith('file:')) throw new Error('An explicit SQLite database is required');
  const [{ prisma }, contexts, musk, security, capability] = await Promise.all([
    import('@/lib/prisma'), import('@/lib/video/multiview-action-context.server'), import('@/lib/integrations/musk'), import('@/lib/security/private-prompts.server'), import('@/lib/video/multiview-action-capability'),
  ]);
  try {
    if (process.argv.includes('--initialize')) {
      const actorId = process.argv.find(value => value.startsWith('--actor-id='))?.slice('--actor-id='.length);
      if (!actorId) throw new Error('An existing administrator actor id is required');
      const actor = await prisma.user.findFirst({ where: { id: actorId, role: 'admin', status: 'active', account_type: 'internal' }, select: { id: true } });
      if (!actor) throw new Error('The deployment actor is not an active internal administrator');
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 131072) throw new Error('Private input is too large'); }
      const result = await contexts.initializeMultiviewActionContexts(JSON.parse(input), actor.id);
      process.stdout.write(JSON.stringify({ operation: 'initialize', result }) + '\n');
    } else if (!process.argv.includes('--status')) throw new Error('Choose --status or --initialize');
    const [format, sync, settings, enabled] = await Promise.all([
      contexts.readMultiviewActionContext('format'), contexts.readMultiviewActionContext('sync'), musk.getMuskApiSettings(),
      prisma.platformSetting.findUnique({ where: { key: 'TEMPLATE_STUDIO_TEXT_ENABLED' }, select: { value_json: true } }),
    ]);
    let textEnabled = false; try { textEnabled = enabled ? JSON.parse(enabled.value_json) === true : false; } catch { /* unavailable */ }
    let textDestinationAllowed = false;
    try { musk.assertPrivateMuskSend(settings, contexts.multiviewActionContextOrigins('format')); textDestinationAllowed = true; } catch { /* only report status */ }
    process.stdout.write(JSON.stringify({ format: { configured: Boolean(format.context.trim()), revision: format.revision }, sync: { configured: Boolean(sync.context.trim()), revision: sync.revision },
      textEnabled, textServiceReady: musk.isMuskApiReady(settings), defaultLlmModel: settings.default_model, textDestinationAllowed,
      privateState: security.privatePromptState(), acceptsNewActions: capability.MULTIVIEW_ACTION_ENABLED && process.env.MULTIVIEW_ACTION_ACCEPTING !== '0' }) + '\n');
  } finally { await prisma.$disconnect(); }
}
void main().catch(() => { process.stderr.write('Multiview action private configuration is unavailable; no private text was printed.\n'); process.exitCode = 1; });
