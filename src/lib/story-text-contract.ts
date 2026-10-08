export const STORY_TEXT_PROVIDER_WAIT_MS = 180_000;
export const STORY_TEXT_CLIENT_WAIT_MS = 200_000;

export function canvasTextWaitMs(kind: string, stage: unknown) {
  return kind === 'script' && (stage === 'script' || stage === 'storyboard')
    ? STORY_TEXT_PROVIDER_WAIT_MS : 60_000;
}
