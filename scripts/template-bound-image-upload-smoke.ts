import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pickerSource = readFileSync('src/components/templates/TemplateBoundImagePicker.tsx', 'utf8');
const cssSource = readFileSync('src/app/globals.css', 'utf8');

assert.match(pickerSource, /template-bound-image-file-input/);
assert.match(pickerSource, /template-bound-image-upload/);
assert.match(pickerSource, /UploadProgressIndicator/);
assert.match(pickerSource, /template-bound-image-progress/);
assert.match(pickerSource, /上传并绑定图片/);
assert.match(pickerSource, /uploadFileToHistory\(file, \{/);
assert.match(pickerSource, /onProgress: \(progress\) => setUploadProgress/);
assert.match(pickerSource, /source: 'upload_history'/);
assert.match(pickerSource, /onSelect\(nextImage\)/);
assert.match(pickerSource, /setTab\('history'\)/);

assert.match(cssSource, /\.template-bound-image-file-input\s*\{/);
assert.match(cssSource, /\.template-bound-image-progress,/);
assert.match(cssSource, /\.template-bound-image-footer-actions\s*\{/);
assert.match(cssSource, /\.template-bound-image-footer \.template-bound-image-upload\s*\{/);

console.log('template-bound-image-upload-smoke passed');
