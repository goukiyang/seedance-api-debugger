import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildFeishuLocalCallbackUrl,
  parseFeishuLocalRelay,
} from '../src/lib/auth/feishu-local-relay';
import { isAllowedSd2CanvasPath } from './lib/ultimate-canvas-sd2-proxy.mjs';

const RELAY_PATH = '/__sd2-feishu-local-relay';
const LOCAL_NEXT = '/tools/ultimate-canvas/index.html?open=video-card';

function relayMarker(callback: string, next = LOCAL_NEXT) {
  return `${RELAY_PATH}?${new URLSearchParams({ callback, next })}`;
}

async function main() {
  for (const callbackUrl of [
    'http://127.0.0.1:1024/__sd2-feishu-callback',
    'http://localhost:4402/__sd2-feishu-callback',
    'http://[::1]:65535/__sd2-feishu-callback',
  ]) {
    assert.deepEqual(parseFeishuLocalRelay(relayMarker(callbackUrl)), {
      callbackUrl,
      next: LOCAL_NEXT,
    });
  }

  for (const callbackUrl of [
    'https://127.0.0.1:4402/__sd2-feishu-callback',
    'http://example.com:4402/__sd2-feishu-callback',
    'http://127.0.0.2:4402/__sd2-feishu-callback',
    'http://127.1:4402/__sd2-feishu-callback',
    'http://2130706433:4402/__sd2-feishu-callback',
    'http://localhost.:4402/__sd2-feishu-callback',
    'http://[0:0:0:0:0:0:0:1]:4402/__sd2-feishu-callback',
    'http://user@127.0.0.1:4402/__sd2-feishu-callback',
    'http://user:password@localhost:4402/__sd2-feishu-callback',
    'http://localhost:4402/__sd2-feishu-callback#fragment',
    'http://localhost:4402/wrong-path',
    'http://localhost/__sd2-feishu-callback',
    'http://localhost:1023/__sd2-feishu-callback',
    'http://localhost:65536/__sd2-feishu-callback',
    'http://localhost:port/__sd2-feishu-callback',
  ]) {
    assert.equal(parseFeishuLocalRelay(relayMarker(callbackUrl)), null, callbackUrl);
  }

  for (const marker of [
    `https://sd2.youdoodesign.com${relayMarker('http://127.0.0.1:4402/__sd2-feishu-callback')}`,
    '/wrong-marker?callback=http%3A%2F%2F127.0.0.1%3A4402%2F__sd2-feishu-callback&next=%2Fcanvas',
    relayMarker('http://127.0.0.1:4402/__sd2-feishu-callback', ''),
    relayMarker('http://127.0.0.1:4402/__sd2-feishu-callback', '//example.com/steal'),
    relayMarker('http://127.0.0.1:4402/__sd2-feishu-callback', '/\\example.com/steal'),
    relayMarker('http://127.0.0.1:4402/__sd2-feishu-callback', 'https://example.com/steal'),
    `${relayMarker('http://127.0.0.1:4402/__sd2-feishu-callback')}&callback=http%3A%2F%2Flocalhost%3A4403%2F__sd2-feishu-callback`,
  ]) {
    assert.equal(parseFeishuLocalRelay(marker), null, marker);
  }

  const relay = parseFeishuLocalRelay(relayMarker(
    'http://127.0.0.1:4402/__sd2-feishu-callback',
  ));
  assert(relay);
  assert.equal(
    buildFeishuLocalCallbackUrl(relay, { code: 'single-use-code' }),
    `http://127.0.0.1:4402/__sd2-feishu-callback?code=single-use-code&next=${encodeURIComponent(LOCAL_NEXT)}`,
  );
  assert.equal(
    buildFeishuLocalCallbackUrl(relay, { error: 'access_denied' }),
    `http://127.0.0.1:4402/__sd2-feishu-callback?error=access_denied&next=${encodeURIComponent(LOCAL_NEXT)}`,
  );

  assert.equal(isAllowedSd2CanvasPath('/api/auth/feishu/login-by-code'), true);
  for (const path of [
    '/api/auth/feishu/authorize',
    '/api/auth/feishu/callback',
    '/api/auth/feishu/login-by-code/extra',
    '/api/auth/feishu',
  ]) {
    assert.equal(isAllowedSd2CanvasPath(path), false, path);
  }

  const callbackSource = await readFile('src/app/api/auth/feishu/callback/route.ts', 'utf8');
  assert.match(callbackSource, /from ['"]@\/lib\/auth\/feishu-local-relay['"]/);
  const verifyStateIndex = callbackSource.indexOf('const storedState = verifyFeishuOAuthState');
  const returnedErrorIndex = callbackSource.indexOf('if (returnedError)');
  const parseRelayIndex = callbackSource.indexOf('parseFeishuLocalRelay(storedState.next)');
  const codeRelayIndex = callbackSource.indexOf('buildFeishuLocalCallbackUrl(relay, { code })');
  const codeExchangeIndex = callbackSource.indexOf('await loginWithFeishuCode(code');
  assert.ok(verifyStateIndex >= 0);
  assert.ok(returnedErrorIndex > verifyStateIndex, 'state must be verified before handling a relay cancellation');
  assert.ok(parseRelayIndex > verifyStateIndex, 'state must be verified before parsing the relay marker');
  assert.ok(codeRelayIndex > parseRelayIndex, 'the code relay must use a validated marker');
  assert.ok(codeExchangeIndex > codeRelayIndex, 'a valid relay must redirect before production code exchange');
  assert.match(callbackSource, /buildFeishuLocalCallbackUrl\(relay, \{ error: 'access_denied' \}\)/);

  console.log('ultimate-canvas-feishu-local-relay-smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
