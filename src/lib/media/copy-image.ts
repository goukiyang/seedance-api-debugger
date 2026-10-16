'use client';

async function imagePng(src: string): Promise<Blob> {
  const response = await fetch(src, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('图片读取失败，请重试');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('当前内容不是图片');
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片过大，浏览器无法安全复制，请下载原图');
    canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法复制这张图片');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas!.toBlob(result => result
      ? resolve(result) : reject(new Error('图片转换失败，请使用右键复制')), 'image/png'));
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    URL.revokeObjectURL(url);
  }
}

export function copyImage(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return Promise.reject(new Error('浏览器不支持按钮复制，请在图片上右键复制'));
  }
  // Start the clipboard request inside the click event, before image loading yields.
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': imagePng(src) })]);
}

/** Keep the clipboard call in the user event; callers may prepare an authorized PNG asynchronously. */
export function copyPngBlob(input: Blob | Promise<Blob>): Promise<void> {
  const png = Promise.resolve(input).then(blob => {
    if (blob.type !== 'image/png' || !blob.size) throw new Error('拼图尚未准备好，请重试或下载');
    return blob;
  });
  // A rejected preparation must still be consumed when clipboard support is absent or denied synchronously.
  void png.catch(() => undefined);
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return Promise.reject(new Error('浏览器不支持按钮复制，请下载拼图'));
  // Do not await png before write: Safari and other browsers require the original user activation.
  try { return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); }
  catch (error) { return Promise.reject(error); }
}
