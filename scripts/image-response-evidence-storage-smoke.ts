import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { recordStudioResponseEvidence, readStudioResponseEvidence } from '../src/lib/image-studio/response-evidence';
import { buildStudioResponseDiagnostics, collectStudioResponseOutputCandidates } from '../src/lib/image-studio/response-diagnostics';

async function main() {
  const previous = process.cwd();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-evidence-storage-'));
  try {
    const storage = path.join(temporary, 'storage');
    const persistent = path.join(temporary, 'persistent-evidence');
    await fs.mkdir(storage, { mode: 0o700 });
    await fs.mkdir(persistent, { mode: 0o700 });
    await fs.symlink(persistent, path.join(storage, 'studio-response-evidence'));
    process.chdir(temporary);
    const taskId = randomUUID(), batchId = randomUUID(), requestId = randomUUID(), channelId = `image-${randomUUID()}`;
    const fingerprint = 'a'.repeat(64), configRevision = randomUUID(), returnedAt = Date.now();
    const task = { id: taskId, owner_id: 'smoke-owner', batch_id: batchId, fingerprint,
      model: 'gemini-3-pro-image-preview', snapshot_json: JSON.stringify({ model: 'gemini-3-pro-image-preview', requestId,
        imageChannel: { channelId, configRevision } }) };
    const receipt = { taskId, ownerId: task.owner_id, batchId, fingerprint, localRequestId: requestId,
      channelId, configRevision, submittedAt: returnedAt - 1, returnedAt, status: 200 };
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const body = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] };
    const serialized = JSON.stringify(body);
    const diagnostic = buildStudioResponseDiagnostics(body, { httpStatus: 200, contentType: 'application/json',
      responseBytes: Buffer.byteLength(serialized), responseSha256: createHash('sha256').update(serialized).digest('hex'),
      bodyComplete: true, parseOutcome: 'valid_json' });
    assert.equal(await readStudioResponseEvidence(task, receipt), null);
    const written = await recordStudioResponseEvidence(task, receipt, diagnostic, collectStudioResponseOutputCandidates(body));
    assert.equal(written.candidates.length, 1);
    assert.equal(written.confirmedOutput, false);
    assert.equal(written.recoveryAuthorized, false);
    assert.deepEqual(await readStudioResponseEvidence(task, receipt), written);
    const taskDirectory = path.join(persistent, createHash('sha256').update(taskId).digest('hex'));
    const image = path.join(taskDirectory, 'candidate-0.image');
    assert.equal((await fs.stat(image)).mode & 0o777, 0o600);
    const movedImage = path.join(temporary, 'moved.image');
    await fs.rename(image, movedImage);
    await fs.symlink(movedImage, image);
    await assert.rejects(readStudioResponseEvidence(task, receipt), /studio_response_evidence_invalid/);
    await fs.unlink(image);
    await fs.rename(movedImage, image);
    const movedDirectory = path.join(temporary, 'moved-task');
    await fs.rename(taskDirectory, movedDirectory);
    await fs.symlink(movedDirectory, taskDirectory);
    await assert.rejects(readStudioResponseEvidence(task, receipt), /studio_response_evidence_invalid/);
    await fs.unlink(taskDirectory);
    await fs.rename(movedDirectory, taskDirectory);
    await fs.chmod(persistent, 0o755);
    await assert.rejects(readStudioResponseEvidence(task, receipt), /studio_response_evidence_invalid/);
    await fs.chmod(persistent, 0o700);
    assert.deepEqual(await readStudioResponseEvidence(task, receipt), written);
    console.log('PASS response evidence: persistent root alias, original bytes/identity, private permissions, task/file symlink rejection; no provider calls.');
  } finally {
    process.chdir(previous);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
