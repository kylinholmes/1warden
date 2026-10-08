import compact from './brand/compact.png';
import app from './brand/app.png';

/** Brand only: keep security-state padlocks and user avatars semantically distinct. */
export function BrandMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img data-brand-mark={size <= 32 ? 'compact' : 'app'}
    src={size <= 32 ? compact : app} alt="" aria-hidden="true" draggable={false}
    width={size} height={size} className={`shrink-0 select-none ${className}`}
    style={{ width: size, height: size, objectFit: 'contain' }} />;
}
