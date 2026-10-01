'use client';

async function imagePng(src: string): Promise<Blob> {
  const response = await fetch(src, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('图片读取失败，请重试');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('当前内容不是图片');
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法复制这张图片');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result
      ? resolve(result) : reject(new Error('图片转换失败，请使用右键复制')), 'image/png'));
  } finally {
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
