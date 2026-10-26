import { createHash } from 'node:crypto';
import { MAX_GENERATION_PROMPT_CHARS } from './prompt/limits';

export interface CanvasPromptMentions {
  version: 1;
  items: Array<{ token: string; referenceImageId: string }>;
}

export type CanvasPromptReferenceErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PROMPT_MENTIONS'
  | 'UNSUPPORTED_PROMPT_MENTIONS_VERSION'
  | 'DUPLICATE_PROMPT_MENTION_TOKEN'
  | 'INVALID_REFERENCE_IMAGE_ID'
  | 'TOO_MANY_PROMPT_MENTIONS'
  | 'TOO_MANY_REFERENCE_IMAGES'
  | 'DUPLICATE_REFERENCE_IMAGE_ID'
  | 'UNMAPPED_PROMPT_MENTION'
  | 'BOUND_REFERENCE_IMAGE_MISSING'
  | 'AMBIGUOUS_LEGACY_IMAGE_MENTION';

export class CanvasPromptReferenceError extends Error {
  constructor(
    public readonly code: CanvasPromptReferenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanvasPromptReferenceError';
  }
}

export interface CompileCanvasPromptReferencesInput {
  prompt: string;
  promptMentions?: unknown;
  referenceImageIds: readonly string[];
}

export interface CompiledCanvasPromptReferences {
  bound: boolean;
  prompt: string;
  referenceImageIds: string[];
  mapping: Record<string, string>;
  fingerprint: string;
}

const MAX_PROMPT_MENTION_ITEMS = 256;
const MAX_REFERENCE_IMAGE_IDS = 64;
const MAX_REFERENCE_IMAGE_ID_LENGTH = 100;
const REFERENCE_IMAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalTokenNumber(token: string): number | null {
  const match = /^@图([1-9]\d{0,15})$/.exec(token);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isReferenceImageId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REFERENCE_IMAGE_ID_LENGTH
    && REFERENCE_IMAGE_ID_PATTERN.test(value);
}

function invalidMentions(message = '图片引用绑定无效，请重新选择图片后再试。'): never {
  throw new CanvasPromptReferenceError('INVALID_PROMPT_MENTIONS', message);
}

export function parseCanvasPromptMentions(value: unknown): CanvasPromptMentions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalidMentions();
  if (value.version !== 1) {
    throw new CanvasPromptReferenceError(
      'UNSUPPORTED_PROMPT_MENTIONS_VERSION',
      '图片引用格式版本不受支持，请重新选择图片。',
    );
  }
  const rawItems = value.items;
  if (!Array.isArray(rawItems)) invalidMentions();
  if (rawItems.length > MAX_PROMPT_MENTION_ITEMS) {
    throw new CanvasPromptReferenceError(
      'TOO_MANY_PROMPT_MENTIONS',
      '图片引用数量过多，请整理后重试。',
    );
  }

  const seenTokens = new Set<string>();
  const items: CanvasPromptMentions['items'] = [];
  for (const rawItem of rawItems) {
    if (!isRecord(rawItem) || typeof rawItem.token !== 'string') {
      invalidMentions();
    }
    if (!isReferenceImageId(rawItem.referenceImageId)) {
      throw new CanvasPromptReferenceError('INVALID_REFERENCE_IMAGE_ID', '参考图片编号无效，请重新选择图片。');
    }
    if (canonicalTokenNumber(rawItem.token) === null) {
      invalidMentions('图片引用编号格式无效，请重新选择图片。');
    }
    if (seenTokens.has(rawItem.token)) {
      throw new CanvasPromptReferenceError(
        'DUPLICATE_PROMPT_MENTION_TOKEN',
        '图片引用编号重复，请重新选择图片。',
      );
    }
    seenTokens.add(rawItem.token);
    items.push({ token: rawItem.token, referenceImageId: rawItem.referenceImageId });
  }

  items.sort((left, right) => canonicalTokenNumber(left.token)! - canonicalTokenNumber(right.token)!);
  return { version: 1, items };
}

export function validateCanvasBoundReferenceImageIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CanvasPromptReferenceError('INVALID_INPUT', '本次参考图片清单格式不正确。');
  }
  if (value.length > MAX_REFERENCE_IMAGE_IDS) {
    throw new CanvasPromptReferenceError('TOO_MANY_REFERENCE_IMAGES', '本次参考图片数量过多，请重新选择。');
  }

  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const id of value) {
    if (!isReferenceImageId(id)) {
      throw new CanvasPromptReferenceError('INVALID_REFERENCE_IMAGE_ID', '参考图片编号无效，请重新选择图片。');
    }
    if (seenIds.has(id)) {
      throw new CanvasPromptReferenceError(
        'DUPLICATE_REFERENCE_IMAGE_ID',
        '本次图片列表存在重复项，请调整参考图片后重试。',
      );
    }
    seenIds.add(id);
    ids.push(id);
  }
  return ids;
}

function collectCompleteMentions(prompt: string): Array<{ token: string; start: number; end: number }> {
  const mentions: Array<{ token: string; start: number; end: number }> = [];
  for (const match of Array.from(prompt.matchAll(new RegExp('@图([0-9]+)(?![\\p{N}A-Za-z_])', 'gu')))) {
    const start = match.index ?? 0;
    mentions.push({ token: `@图${match[1]}`, start, end: start + match[0].length });
  }
  return mentions;
}

function hasLegacyBareImageMention(prompt: string): boolean {
  for (const match of Array.from(prompt.matchAll(new RegExp('(?:图片|图)\\s*([0-9]+)(?![\\p{N}A-Za-z_])', 'gu')))) {
    const start = match.index ?? 0;
    if (start > 0 && prompt[start - 1] === '@') continue;
    return true;
  }
  return false;
}

function createFingerprint(
  prompt: string,
  mentions: CanvasPromptMentions | undefined,
  referenceImageIds: readonly string[],
): string {
  const canonicalBindings = mentions?.items.map(({ token, referenceImageId }) => [token, referenceImageId]) ?? [];
  const payload = JSON.stringify([
    'canvas-prompt-references/v1',
    prompt,
    canonicalBindings,
    referenceImageIds,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function compileCanvasPromptReferences(
  input: CompileCanvasPromptReferencesInput,
): CompiledCanvasPromptReferences {
  if (!isRecord(input) || typeof input.prompt !== 'string') {
    throw new CanvasPromptReferenceError('INVALID_INPUT', '提示词或参考图片清单格式不正确。');
  }
  if (input.prompt.length > MAX_GENERATION_PROMPT_CHARS) {
    throw new CanvasPromptReferenceError('INVALID_INPUT', '提示词过长，请精简后重试。');
  }

  const prompt = input.prompt;
  const referenceImageIds = validateCanvasBoundReferenceImageIds(input.referenceImageIds);
  const mentions = parseCanvasPromptMentions(input.promptMentions);
  const occurrences = collectCompleteMentions(prompt);

  if (!mentions) {
    return {
      bound: false,
      prompt,
      referenceImageIds,
      mapping: {},
      fingerprint: createFingerprint(prompt, undefined, referenceImageIds),
    };
  }

  const bindingByToken = new Map(mentions.items.map(({ token, referenceImageId }) => [token, referenceImageId]));
  for (const occurrence of occurrences) {
    if (!bindingByToken.has(occurrence.token)) {
      throw new CanvasPromptReferenceError(
        'UNMAPPED_PROMPT_MENTION',
        `提示词中的 ${occurrence.token} 尚未绑定图片，请重新选择该图片。`,
      );
    }
  }

  if (occurrences.length === 0) {
    return {
      bound: false,
      prompt,
      referenceImageIds,
      mapping: {},
      fingerprint: createFingerprint(prompt, mentions, referenceImageIds),
    };
  }

  if (hasLegacyBareImageMention(prompt)) {
    throw new CanvasPromptReferenceError(
      'AMBIGUOUS_LEGACY_IMAGE_MENTION',
      '提示词同时含有已绑定的 @图片和旧式图号，无法确认对应关系，请重新选择图片。',
    );
  }

  const indexByReferenceId = new Map(referenceImageIds.map((id, index) => [id, index]));
  const activeBindings = new Map<string, { referenceImageId: string; imageNumber: number }>();
  for (const occurrence of occurrences) {
    if (activeBindings.has(occurrence.token)) continue;
    const referenceImageId = bindingByToken.get(occurrence.token)!;
    const index = indexByReferenceId.get(referenceImageId);
    if (index === undefined) {
      throw new CanvasPromptReferenceError(
        'BOUND_REFERENCE_IMAGE_MISSING',
        `绑定的 ${occurrence.token} 图片已不在本次参考列表中，请重新选择。`,
      );
    }
    activeBindings.set(occurrence.token, { referenceImageId, imageNumber: index + 1 });
  }

  let compiledPrompt = prompt;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    const imageNumber = activeBindings.get(occurrence.token)!.imageNumber;
    compiledPrompt = `${compiledPrompt.slice(0, occurrence.start)}图${imageNumber}${compiledPrompt.slice(occurrence.end)}`;
  }

  const finalBindings = new Map<number, string>();
  for (const binding of Array.from(activeBindings.values())) {
    finalBindings.set(binding.imageNumber, binding.referenceImageId);
  }
  const mapping: Record<string, string> = {};
  for (const [imageNumber, referenceImageId] of Array.from(finalBindings.entries()).sort(([left], [right]) => left - right)) {
    mapping[`图${imageNumber}`] = referenceImageId;
  }

  return {
    bound: true,
    prompt: compiledPrompt,
    referenceImageIds,
    mapping,
    fingerprint: createFingerprint(prompt, mentions, referenceImageIds),
  };
}
