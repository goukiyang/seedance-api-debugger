export function containImageSize(width: number, height: number, naturalWidth: number, naturalHeight: number) {
  if (![width, height, naturalWidth, naturalHeight].every(value => Number.isFinite(value) && value > 0)) return { width: 0, height: 0 };
  const scale = Math.min(width / naturalWidth, height / naturalHeight);
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

export function avatarCellRect(width: number, height: number, size: number, index: number) {
  if (![2, 3].includes(size) || !Number.isInteger(index) || index < 0 || index >= size * size || ![width, height].every(value => Number.isSafeInteger(value) && value >= size)) throw new Error('格子或原图尺寸无效');
  const column = index % size, row = Math.floor(index / size);
  const x = Math.floor(column * width / size), y = Math.floor(row * height / size);
  return { x, y, width: Math.floor((column + 1) * width / size) - x, height: Math.floor((row + 1) * height / size) - y };
}
