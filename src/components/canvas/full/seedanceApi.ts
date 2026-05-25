import type { Edge } from '@xyflow/react';
import type {
  GenerationCardData,
  GenerationLikeNode,
  ImageCardData,
  MediaCardData,
  SeedanceCanvasNode,
  SeedanceGenerateRequest,
  TextCardData,
  VideoGenerateRequestPreview,
} from './types';

function getNode<T extends SeedanceCanvasNode>(nodes: SeedanceCanvasNode[], id: string): T | undefined {
  return nodes.find((node) => node.id === id) as T | undefined;
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMentionsRef(text: string, refId: string) {
  const cleanText = text.trim();
  const cleanRefId = refId.trim();
  if (!cleanText || !cleanRefId) return false;
  const bareRef = cleanRefId.startsWith('@') ? cleanRefId.slice(1) : cleanRefId;
  const candidates = Array.from(new Set([cleanRefId, `@${bareRef}`].filter(Boolean)));
  return candidates.some((candidate) => new RegExp(`${escapeRegExp(candidate)}(?![A-Za-z0-9_-])`).test(cleanText));
}

function isGenerationLikeNode(node?: SeedanceCanvasNode): node is GenerationLikeNode {
  return node?.type === 'generationCard' || node?.type === 'agentGenerationCard';
}

export function deriveGenerationInputs(nodes: SeedanceCanvasNode[], edges: Edge[], generationNodeId: string) {
  const incomingSourceIds = edges
    .filter((edge) => edge.target === generationNodeId)
    .map((edge) => edge.source);

  return {
    textNodeIds: uniqueIds(incomingSourceIds.filter((id) => getNode(nodes, id)?.type === 'textCard')),
    imageNodeIds: uniqueIds(incomingSourceIds.filter((id) => getNode(nodes, id)?.type === 'imageCard')),
    videoNodeIds: uniqueIds(incomingSourceIds.filter((id) => getNode(nodes, id)?.type === 'videoCard')),
    audioNodeIds: uniqueIds(incomingSourceIds.filter((id) => getNode(nodes, id)?.type === 'audioCard')),
  };
}

export function syncGenerationInputs(nodes: SeedanceCanvasNode[], edges: Edge[]) {
  return nodes.map((node) => {
    if (!isGenerationLikeNode(node)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        inputs: deriveGenerationInputs(nodes, edges, node.id),
      },
    } as SeedanceCanvasNode;
  });
}

function isInstructionPlaceholder(text: string) {
  return [
    '在这里输入 Seedance 提示词、台词或时间轴。',
    '连接文本卡片和图片卡片后，在这里组织 4-15 秒 Seedance 2.0 生成提示词。',
    '请描述主体、动作、镜头变化和画面风格。Wan2.7 的参数会根据所选模型动态调整。',
  ].includes(text.trim());
}

function agentPrePromptPart(data: GenerationCardData) {
  const prePrompt = data.prePrompt?.trim();
  if (!data.agentMode || !prePrompt || isInstructionPlaceholder(prePrompt)) return '';
  return `【Agent 前置提示词】\n${prePrompt}`;
}

function connectedTextPromptParts(nodes: SeedanceCanvasNode[], inputs: ReturnType<typeof deriveGenerationInputs>) {
  return inputs.textNodeIds
    .map((id) => getNode<Extract<SeedanceCanvasNode, { type: 'textCard' }>>(nodes, id))
    .filter((node): node is Extract<SeedanceCanvasNode, { type: 'textCard' }> => Boolean(node))
    .map((node) => (node.data as TextCardData).prompt.trim())
    .filter((text) => Boolean(text) && !isInstructionPlaceholder(text));
}

function basePromptPart(data: GenerationCardData) {
  const rawBasePrompt = data.prompt.trim();
  return isInstructionPlaceholder(rawBasePrompt) ? '' : rawBasePrompt;
}

function meaningfulImageTitle(imageData: ImageCardData) {
  if (imageData.variant === 'frame') return '';
  const cleanTitle = imageData.title.trim();
  const cleanRefId = imageData.refId.trim();
  if (!cleanTitle) return '';
  if (cleanTitle === cleanRefId) return '';
  if (/^图片卡片/.test(cleanTitle)) return '';
  return cleanTitle.replace(cleanRefId, '').replace(/[｜|:：\-—\s]+$/, '').trim();
}

function promptTextParts(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
) {
  const generation = getNode<GenerationLikeNode>(nodes, generationNodeId);
  if (!isGenerationLikeNode(generation)) return [];

  const inputs = deriveGenerationInputs(nodes, edges, generationNodeId);
  const rawBasePrompt = (generation.data as GenerationCardData).prompt.trim();
  const data = generation.data as GenerationCardData;
  const basePrompt = isInstructionPlaceholder(rawBasePrompt) ? '' : rawBasePrompt;
  return [agentPrePromptPart(data), ...connectedTextPromptParts(nodes, inputs), basePrompt].filter(Boolean);
}

function mentionedImageNodeIds(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
  candidateImageNodeIds: string[],
) {
  const promptText = promptTextParts(nodes, edges, generationNodeId).join('\n');
  if (!promptText.trim()) return [];
  const candidateIdSet = new Set(candidateImageNodeIds);
  return nodes
    .filter((node): node is Extract<SeedanceCanvasNode, { type: 'imageCard' }> => node.type === 'imageCard' && candidateIdSet.has(node.id))
    .filter((node) => textMentionsRef(promptText, (node.data as ImageCardData).refId))
    .map((node) => node.id);
}

function effectiveImageNodeIdsForGeneration(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
  data: GenerationCardData,
  connectedImageNodeIds: string[],
) {
  const connectedIds = effectiveImageNodeIds(data, connectedImageNodeIds);
  const mentionedIds = mentionedImageNodeIds(nodes, edges, generationNodeId, connectedImageNodeIds);
  const referenceMode = getReferenceMode(data);
  const allowedMentionedIds = referenceMode === 'first-last-frame' ? mentionedIds.slice(0, 2) : mentionedIds;
  return uniqueIds([...connectedIds, ...allowedMentionedIds]);
}

export function composePromptFromConnections(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
) {
  const generation = getNode<GenerationLikeNode>(nodes, generationNodeId);
  if (!isGenerationLikeNode(generation)) return '';

  const inputs = deriveGenerationInputs(nodes, edges, generationNodeId);
  const data = generation.data as GenerationCardData;
  const imageTitlePrompts = effectiveImageNodeIdsForGeneration(nodes, edges, generationNodeId, data, inputs.imageNodeIds)
    .map((id) => getNode<Extract<SeedanceCanvasNode, { type: 'imageCard' }>>(nodes, id))
    .filter((node): node is Extract<SeedanceCanvasNode, { type: 'imageCard' }> => Boolean(node))
    .map((node) => {
      const imageData = node.data as ImageCardData;
      const title = meaningfulImageTitle(imageData);
      return title ? `${title}：${imageData.refId}` : '';
    })
    .filter(Boolean);
  const prePrompt = agentPrePromptPart(data);
  const bodyPrompts = [...connectedTextPromptParts(nodes, inputs), basePromptPart(data)].filter(Boolean);
  return [prePrompt, ...imageTitlePrompts, ...bodyPrompts].filter(Boolean).join('\n\n');
}

function toWanResolution(quality: GenerationCardData['quality']): '720P' | '1080P' {
  return quality === '1080p' ? '1080P' : '720P';
}

function toArkResolution(quality: GenerationCardData['quality'], model: GenerationCardData['model']): '480p' | '720p' | '1080p' {
  if (model === 'seedance-2.0-fast') return quality === '480p' ? '480p' : '720p';
  return quality;
}

function arkModelId(model: GenerationCardData['model']): 'doubao-seedance-2-0-260128' | 'doubao-seedance-2-0-fast-260128' {
  return model === 'seedance-2.0-fast' ? 'doubao-seedance-2-0-fast-260128' : 'doubao-seedance-2-0-260128';
}

function wanMediaTypeFromUsage(usage: ImageCardData['usage'], index: number): 'first_frame' | 'last_frame' {
  if (usage === 'end-frame') return 'last_frame';
  if (index === 1) return 'last_frame';
  return 'first_frame';
}

function getReferenceMode(data: GenerationCardData) {
  return data.referenceMode ?? (data.mode === 'text-to-video' ? 'text-reference' : data.mode === 'video-extension' ? 'video-reference' : 'omni-reference');
}

function isWan27Model(model: GenerationCardData['model']) {
  return model === 'wan2.7-t2v-2026-04-25' || model === 'wan2.7-i2v-2026-04-25' || model === 'wan2.7-r2v';
}

function composeSeedancePrompt(prompt: string, constraints: string) {
  const cleanPrompt = prompt.trim();
  const cleanConstraints = constraints.trim();
  if (!cleanConstraints) return cleanPrompt;
  const normalizedConstraints = cleanConstraints.startsWith('生成约束') ? cleanConstraints : `生成约束：${cleanConstraints}`;
  return [cleanPrompt, normalizedConstraints].filter(Boolean).join('\n\n');
}

function effectiveImageNodeIds(data: GenerationCardData, imageNodeIds: string[]) {
  const referenceMode = getReferenceMode(data);
  if (referenceMode === 'text-reference' || referenceMode === 'video-reference') return [];
  if (referenceMode === 'first-last-frame') return imageNodeIds.slice(0, 2);
  return imageNodeIds;
}

function buildWan27Request(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
): VideoGenerateRequestPreview | null {
  const generation = getNode<GenerationLikeNode>(nodes, generationNodeId);
  if (!isGenerationLikeNode(generation)) return null;

  const data = generation.data as GenerationCardData;
  const prompt = composePromptFromConnections(nodes, edges, generationNodeId);
  const inputs = deriveGenerationInputs(nodes, edges, generationNodeId);
  const referenceMode = getReferenceMode(data);
  const promptMentionedImageIds = mentionedImageNodeIds(nodes, edges, generationNodeId, inputs.imageNodeIds);
  const effectiveModel = referenceMode === 'text-reference' && promptMentionedImageIds.length > 0
    ? 'wan2.7-r2v'
    : referenceMode === 'text-reference'
      ? 'wan2.7-t2v-2026-04-25'
      : referenceMode === 'first-last-frame'
        ? 'wan2.7-i2v-2026-04-25'
        : 'wan2.7-r2v';
  const selectedImageNodes = effectiveModel === 'wan2.7-t2v-2026-04-25' ? [] : effectiveImageNodeIdsForGeneration(nodes, edges, generationNodeId, data, inputs.imageNodeIds)
    .map((id) => getNode<Extract<SeedanceCanvasNode, { type: 'imageCard' }>>(nodes, id))
    .filter((node): node is Extract<SeedanceCanvasNode, { type: 'imageCard' }> => Boolean(node))
    .slice(0, effectiveModel === 'wan2.7-r2v' ? 9 : 2);
  const media = selectedImageNodes
    .map((node, index) => {
      const imageData = node.data as ImageCardData;
      return {
        type: effectiveModel === 'wan2.7-r2v' ? 'reference_image' as const : wanMediaTypeFromUsage(imageData.usage, index),
        url: imageData.publicUrl || imageData.url || `<${imageData.refId} image url>`,
      };
    });
  const supportsRatio = effectiveModel !== 'wan2.7-i2v-2026-04-25';

  return {
    provider: 'aliyun-bailian',
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    pollEndpointTemplate: 'https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer $DASHSCOPE_API_KEY',
      'X-DashScope-Async': 'enable',
    },
    body: {
      referenceMode,
      model: effectiveModel,
      input: {
        prompt,
        ...(data.negativePrompt.trim() ? { negative_prompt: data.negativePrompt.trim() } : {}),
        ...(media.length > 0 ? { media } : {}),
      },
      parameters: {
        resolution: toWanResolution(data.quality),
        ...(supportsRatio ? { ratio: data.aspectRatio } : {}),
        prompt_extend: true,
        watermark: false,
        duration: data.durationSec,
      },
    },
    notes: [
      `当前参考模式：${referenceMode}。文本参考不传图片；全能参考传所有选中图片；首尾帧最多传两张图并映射 first_frame/last_frame；视频参考会识别已连线视频卡；真实请求字段仍按当前 DashScope 模型文档映射，避免把未支持字段硬塞给 provider。`,
      `Wan2.7 当前模型：${effectiveModel}。图生视频 i2v 使用首帧/尾帧；参考生视频 r2v 使用 reference_image；文生视频 t2v 不传 media。`,
      'HTTP 调用必须带 X-DashScope-Async: enable，否则会报同步调用不支持。',
      ...(effectiveModel === 'wan2.7-i2v-2026-04-25'
        ? [
            '图生视频使用 input.media。第一张图片默认 first_frame，第二张或 usage=end-frame 的图片作为 last_frame。',
            '百炼文档：Wan2.7 图生视频的输出比例尽量与首帧/首段视频保持一致；这里不会发送无效 ratio。',
            '真实调用时 media.url 必须是公网可访问 URL；当前浏览器 data URL/本地文件不能直接给 DashScope 使用。',
          ]
        : effectiveModel === 'wan2.7-r2v'
          ? [
              '参考生视频使用 wan2.7-r2v + reference_image。未传 first_frame 时，ratio 参数按文档可生效；若传首帧图像则 ratio 会被忽略。',
              '真实调用时 media.url 必须是公网可访问 URL；当前浏览器 data URL/本地文件不能直接给 DashScope 使用。',
            ]
          : ['文生视频使用 wan2.7-t2v-2026-04-25，不传 media；ratio 参数可用于控制输出宽高比。']),
      `百炼 Wan2.7 支持 resolution=720P/1080P；当前${supportsRatio ? '会发送 ratio' : '不发送 ratio'}。`,
    ],
  };
}

function buildSeedanceArkRequest(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
): SeedanceGenerateRequest | null {
  const generation = getNode<GenerationLikeNode>(nodes, generationNodeId);
  if (!isGenerationLikeNode(generation)) return null;

  const data = generation.data as GenerationCardData;
  const prompt = composePromptFromConnections(nodes, edges, generationNodeId);
  const seedancePrompt = composeSeedancePrompt(prompt, data.negativePrompt);
  const inputs = deriveGenerationInputs(nodes, edges, generationNodeId);
  const referenceMode = getReferenceMode(data);
  const selectedVideoNodes = (referenceMode === 'video-reference' || referenceMode === 'omni-reference')
    ? inputs.videoNodeIds
        .map((id) => getNode<Extract<SeedanceCanvasNode, { type: 'videoCard' }>>(nodes, id))
        .filter((node): node is Extract<SeedanceCanvasNode, { type: 'videoCard' }> => Boolean(node))
        .slice(0, 3)
    : [];
  const selectedAudioNodes = inputs.audioNodeIds
    .map((id) => getNode<Extract<SeedanceCanvasNode, { type: 'audioCard' }>>(nodes, id))
    .filter((node): node is Extract<SeedanceCanvasNode, { type: 'audioCard' }> => Boolean(node))
    .slice(0, 3);
  const selectedImageNodes = effectiveImageNodeIdsForGeneration(nodes, edges, generationNodeId, data, inputs.imageNodeIds)
    .map((id) => getNode<Extract<SeedanceCanvasNode, { type: 'imageCard' }>>(nodes, id))
    .filter((node): node is Extract<SeedanceCanvasNode, { type: 'imageCard' }> => Boolean(node))
    .slice(0, referenceMode === 'first-last-frame' ? 2 : 9);
  const imageReferences = selectedImageNodes.map((node) => {
    const imageData = node.data as ImageCardData;
    return {
      type: 'image' as const,
      nodeId: node.id,
      refId: imageData.refId,
      url: imageData.publicUrl || imageData.url,
      description: imageData.description,
    };
  });
  const videoReferences = selectedVideoNodes.map((node) => {
    const mediaData = node.data as MediaCardData;
    return {
      type: 'video' as const,
      nodeId: node.id,
      refId: mediaData.refId,
      url: mediaData.publicUrl || mediaData.url,
      description: mediaData.description || mediaData.title,
    };
  });
  const audioReferences = selectedAudioNodes.map((node) => {
    const mediaData = node.data as MediaCardData;
    return {
      type: 'audio' as const,
      nodeId: node.id,
      refId: mediaData.refId,
      url: mediaData.publicUrl || mediaData.url,
      description: mediaData.description || mediaData.title,
    };
  });
  const content: SeedanceGenerateRequest['body']['content'] = [];
  if (seedancePrompt.trim()) content.push({ type: 'text', text: seedancePrompt.trim() });
  selectedImageNodes.forEach((node, index) => {
    const imageData = node.data as ImageCardData;
    const url = imageData.publicUrl || imageData.url || `<${imageData.refId} image url>`;
    const role = referenceMode === 'first-last-frame'
      ? wanMediaTypeFromUsage(imageData.usage, index)
      : 'reference_image';
    content.push({ type: 'image_url', image_url: { url }, role });
  });
  selectedVideoNodes.forEach((node) => {
    const mediaData = node.data as MediaCardData;
    const url = mediaData.publicUrl || mediaData.url || `<${mediaData.refId} video url>`;
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  });
  const hasVisualReferenceForAudio = selectedImageNodes.length > 0 || selectedVideoNodes.length > 0;
  if (hasVisualReferenceForAudio) {
    selectedAudioNodes.forEach((node) => {
      const mediaData = node.data as MediaCardData;
      const url = mediaData.publicUrl || mediaData.url || `<${mediaData.refId} audio url>`;
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
    });
  }

  return {
    provider: 'volcengine-ark',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    pollEndpointTemplate: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer $ARK_API_KEY',
    },
    model: data.model,
    mode: data.mode,
    referenceMode,
    durationSec: data.durationSec,
    aspectRatio: data.aspectRatio,
    quality: data.quality,
    prompt: seedancePrompt,
    sound: data.sound,
    references: [...imageReferences, ...videoReferences, ...audioReferences],
    body: {
      model: arkModelId(data.model),
      content,
      generate_audio: data.sound !== 'mute',
      ratio: data.aspectRatio,
      resolution: toArkResolution(data.quality, data.model),
      duration: Math.max(4, data.durationSec),
      watermark: false,
    },
    notes: [
      '火山方舟 Seedance 2.0 使用 POST /api/v3/contents/generations/tasks 创建异步任务，GET /api/v3/contents/generations/tasks/{id} 轮询。',
      `当前模型映射为 ${arkModelId(data.model)}；Seedance 2.0 fast 不支持 1080p，当前会自动降到 ${toArkResolution(data.quality, data.model)}。`,
      '图片/视频/音频 URL 需要是公网 HTTPS URL；画布上传链路会优先使用 publicUrl。',
      referenceMode === 'first-last-frame'
        ? '首尾帧模式最多传两张图，role=first_frame/last_frame；若连接音频卡，会在已有图片参考的前提下作为 reference_audio 发送。'
        : referenceMode === 'text-reference'
          ? '文本参考模式只传 text content；音频参考不可单独输入，至少需要 1 个参考视频或图片。'
          : referenceMode === 'video-reference'
            ? '视频参考模式会将连接的视频卡作为 content.video_url/reference_video 发送给 Ark；连接音频卡会作为 content.audio_url/reference_audio 发送。视频/音频各最多 3 个，总时长各不超过 15s。'
            : '全能参考模式会将连接图片作为 reference_image、连接视频作为 reference_video、连接音频作为 reference_audio。注意音频不可单独输入，至少需要 1 个参考视频或图片。',
    ],
  };
}

export function buildSeedanceRequest(
  nodes: SeedanceCanvasNode[],
  edges: Edge[],
  generationNodeId: string,
): VideoGenerateRequestPreview | null {
  const generation = getNode<GenerationLikeNode>(nodes, generationNodeId);
  if (!isGenerationLikeNode(generation)) return null;

  const data = generation.data as GenerationCardData;
  const referenceMode = getReferenceMode(data);
  if (isWan27Model(data.model)) {
    return buildWan27Request(nodes, edges, generationNodeId);
  }

  return buildSeedanceArkRequest(nodes, edges, generationNodeId);
}

export function exportCanvas(nodes: SeedanceCanvasNode[], edges: Edge[]) {
  return {
    version: 1 as const,
    title: 'Seedance 2.0 Flow Canvas MVP',
    nodes: syncGenerationInputs(nodes, edges),
    edges,
  };
}
