import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect, useRef } from 'react';
import { avatarCrop, encodeProfileAvatar, INITIAL_AVATAR_VIEW, normalizeAvatarView, type AvatarView } from './profile-avatar';

export function AvatarCropper({ image, onConfirm, onCancel }: {
  image: HTMLImageElement; onConfirm: (value: string) => void; onCancel: () => void;
}) {
  const viewStore = useLocalStore(() => {
    const view = (INITIAL_AVATAR_VIEW) as AvatarView;
    const error = (null) as string | null;
    return { view, error };
  });
  const [view, setView] = useStoreField(viewStore, 'view');
  const [error, setError] = useStoreField(viewStore, 'error');
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; view: AvatarView } | null>(null);
  const width = image.naturalWidth; const height = image.naturalHeight;
  const crop = avatarCrop(width, height, view);
  useEffect(() => { frame.current?.focus({ preventScroll: true }); frame.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const update = (next: AvatarView) => setView(normalizeAvatarView(width, height, next));
  return <section className="avatar-cropper mt-4" aria-label="裁剪头像" data-escape-scope="true" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }}>
    <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">调整头像</h4>
      <button type="button" className="btn btn-ghost" onClick={() => update(INITIAL_AVATAR_VIEW)}>重置</button></div>
    <p id="avatar-crop-help" className="mb-3 text-xs text-[var(--ink-tertiary)]">拖动图片选择区域，用滑块放大。也可用方向键移动。</p>
    <div ref={frame} className="avatar-crop-frame" role="group" tabIndex={0} aria-label="头像取景区域" aria-describedby="avatar-crop-help"
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = crop.size * (event.shiftKey ? .1 : .02);
        update({ ...view, x: view.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) / width,
          y: view.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) / height });
      }} onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view };
      }} onPointerMove={event => {
        const start = drag.current; if (!start || start.id !== event.pointerId) return;
        const size = avatarCrop(width, height, start.view).size;
        const scale = size / event.currentTarget.getBoundingClientRect().width;
        update({ ...start.view, x: start.view.x - (event.clientX - start.x) * scale / width,
          y: start.view.y - (event.clientY - start.y) * scale / height });
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <img alt="" src={image.src} draggable={false} style={{ width: `${width / crop.size * 100}%`, height: `${height / crop.size * 100}%`,
        left: `${-crop.x / crop.size * 100}%`, top: `${-crop.y / crop.size * 100}%` }} />
      <span className="avatar-crop-mask" aria-hidden="true" />
    </div>
    <div className="avatar-crop-zoom"><label htmlFor="avatar-zoom">缩放</label>
      <input id="avatar-zoom" type="range" min="1" max="4" step="0.01" value={view.zoom} aria-valuetext={`${Math.round(view.zoom * 100)}%`}
        onChange={event => update({ ...view, zoom: Number(event.target.value) })} />
      <output htmlFor="avatar-zoom">{Math.round(view.zoom * 100)}%</output></div>
    {error && <p role="alert" className="text-xs text-[var(--risk)]">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" className="btn btn-quiet" onClick={onCancel}>取消裁剪</button>
      <button type="button" className="btn btn-primary" onClick={() => {
        try { onConfirm(encodeProfileAvatar(image, view)); } catch (e) { setError(e instanceof Error ? e.message : '头像处理失败'); }
      }}>使用此头像</button>
    </div>
  </section>;
}
