import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from '../../src/App';
import { installExtensionHost } from '../host-impl';
import { createExtensionApplicationClient, scheduleExtensionClipboardClear } from '../application-client';
import { installClipboardScheduler } from '@1warden/ui';
import { initTheme } from '../../src/theme';
import '../styles.css';

// 宿主要最先装 —— 见 @1warden/ui/host 的说明
installExtensionHost();
installClipboardScheduler(scheduleExtensionClipboardClear);
initTheme();
const client = createExtensionApplicationClient();
const AppUpdateHost = lazy(() => import('../../src/components/AppUpdateHost'));
window.addEventListener('pagehide', () => client.dispose(), { once: true });

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary><App client={client} /><Suspense fallback={null}><AppUpdateHost /></Suspense></ErrorBoundary>
  </StrictMode>,
);
