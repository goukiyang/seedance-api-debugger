import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/auth/session';
import { assertAnimationProjectAccess } from './access';
import { AnimationError, animationJson, requireRequestId, servePrivateAnimationFile } from './http';
import {
  animationRequestHash,
  createImportedAnimationDocument,
  getAnimationExportForDocument,
  getAnimationFileForDocument,
  getIdempotentResponse,
} from './repository';
import {
  ANIMATION_IMPORT_RESERVED_BYTES,
  ANIMATION_MAX_ARCHIVE_EXPANDED_BYTES,
  ANIMATION_MAX_DOCUMENT_FILES,
  ANIMATION_MAX_UPLOAD_BYTES,
  assertAnimationSourceInDirectory,
  createAnimationTempDirectory,
  inspectLocalAnimationFile,
  publishAnimationBlob,
  removeAnimationBlob,
  removeAnimationTempDirectory,
  reserveAnimationUpload,
  resolveAnimationBlob,
  streamRequestToFile,
  validateAnimationCandidate,
  validateAnimationZip,
  writeAnimationReconcileManifest,
} from './storage';
import type { AnimationDocumentView, AnimationFileInfo, AnimationLocalFile, AnimationSequence } from './types';
import { importAnimationBundle } from './media';
import { validateAnimationSequence } from './schema';

function remapSequenceFiles(sequence: AnimationSequence, ids: Map<string, string>): AnimationSequence {
  return {
    ...sequence,
    poses: sequence.poses.map((pose) => ({
      ...pose,
      file_id: ids.get(pose.file_id) || pose.file_id,
      ...(pose.mother_file_id ? { mother_file_id: ids.get(pose.mother_file_id) || pose.mother_file_id } : {}),
      source: { ...pose.source, ...(pose.source.video_file_id ? { video_file_id: ids.get(pose.source.video_file_id) || pose.source.video_file_id } : {}) },
    })),
    entries: sequence.entries.map((entry) => ({
      ...entry,
      ...(entry.reference_file_id ? { reference_file_id: ids.get(entry.reference_file_id) || entry.reference_file_id } : {}),
    })),
  };
}

function validateSequence(value: unknown) {
  try {
    return validateAnimationSequence(value);
  } catch (error) {
    if (error instanceof AnimationError) throw error;
    throw new AnimationError('动画包中的序列无效', 422, 'INVALID_SEQUENCE');
  }
}

export async function handleAnimationImportRequest(request: NextRequest, user: SessionUser) {
  const projectId = request.nextUrl.searchParams.get('project_id') || '';
  if (!projectId) throw new AnimationError('必须选择项目', 400, 'PROJECT_REQUIRED');
  await assertAnimationProjectAccess(user, projectId, 'create');
  const requestId = requireRequestId(request.headers.get('x-request-id'));
  const releaseCapacity = await reserveAnimationUpload(ANIMATION_IMPORT_RESERVED_BYTES);
  let tempDirectory: string | null = null;
  const publishedKeys: string[] = [];
  let manifestSaved = false;
  try {
    tempDirectory = await createAnimationTempDirectory();
    const archivePath = path.join(tempDirectory, 'source.zip');
    const uploaded = await streamRequestToFile(request, archivePath, ANIMATION_MAX_UPLOAD_BYTES);
    const operation = `import:${projectId}`;
    const requestHash = animationRequestHash({ sha256: uploaded.sha256 });
    const currentAccess = await assertAnimationProjectAccess(user, projectId, 'create');
    const cached = await getIdempotentResponse<{ success: true; document: AnimationDocumentView }>(user.id, requestId, operation, requestHash);
    if (cached) return animationJson({ ...cached, document: { ...cached.document, can_edit: currentAccess.canGenerate, can_manage: currentAccess.canManageAssets } });

    await validateAnimationZip(archivePath);
    const outputDirectory = path.join(tempDirectory, 'unpacked');
    const imported = await importAnimationBundle(archivePath, outputDirectory);
    const sequence = validateSequence(imported.sequence);
    if (!Array.isArray(imported.files) || imported.files.length + 1 > ANIMATION_MAX_DOCUMENT_FILES) {
      throw new AnimationError('动画包中的文件数量超过限制', 413, 'ARCHIVE_FILE_LIMIT');
    }

    const files: Array<AnimationFileInfo & { blob_key: string }> = [];
    const originalFileIds = new Map<string, string>();
    const byHash = new Map<string, AnimationFileInfo & { blob_key: string }>();
    let expandedBytes = 0;
    for (const localFile of imported.files as AnimationLocalFile[]) {
      const localPath = await assertAnimationSourceInDirectory(localFile.path, outputDirectory);
      const role = localFile.role;
      const name = localFile.name;
      let dimensions: { width: number; height: number };
      if (role === 'video') {
        dimensions = await validateAnimationCandidate(localPath, 'video', name);
      } else {
        dimensions = await validateAnimationCandidate(localPath, 'candidate', name);
      }
      const inspected = await inspectLocalAnimationFile(localPath, name, role, dimensions);
      if (inspected.bytes > ANIMATION_MAX_UPLOAD_BYTES) throw new AnimationError('动画包内单个文件超过大小限制', 413, 'ARCHIVE_FILE_TOO_LARGE');
      expandedBytes += inspected.bytes;
      if (expandedBytes > ANIMATION_MAX_ARCHIVE_EXPANDED_BYTES) throw new AnimationError('动画包展开后超过容量限制', 413, 'ARCHIVE_TOO_LARGE');
      const dedupeKey = `${role}:${inspected.sha256}`;
      let persisted = byHash.get(dedupeKey);
      if (!persisted) {
        const published = await publishAnimationBlob(localPath, inspected.sha256);
        publishedKeys.push(published.blob_key);
        persisted = { ...inspected, id: randomUUID(), blob_key: published.blob_key };
        byHash.set(dedupeKey, persisted);
        files.push(persisted);
      }
      originalFileIds.set(localFile.id, persisted.id);
    }

    const sourceZipInfo: AnimationFileInfo = {
      id: randomUUID(), name: 'source-animation.zip', role: 'reference', mime: 'application/zip',
      bytes: uploaded.bytes, sha256: uploaded.sha256, width: null, height: null,
    };
    const sourceZipBlob = await publishAnimationBlob(archivePath, uploaded.sha256);
    publishedKeys.push(sourceZipBlob.blob_key);
    files.unshift({ ...sourceZipInfo, blob_key: sourceZipBlob.blob_key });
    const remappedSequence = remapSequenceFiles(sequence, originalFileIds);
    const documentId = randomUUID();
    const title = remappedSequence.title?.trim() || '未命名动画';
    try {
      const response = await createImportedAnimationDocument({
        user,
        documentId,
        projectId,
        requestId,
        requestHash,
        sequence: remappedSequence,
        title,
        files,
      });
      if (response.document.id === documentId) publishedKeys.length = 0;
      return animationJson(response);
    } catch (error) {
      if (error instanceof AnimationError) throw error;
      const reconcileId = randomUUID();
      try {
        await writeAnimationReconcileManifest(reconcileId, {
          version: 1,
          kind: 'document_import',
          document_id: documentId,
          project_id: projectId,
          actor_user_id: user.id,
          request_id: requestId,
          operation,
          request_hash: requestHash,
          title,
          sequence: remappedSequence,
          files,
        });
        manifestSaved = true;
      } catch {
        throw new AnimationError('动画已校验，登记暂未完成；请使用相同请求编号重试', 503, 'RECONCILE_PENDING');
      }
      throw new AnimationError('动画已校验，正在等待登记恢复；请使用相同请求编号重试', 503, 'RECONCILE_PENDING');
    }
  } finally {
    if (!manifestSaved) for (const blobKey of publishedKeys) await removeAnimationBlob(blobKey);
    if (tempDirectory) await removeAnimationTempDirectory(tempDirectory);
    await releaseCapacity();
  }
}

export async function serveAnimationFileRequest(request: NextRequest, fileId: string, head: boolean, user: SessionUser) {
  const documentId = request.nextUrl.searchParams.get('document_id');
  if (!documentId) throw new AnimationError('必须指定动画记录', 400, 'DOCUMENT_REQUIRED');
  const file = await getAnimationFileForDocument(user, documentId, fileId);
  const stored = await resolveAnimationBlob(file.blob_key);
  return servePrivateAnimationFile({
    request: head ? new Request(request.url, { method: 'HEAD', headers: request.headers }) : request,
    filePath: stored.path,
    fileName: file.name,
    mime: file.mime,
    expectedBytes: file.bytes,
  });
}

export async function serveAnimationExportRequest(request: NextRequest, exportId: string, head: boolean, user: SessionUser) {
  const documentId = request.nextUrl.searchParams.get('document_id');
  if (!documentId) throw new AnimationError('必须指定动画记录', 400, 'DOCUMENT_REQUIRED');
  const exported = await getAnimationExportForDocument(user, documentId, exportId);
  const stored = await resolveAnimationBlob(exported.blob_key);
  return servePrivateAnimationFile({
    request: head ? new Request(request.url, { method: 'HEAD', headers: request.headers }) : request,
    filePath: stored.path,
    fileName: exported.file_name,
    mime: 'application/zip',
    expectedBytes: exported.bytes,
    download: true,
  });
}
