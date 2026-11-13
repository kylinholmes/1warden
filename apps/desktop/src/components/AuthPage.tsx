import type { ReactNode } from 'react';
import { BrandMark } from '@1warden/ui';

/** Shared frame for account selection, sign-in and the locked main window. */
export function AuthPage({ children, label }: { children: ReactNode; label?: string }) {
  return <main aria-label={label} className="below-titlebar auth-page" data-tauri-drag-region="deep">
    <header className="auth-page-header"><BrandMark size={32} /><span>1Warden</span></header>
    <div className="auth-page-body"><div className="auth-page-form">{children}</div></div>
  </main>;
}
