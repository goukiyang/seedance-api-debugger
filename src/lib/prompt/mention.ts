export interface PromptMentionRange {
  start: number;
  end: number;
  query: string;
}

const IMAGE_MENTION_RE = /@?(?:图片|图)\s*(\d+)/g;
const MENTION_BOUNDARY_RE = /[\s([{"'，。！？；：、（【《“‘]/;
const COMPLETE_IMAGE_MENTION_RE = /^(?:图片|图)\s*\d+$/;

export function parseImageMentions(value: string): number[] {
  const matches = Array.from(value.matchAll(IMAGE_MENTION_RE));
  const numbers = matches
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

export function detectMentionAtCursor(value: string, cursor: number | null | undefined): PromptMentionRange | null {
  if (cursor === null || cursor === undefined) return null;
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, safeCursor);
  const match = beforeCursor.match(/@([^\s@]*)$/);
  if (!match) return null;

  const query = match[1] ?? '';
  if (COMPLETE_IMAGE_MENTION_RE.test(query)) return null;

  const start = beforeCursor.length - query.length - 1;
  const previous = start > 0 ? value[start - 1] : '';
  if (previous && !MENTION_BOUNDARY_RE.test(previous)) return null;

  return {
    start,
    end: safeCursor,
    query,
  };
}

export function replaceMentionAtCursor(
  value: string,
  cursor: number,
  insertText: string,
): { next: string; cursor: number } {
  const range = detectMentionAtCursor(value, cursor);
  if (!range) {
    const next = `${value.slice(0, cursor)}${insertText}${value.slice(cursor)}`;
    return { next, cursor: cursor + insertText.length };
  }
  return replaceMentionRange(value, range, insertText);
}

export function replaceMentionRange(
  value: string,
  range: PromptMentionRange,
  insertText: string,
): { next: string; cursor: number } {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const needsTrailingSpace = insertText.length > 0 && after.length > 0 && !/^\s/.test(after) && !/\s$/.test(insertText);
  const finalInsert = needsTrailingSpace ? `${insertText} ` : insertText;
  return {
    next: `${before}${finalInsert}${after}`,
    cursor: before.length + finalInsert.length,
  };
}
