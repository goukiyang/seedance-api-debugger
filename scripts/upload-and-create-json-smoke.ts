import assert from 'assert';
import fs from 'fs';
import path from 'path';

const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'src/app/api/assets/upload-and-create/route.ts'),
  'utf8',
);

assert.match(routeSource, /getSession\(\)/, 'upload-and-create must require a logged-in session before accepting files');
assert.match(routeSource, /jsonUploadAndCreateError/, 'upload-and-create must use one JSON error helper for every failure stage');
assert.match(routeSource, /withProviderTimeout/, 'upload-and-create must bound Seedance provider create latency');
assert.match(routeSource, /UPLOAD_AND_CREATE_PROVIDER_TIMEOUT_MS/, 'provider create timeout must be named and reviewable');
assert.match(routeSource, /FORM_PARSE_FAILED/, 'formData failures must return JSON with a stable error code');
assert.match(routeSource, /PUBLIC_UPLOAD_FAILED/, 'public storage failures must return JSON with a stable error code');
assert.match(routeSource, /PROVIDER_CREATE_FAILED/, 'provider create failures must return JSON with a stable error code');
assert.match(routeSource, /PROVIDER_CREATE_TIMEOUT/, 'provider create timeouts must return JSON with a stable error code');
assert.match(routeSource, /DB_CREATE_FAILED/, 'database registration failures must return JSON with a stable error code');
assert.match(
  routeSource,
  /safeUploadAndCreateHttpStatus/,
  'upload-and-create must avoid CDN-replaced 5xx HTML pages for application-level JSON errors',
);
assert.match(
  routeSource,
  /status >= 500\) return 424/,
  'upload-and-create application-level 5xx failures must be downgraded to a JSON-preserving status code',
);
assert.match(routeSource, /safeLogDetails/, 'upload-and-create failure logs must pass through a safe detail filter');
assert.match(routeSource, /result\.publicUrl = value \? '\[redacted-url\]' : null/, 'upload-and-create logs must not print full public asset URLs');
assert.match(routeSource, /result\.storageKeyPresent = Boolean\(value\)/, 'upload-and-create logs must not print full storage keys');
assert.doesNotMatch(
  routeSource,
  /console\.error\('\[UploadAndCreate\] Error:', error\)/,
  'route must not only rely on a catch-all error log for stage diagnosis',
);
assert.match(
  routeSource,
  /reused:\s*true[\s\S]+message:\s*`已检测到相同/,
  'duplicate file uploads must return success with reused=true',
);
assert.match(
  routeSource,
  /NextResponse\.json\(\s*\{[\s\S]*success:\s*false[\s\S]*(?:code\s*:|code\s*,)/,
  'failure responses must be JSON objects with success=false and a stable code field',
);

console.log('upload-and-create-json-smoke: ok');
