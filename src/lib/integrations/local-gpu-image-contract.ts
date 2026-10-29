/** Browser-safe identifiers only. Server configuration and transport live in local-gpu-image.ts. */
export const LOCAL_GPU_IMAGE_CHANNEL_ID = 'local_gpu';
/** Website ships only the user-approved Qwen model. */
export const LOCAL_GPU_IMAGE_MODELS = ['qwen-bf16-cu130-v1'] as const;
export type LocalGpuImageModel = typeof LOCAL_GPU_IMAGE_MODELS[number];

/** Sampling and weights are fixed by the Windows execution profile, not request overrides. */
export const LOCAL_GPU_QWEN_PROFILE = {
  id: 'qwen-bf16-cu130-v1',
  model: 'qwen_image_2.1_bf16.safetensors',
  textEncoder: 'qwen3vl_8b_bf16.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  steps: 50,
  cfg: 1,
  sampler: 'euler',
  scheduler: 'simple',
  denoise: 1,
  maxPixels: 8_294_400,
} as const;
