import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { requireAnimationDocument } from '@/lib/animation/access';
import { AnimationError, animationJson, requireRequestId, withAnimationAuth } from '@/lib/animation/http';
import {
  animationFileInfoFromRow,
  animationRequestHash,
  createAnimationCandidateFile,
  findAnimationFileByHash,
  getIdempotentResponse,
} from '@/lib/animation/repository';
import {
  ANIMATION_CANDIDATE_RESERVED_BYTES,
  ANIMATION_MAX_UPLOAD_BYTES,
  createAnimationTempDirectory,
  inspectLocalAnimationFile,
  publishAnimationBlob,
  removeAnimationBlob,
  removeAnimationTempDirectory,
  reserveAnimationUpload,
  sanitizeAnimationFilename,
  streamRequestToFile,
  validateAnimationCandidate,
  writeAnimationReconcileManifest,
} from '@/lib/animation/storage';
import type { AnimationPose } from '@/lib/animation/types';

export const runtime = 'nodejs';
export const maxDuration = 180;

type RouteContext = { params: { id: string } };

export async function POST(request: NextRequest, { params }: RouteContext) {
  return withAnimationAuth(request, true, async (user) => {
    const { document } = await requireAnimationDocument(user, params.id, 'write');
    if (document.status !== 'active') throw new AnimationError('已归档的动画不能添加文件', 409, 'DOCUMENT_ARCHIVED');
    const nameParam = request.nextUrl.searchParams.get('name');
    if (!nameParam) throw new AnimationError('必须提供文件名', 400, 'INVALID_FILENAME');
    const name = sanitizeAnimationFilename(nameParam, '');
    if (name.includes('/') || name.includes('\\')) throw new AnimationError('文件名无效', 400, 'INVALID_FILENAME');
    const role = request.nextUrl.searchParams.get('role');
    if (role !== 'video' && role !== 'candidate') throw new AnimationError('文件用途无效', 400, 'INVALID_ROLE');
    if (role === 'candidate' && !/\.png$/i.test(name)) throw new AnimationError('候选图片必须使用 PNG 文件名', 415, 'INVALID_PNG');
    const requestId = requireRequestId(request.headers.get('x-request-id'));
    const operation = `file:${document.id}:${role}`;
    const releaseCapacity = await reserveAnimationUpload(ANIMATION_CANDIDATE_RESERVED_BYTES);
    let tempDirectory: string | null = null;
    let publishedBlob: string | null = null;
    let manifestSaved = false;
    try {
      tempDirectory = await createAnimationTempDirectory();
      const sourcePath = path.join(tempDirectory, 'upload.bin');
      const uploaded = await streamRequestToFile(request, sourcePath, ANIMATION_MAX_UPLOAD_BYTES);
      const requestHash = animationRequestHash({ sha256: uploaded.sha256 });
      const currentAccess = await requireAnimationDocument(user, document.id, 'write');
      if (currentAccess.document.status !== 'active') throw new AnimationError('已归档的动画不能添加文件', 409, 'DOCUMENT_ARCHIVED');
      const cached = await getIdempotentResponse<{ success: true; file: unknown; pose?: AnimationPose }>(user.id, requestId, operation, requestHash);
      if (cached) return animationJson(cached);

      const checked = await validateAnimationCandidate(sourcePath, role, name);
      const metadata = await inspectLocalAnimationFile(sourcePath, name, role, checked);
      const existing = await findAnimationFileByHash(document.id, role, metadata.sha256);
      let file = existing
        ? { ...animationFileInfoFromRow(existing), id: existing.id, blob_key: existing.blob_key }
        : null;
      if (!file) {
        const published = await publishAnimationBlob(sourcePath, metadata.sha256);
        publishedBlob = published.blob_key;
        file = { ...metadata, blob_key: published.blob_key };
      }
      const pose: Omit<AnimationPose, 'file_id'> | undefined = role === 'candidate' ? {
        id: randomUUID(),
        label: name,
        width: checked.width,
        height: checked.height,
        logical_width: null,
        logical_height: null,
        pixels_per_unit: null,
        source: { note: '尚未按游戏逻辑尺寸适配' },
      } : undefined;
      try {
        const result = await createAnimationCandidateFile({
          user,
          documentId: document.id,
          requestId,
          requestHash,
          operation,
          metadata: file,
          candidatePose: pose,
        });
        if (result.persisted) publishedBlob = null;
        return animationJson(result.response);
      } catch (error) {
        if (publishedBlob && !(error instanceof AnimationError)) {
          try {
            await writeAnimationReconcileManifest(randomUUID(), {
              version: 1,
              kind: 'candidate_file',
              document_id: document.id,
              project_id: document.project_id,
              actor_user_id: user.id,
              request_id: requestId,
              operation,
              request_hash: requestHash,
              file,
              pose,
            });
            manifestSaved = true;
          } catch {
            throw new AnimationError('文件已校验，登记暂未完成；请使用相同请求编号重试', 503, 'RECONCILE_PENDING');
          }
          throw new AnimationError('文件已校验，正在等待登记恢复；请使用相同请求编号重试', 503, 'RECONCILE_PENDING');
        }
        throw error;
      }
    } finally {
      if (publishedBlob && !manifestSaved) await removeAnimationBlob(publishedBlob);
      if (tempDirectory) await removeAnimationTempDirectory(tempDirectory);
      await releaseCapacity();
    }
  });
}
