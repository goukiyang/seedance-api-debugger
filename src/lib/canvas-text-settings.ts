import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';

const LEGACY_KEY = 'ultimate_canvas_text_context_v1';
const RULES_KEY = 'ultimate_canvas_text_rules_v2';
export const CANVAS_RULE_PURPOSES = ['basic', 'text', 'prompt', 'storyboard'] as const;
export type CanvasRulePurpose = typeof CANVAS_RULE_PURPOSES[number];
export type CanvasRule = {
  id: string; name: string; purpose: CanvasRulePurpose; body: string; enabled: boolean;
  order: number; revision: number; deletedAt: string | null; updatedAt: string | null;
};
type Legacy = { context: string; revision: number; token: string };
type Snapshot = { revision: number; updatedAt: string | null; rules: CanvasRule[]; legacyBaseline: Legacy };
type Library = Snapshot & { schemaVersion: 2; legacyOriginal: Legacy; history: Snapshot[] };
export type CanvasRuleState = Library & {
  expected: { libraryToken: string; legacyToken: string; libraryRevision: number; legacyRevision: number };
  persisted: boolean; legacyChanged: boolean; legacyCurrent: Legacy;
};
const token = (raw: string | null) => createHash('sha256').update(raw === null ? 'absent' : `present:${raw}`).digest('hex');
const invalid = () => new AuthError('规则库暂时无法读取，请保留草稿并重试', 503);
const conflict = () => new AuthError('规则已被其他窗口修改，草稿仍保留；请读取最新版对照后合并', 409);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const date = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)));

function decodeLegacy(raw: string | null): Legacy {
  if (raw === null) return { context: '', revision: 0, token: token(null) };
  try {
    const value = JSON.parse(raw);
    if (typeof value.context !== 'string' || value.context.length > 4000 || !integer(value.revision)) throw invalid();
    return { context: value.context, revision: value.revision, token: token(raw) };
  } catch { throw invalid(); }
}

function assertEffectiveLength(rules: CanvasRule[], nodeRules: string) {
  if (rules.reduce((total, rule) => total + rule.body.length, nodeRules.length) > 4000) {
    throw new AuthError('本次适用的通用与节点规则合计最多4000字，请调整后重试', 400);
  }
}

function parseRules(value: unknown): CanvasRule[] {
  if (!Array.isArray(value) || value.length > 40) throw new AuthError('规则最多40条（含已删除），请检查后保存', 400);
  const ids = new Set<string>();
  let length = 0;
  const rules = value.map(rule => {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id)
      || ids.has(rule.id) || typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 80
      || !CANVAS_RULE_PURPOSES.includes(rule.purpose) || typeof rule.body !== 'string' || rule.body.length > 4000
      || typeof rule.enabled !== 'boolean' || !integer(rule.order) || rule.order > 10000
      || !integer(rule.revision) || !date(rule.deletedAt) || !date(rule.updatedAt)) {
      throw new AuthError('请检查规则名称、用途、正文和版本', 400);
    }
    if (rule.enabled && !rule.deletedAt && !rule.body.length) throw new AuthError('启用的规则需要正文', 400);
    ids.add(rule.id); length += rule.body.length;
    return { id: rule.id, name: rule.name, purpose: rule.purpose, body: rule.body, enabled: rule.enabled,
      order: rule.order, revision: rule.revision, deletedAt: rule.deletedAt, updatedAt: rule.updatedAt } as CanvasRule;
  });
  if (length > 40000) throw new AuthError('规则正文总存储最多40000字（含已删除）', 400);
  for (const purpose of ['text', 'prompt', 'storyboard'] as const) {
    assertEffectiveLength(rules.filter(rule => rule.enabled && !rule.deletedAt && (rule.purpose === 'basic' || rule.purpose === purpose)), '');
  }
  return rules;
}

function validLegacy(value: Legacy) {
  return value && typeof value.context === 'string' && value.context.length <= 4000 && integer(value.revision)
    && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token);
}

function decodeLibrary(raw: string): Library {
  try {
    if (Buffer.byteLength(raw, 'utf8') > 768 * 1024) throw invalid();
    const value = JSON.parse(raw) as Library;
    if (value.schemaVersion !== 2 || !integer(value.revision) || !date(value.updatedAt)
      || !validLegacy(value.legacyOriginal) || !validLegacy(value.legacyBaseline)
      || !Array.isArray(value.history) || value.history.length > 5) throw invalid();
    value.rules = parseRules(value.rules);
    value.history = value.history.map(snapshot => {
      if (!integer(snapshot.revision) || !date(snapshot.updatedAt) || !validLegacy(snapshot.legacyBaseline)) throw invalid();
      return { revision: snapshot.revision, updatedAt: snapshot.updatedAt, legacyBaseline: snapshot.legacyBaseline, rules: parseRules(snapshot.rules) };
    });
    return value;
  } catch { throw invalid(); }
}

function stateFromRows(legacyRaw: string | null, libraryRaw: string | null): CanvasRuleState {
  const legacy = decodeLegacy(legacyRaw);
  const library: Library = libraryRaw === null ? {
    schemaVersion: 2, revision: 0, updatedAt: null, legacyOriginal: legacy, legacyBaseline: legacy, history: [],
    rules: legacy.context ? [{ id: 'legacy-basic', name: '基础规则', purpose: 'basic', body: legacy.context,
      enabled: true, order: 0, revision: 1, deletedAt: null, updatedAt: null }] : [],
  } : decodeLibrary(libraryRaw);
  return { ...library, persisted: libraryRaw !== null, legacyCurrent: legacy,
    legacyChanged: library.legacyBaseline.token !== legacy.token,
    expected: { libraryToken: token(libraryRaw), legacyToken: legacy.token, libraryRevision: library.revision, legacyRevision: legacy.revision } };
}

export async function getCanvasTextSettings(): Promise<CanvasRuleState> {
  // A single read snapshot: opening the editor or generating never creates a setting.
  return prisma.$transaction(async tx => {
    const rows = await tx.platformSetting.findMany({ where: { key: { in: [LEGACY_KEY, RULES_KEY] } }, select: { key: true, value_json: true } });
    return stateFromRows(rows.find(row => row.key === LEGACY_KEY)?.value_json ?? null, rows.find(row => row.key === RULES_KEY)?.value_json ?? null);
  });
}

export function canvasRulePurpose(kind: string, mode: string, explicit?: unknown): Exclude<CanvasRulePurpose, 'basic'> {
  if (mode === 'video-prompt-enhance') return 'prompt';
  if (explicit === 'text' || explicit === 'prompt' || explicit === 'storyboard') return explicit;
  if (kind === 'script') return 'storyboard';
  return 'text';
}

export function compileCanvasTextRules(state: CanvasRuleState, purpose: Exclude<CanvasRulePurpose, 'basic'>, nodeRules: string) {
  const applicable = state.rules.filter(rule => rule.enabled && !rule.deletedAt && (rule.purpose === 'basic' || rule.purpose === purpose))
    .sort((a, b) => Number(b.purpose === 'basic') - Number(a.purpose === 'basic') || a.order - b.order || a.id.localeCompare(b.id));
  assertEffectiveLength(applicable, nodeRules);
  const trace = { schemaVersion: 2, libraryRevision: state.revision, libraryToken: state.expected.libraryToken,
    legacyRevision: state.legacyBaseline.revision, purpose,
    rules: applicable.map(rule => ({ id: rule.id, revision: rule.revision })),
    nodeRuleVersion: token(nodeRules), nodeRulesApplied: Boolean(nodeRules),
    basicCount: applicable.filter(rule => rule.purpose === 'basic').length,
    purposeCount: applicable.filter(rule => rule.purpose !== 'basic').length };
  return { trace, basicRules: applicable.filter(rule => rule.purpose === 'basic').map(rule => rule.body),
    purposeRules: applicable.filter(rule => rule.purpose !== 'basic').map(rule => rule.body), nodeRules,
    excluded: state.rules.filter(rule => !applicable.some(item => item.id === rule.id)).map(rule => ({ id: rule.id,
      reason: rule.deletedAt ? 'deleted' : !rule.enabled ? 'disabled' : 'purpose_mismatch' })) };
}

export async function saveCanvasTextSettings(userId: string, input: unknown): Promise<CanvasRuleState> {
  const body = input as { rules?: unknown; expected?: { libraryToken?: unknown; legacyToken?: unknown; libraryRevision?: unknown; legacyRevision?: unknown }; mergeLegacy?: unknown };
  if (!body || !body.expected || !/^[a-f0-9]{64}$/.test(String(body.expected.libraryToken))
    || !/^[a-f0-9]{64}$/.test(String(body.expected.legacyToken)) || !integer(body.expected.libraryRevision) || !integer(body.expected.legacyRevision)
    || (body.mergeLegacy !== undefined && typeof body.mergeLegacy !== 'boolean')) {
    throw new AuthError('规则版本无效，请保留草稿并重新读取', 400);
  }
  const requested = parseRules(body.rules);
  try {
    return await prisma.$transaction(async tx => {
      const rows = await tx.platformSetting.findMany({ where: { key: { in: [LEGACY_KEY, RULES_KEY] } } });
      const row = rows.find(item => item.key === RULES_KEY);
      const legacyRaw = rows.find(item => item.key === LEGACY_KEY)?.value_json ?? null;
      const current = stateFromRows(legacyRaw, row?.value_json ?? null);
      if (current.expected.libraryToken !== body.expected!.libraryToken || current.expected.legacyToken !== body.expected!.legacyToken
        || current.revision !== body.expected!.libraryRevision || current.legacyCurrent.revision !== body.expected!.legacyRevision) throw conflict();
      if (current.legacyChanged && (body.mergeLegacy !== true || !requested.some(rule => !rule.enabled && !rule.deletedAt && rule.body === current.legacyCurrent.context))) {
        throw new AuthError('旧版规则发生修改；请保留当前规则库并将旧版正文作为未启用规则明确合并', 409);
      }
      if (current.rules.some(rule => !requested.some(item => item.id === rule.id))) throw new AuthError('已有规则只能软删除，不能丢弃正文；请合并后保存', 409);
      const now = new Date().toISOString();
      const rules = requested.map(rule => {
        const before = current.rules.find(item => item.id === rule.id);
        if (before && rule.revision !== before.revision) throw conflict();
        const changed = !before || ['name', 'purpose', 'body', 'enabled', 'order', 'deletedAt'].some(key => before[key as keyof CanvasRule] !== rule[key as keyof CanvasRule]);
        return { ...rule, revision: before ? before.revision + Number(changed) : 1,
          updatedAt: changed ? now : before!.updatedAt, deletedAt: rule.deletedAt ? (before?.deletedAt || now) : null };
      });
      const previous: Snapshot = { revision: current.revision, updatedAt: current.updatedAt, rules: current.rules, legacyBaseline: current.legacyBaseline };
      const history = [...current.history, previous].slice(-5);
      while (history.length && Buffer.byteLength(JSON.stringify(history), 'utf8') > 384 * 1024) history.shift();
      const next: Library = { schemaVersion: 2, revision: current.revision + 1, updatedAt: now, rules,
        legacyOriginal: current.legacyOriginal, legacyBaseline: current.legacyCurrent, history };
      const data = { value_json: JSON.stringify(next), updated_by: userId };
      if (Buffer.byteLength(data.value_json, 'utf8') > 768 * 1024) throw new AuthError('规则版本存档过大，请减少正文', 400);
      // v1 is never written. The transaction read lock plus exact v2 CAS protects first-save and rollback edits.
      if (row) {
        const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data });
        if (changed.count !== 1) throw conflict();
      } else await tx.platformSetting.create({ data: { key: RULES_KEY, ...data } });
      return stateFromRows(legacyRaw, data.value_json);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['P2002', 'P2028', 'P2034'].includes(String(error.code))) throw conflict();
    throw error;
  }
}
