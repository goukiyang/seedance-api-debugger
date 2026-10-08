import type { StoryShot } from '@/lib/story-workflow';
import type { PickerItem } from '@/lib/assets/picker-types';

export type StoryNode = { id: string; type: string; x: number; y: number; data: Record<string, unknown> };
export type StoryCanvas = { context?: { project_id?: string; video_card_id?: string }; canvas: {
  nodes: StoryNode[]; connections: { from: string; to: string }[]; selectedNodeId?: string | null; [key: string]: unknown;
}; [key: string]: unknown };

export function attachStoryVideo(graph: StoryCanvas, sourceId: string, shot: StoryShot, ordinal: number,
  reference: PickerItem | undefined, videoId: string, imageId: string, sourceRevision: number): void {
  const source = graph.canvas.nodes.find(node => node.id === sourceId && ['text', 'script'].includes(node.type));
  if (!source) throw Error('故事源节点已不存在，未创建媒体节点');
  if (graph.canvas.nodes.some(node => node.id === videoId || reference && node.id === imageId)) throw Error('本次媒体节点已存在，请打开画布核对');
  if (!shot.videoPrompt.trim() || !Number.isInteger(shot.durationSeconds) || shot.durationSeconds < 1 || shot.durationSeconds > 15) throw Error('视频要求或时长无效');
  if (reference && (reference.type !== 'image' || reference.unavailableReason || !reference.referenceImageId)) throw Error('请先选用可用原图并关联为参考图');
  graph.canvas.nodes.push({ id: videoId, type: 'video', x: source.x + 840, y: source.y + ordinal * 620,
    data: { title: shot.title, prompt: shot.videoPrompt, description: shot.description, generationStatus: 'idle',
      mode: reference ? 'image-to-video' : 'text-to-video', videoSettings: { duration: shot.durationSeconds },
      storySource: { nodeId: sourceId, shotId: shot.id, sourceRevision } } });
  graph.canvas.connections.push({ from: sourceId, to: videoId });
  if (reference) {
    graph.canvas.nodes.push({ id: imageId, type: 'image', x: source.x + 420, y: source.y + ordinal * 620,
      data: { title: reference.fileName, source: 'reference_image', assetId: reference.assetId || null,
        referenceImageId: reference.referenceImageId, width: reference.width, height: reference.height,
        originalUrl: reference.originalUrl, imageUrl: reference.originalUrl,
        previewImage: reference.thumbnailUrl || reference.originalUrl, generationStatus: 'idle' } });
    graph.canvas.connections.push({ from: imageId, to: videoId });
  }
  graph.canvas.selectedNodeId = videoId;
}
