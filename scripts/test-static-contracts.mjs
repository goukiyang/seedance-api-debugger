import assert from 'node:assert/strict';
import { inspectSource } from './check-static-core.mjs';

assert.equal(inspectSource('src/app/api/fixture/route.ts', "import sharp from 'sharp';").length, 1);
assert.equal(inspectSource('scripts/fixture.ts', "const decoder = require('sharp');").length, 1);
assert.equal(inspectSource('src/lib/fixture.ts', "const decoder = await import('sharp');").length, 1);
assert.equal(inspectSource('src/lib/fixture.ts', "import sharp from './media/sharp';").length, 0);
assert.equal(inspectSource('src/lib/fixture.ts', "import type { Metadata } from 'sharp';").length, 0);
assert.equal(inspectSource('src/lib/fixture.ts', "// import sharp from 'sharp';\nconst note = \"require('sharp')\";").length, 0);
console.log('PASS real parser rejects a direct-decoder mutation without rejecting comments');
