import { execFile } from 'node:child_process';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type GenerateAssetVideoThumbnailInput = {
  sourcePath: string;
  outputDir: string;
  outputName: string;
  ffmpegPath?: string;
};

type GenerateAssetVideoThumbnailResult = {
  success: boolean;
  thumbnailPath?: string;
  error?: string;
  message?: string;
};

function safeOutputName(value: string) {
  const base = value.replace(/\.[a-z0-9]+$/i, '');
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return safe || 'video';
}

export async function generateAssetVideoThumbnail({
  sourcePath,
  outputDir,
  outputName,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
}: GenerateAssetVideoThumbnailInput): Promise<GenerateAssetVideoThumbnailResult> {
  const finalPath = path.join(outputDir, `${safeOutputName(outputName)}_thumb.jpg`);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(outputDir, { recursive: true });
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '0.5',
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=360:-2',
      '-q:v',
      '4',
      tempPath,
    ], { timeout: 30_000 });
    await rename(tempPath, finalPath);
    return { success: true, thumbnailPath: finalPath };
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      message: '视频封面生成失败',
    };
  }
}
