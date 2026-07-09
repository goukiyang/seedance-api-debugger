import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

async function main() {
  const routeModuleUrl = pathToFileURL(`${process.cwd()}/src/app/api/assets/generate/route.ts`).href;
  const routeModule = await import(routeModuleUrl);
  assert.equal(typeof routeModule.POST, 'function');
  assert.equal(routeModule.runtime, 'nodejs');

  const source = fs.readFileSync(`${process.cwd()}/src/app/api/assets/generate/route.ts`, 'utf8');
  assert.ok(source.includes('const SEEDREAM_REFERENCE_IMAGE_LIMIT = 10'));
  assert.ok(source.includes('resolveImageGenerationReferenceInputs'));
  assert.ok(source.includes('path.relative(uploadsRoot, filePath)'));
  assert.ok(source.includes('!path.isAbsolute(relativePath)'));
  assert.ok(source.includes('referenceImages: referenceInputs'));
  assert.ok(source.includes('size: imageSize'));
  assert.ok(source.includes('reference_image_count: params.referenceImageCount'));
  assert.ok(source.includes('output_format: params.outputFormat'));
  assert.ok(source.includes('response_format: params.responseFormat'));
  assert.ok(source.includes('source_model_label'));
  assert.ok(source.includes('Seedream 5.0 Pro'));

  console.log('seedream-generate-route smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
