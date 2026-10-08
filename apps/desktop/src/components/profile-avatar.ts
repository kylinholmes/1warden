import { PROFILE_AVATAR_MAX_CHARS } from '@1warden/vault';

export interface AvatarView { x: number; y: number; zoom: number }
export interface AvatarCrop { x: number; y: number; size: number }
export const INITIAL_AVATAR_VIEW: AvatarView = { x: .5, y: .5, zoom: 1 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function avatarCrop(width: number, height: number, view: AvatarView): AvatarCrop {
  if (![width, height, view.x, view.y, view.zoom].every(Number.isFinite) || width <= 0 || height <= 0) throw Error('图片尺寸无效');
  const size = Math.min(width, height) / clamp(view.zoom, 1, 4);
  return { x: clamp(view.x * width - size / 2, 0, width - size), y: clamp(view.y * height - size / 2, 0, height - size), size };
}
export function normalizeAvatarView(width: number, height: number, view: AvatarView): AvatarView {
  const crop = avatarCrop(width, height, view);
  return { x: (crop.x + crop.size / 2) / width, y: (crop.y + crop.size / 2) / height, zoom: clamp(view.zoom, 1, 4) };
}

/** data: is permitted by the native CSP; blob: image URLs deliberately are not. */
export async function loadProfileAvatar(file: File): Promise<HTMLImageElement> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB');
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(Error('图片无法读取，请换一张图片'));
    reader.onerror = reader.onabort = () => reject(Error('图片无法读取，请换一张图片'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve(); image.onerror = () => reject(new Error('图片无法读取，请换一张 JPG、PNG 或 WebP 图片'));
    image.src = source;
  });
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片尺寸过大，请先缩小图片');
  return image;
}

/** Re-encode cropped pixels only: never persist the original image or metadata. */
export function encodeProfileAvatar(image: HTMLImageElement, view: AvatarView): string {
  const crop = avatarCrop(image.naturalWidth, image.naturalHeight, view);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法处理头像');
  for (const size of [128, 96, 80, 64]) {
    canvas.width = size; canvas.height = size;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size);
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const encoded = canvas.toDataURL('image/jpeg', quality);
      if (encoded.length <= Math.min(PROFILE_AVATAR_MAX_CHARS, 3600)) return encoded;
    }
  }
  throw new Error('图片压缩后仍过大，请选择更简单的头像');
}
export async function prepareProfileAvatar(file: File): Promise<string> {
  return encodeProfileAvatar(await loadProfileAvatar(file), INITIAL_AVATAR_VIEW);
}
