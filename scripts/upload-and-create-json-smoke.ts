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
assert.match(routeSource, /CURRENT_UPLOAD_ENTRYPOINT_UPGRADED/, 'old multipart callers must receive a stable JSON error code');
assert.match(routeSource, /request\.json\(\)/, 'upload-and-create must read a JSON body');
assert.match(routeSource, /assetId/, 'upload-and-create must accept an existing uploaded Asset by id');
assert.match(routeSource, /ASSET_LOOKUP_FAILED/, 'asset lookup failures must return JSON with a stable error code');
assert.match(routeSource, /ASSET_URL_NOT_PUBLIC/, 'non-public asset URLs must return JSON with a stable error code');
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
assert.doesNotMatch(
  routeSource,
  /request\.formData\(\)/,
  'upload-and-create must not read multipart bodies after upload is unified through Asset',
);
assert.doesNotMatch(
  routeSource,
  /uploadPublicAsset\(/,
  'upload-and-create must not upload files itself; it must reuse the existing Asset URL',
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

const panelSource = fs.readFileSync(
  path.join(process.cwd(), 'src/components/SeedanceAssetPanel.tsx'),
  'utf8',
);
assert.match(panelSource, /uploadFileAsAsset\(uploadFile,\s*\{/, 'Seedance asset panel must upload through the unified Asset helper first');
assert.match(panelSource, /assetId:\s*asset\.id/, 'Seedance asset panel must send assetId to upload-and-create');
assert.doesNotMatch(panelSource, /new FormData\(\)/, 'Seedance asset panel must not send multipart to upload-and-create');

console.log('upload-and-create-json-smoke: ok');
