import { PROFILE_AVATAR_MAX_CHARS } from '@coffer/vault';

/** Re-encode pixels only: no image metadata or original file enters the vault. */
export async function prepareProfileAvatar(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('图片无法读取，请换一张图片'));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片尺寸过大，请先缩小图片');
    const crop = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法处理头像');
    for (const size of [128, 96, 80, 64]) {
      canvas.width = size; canvas.height = size;
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size);
      context.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, size, size);
      for (const quality of [0.85, 0.7, 0.55, 0.4]) {
        const encoded = canvas.toDataURL('image/jpeg', quality);
        if (encoded.length <= PROFILE_AVATAR_MAX_CHARS) return encoded;
      }
    }
    throw new Error('图片压缩后仍过大，请选择更简单的头像');
  } finally { URL.revokeObjectURL(url); }
}
