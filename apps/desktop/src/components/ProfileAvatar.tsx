import { useLocalStore, useStoreField } from '@1warden/state/react';
import { useEffect } from 'react';
import type { UserProfile } from '@1warden/vault';

export function ProfileAvatar({ profile, fallback, className = 'h-8 w-8' }: {
  profile?: UserProfile | null; fallback: string; className?: string;
}) {
  const viewStore = useLocalStore(() => {
    const failed = false;
    return { failed };
  });
  const [failed, setFailed] = useStoreField(viewStore, 'failed');
  const src = profile?.avatarDataUrl;
  useEffect(() => { setFailed(false); }, [src]);
  return <span aria-hidden="true" className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-tint)] font-semibold text-[var(--accent)] ${className}`}>
    {src && !failed ? <img src={src} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      : (profile?.displayName || fallback || '?').slice(0, 1).toUpperCase()}
  </span>;
}
