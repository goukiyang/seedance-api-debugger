import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerActionBar } from '../src/components/ComposerActionBar';
import { SEEDANCE_2_0_MODEL_ID, SEEDANCE_2_5_MODEL_ID } from '../src/lib/provider/seedance-models';
import { providerFailureUserMessage } from '../src/lib/provider/error-message';
import { translateError } from '../src/components/ErrorTranslator';

const raw = '[InvalidParameter.TaskTypeConstraint] The parameter ratio specified in the request is not valid. For first-frame or first-last-frame generation, the output ratio follows the first-frame image.';
for (const includeRefundText of [false, true]) {
  const translated = providerFailureUserMessage(raw, { includeRefundText });
  assert.equal(translated.code, 'FIRST_FRAME_RATIO_REQUIRED');
  assert.equal(translated.status, 400);
  assert.equal(translated.message.includes('已返还冻结点数'), includeRefundText);
  assert.equal(providerFailureUserMessage(translated.message).code, translated.code);
  assert.equal(translateError(translated.message)?.code, translated.code);
  assert.equal(translateError(`[${translated.code}] ${translated.message}`)?.code, translated.code);
}
assert.equal(translateError(raw)?.title, '画面比例需跟随首帧');
assert.equal(providerFailureUserMessage('[InvalidParameter.TaskTypeConstraint] unsupported duration').code, 'PROVIDER_CREATE_FAILED');
for (const selectedModel of [SEEDANCE_2_0_MODEL_ID, SEEDANCE_2_5_MODEL_ID]) {
  const html = renderToStaticMarkup(React.createElement(ComposerActionBar, {
    selectedModel, generationMode: 'first_last_frame', ratio: '16:9', duration: 4,
    resolution: '480p', canSubmit: false, isSubmitting: false, lockedRatio: true,
    onSubmit() {}, onModeChange() {}, onRatioChange() {}, onDurationChange() {}, onResolutionChange() {},
  }));
  assert.equal(html.includes('跟随首帧'), selectedModel === SEEDANCE_2_5_MODEL_ID);
}
const route = fs.readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
assert.ok(route.includes("const ratio = body.ratio || '16:9'"), 'Business ratio must remain immutable for video card locks');
assert.ok(route.includes('requested_ratio: ratio'), 'Provider snapshot must retain business ratio');
assert.ok(route.includes("ratio: seedanceRatioFollowsFirstFrame(selectedModel, generationMode) ? 'adaptive' : ratio"));
console.log('seedance frame ratio error smoke passed');
