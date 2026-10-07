import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from '../../src/App';
import { installExtensionHost } from '../host-impl';
import { createExtensionApplicationClient, scheduleExtensionClipboardClear } from '../application-client';
import { installClipboardScheduler } from '@coffer/ui';
import { initTheme } from '../../src/theme';
import '../styles.css';

// 宿主要最先装 —— 见 @coffer/ui/host 的说明
installExtensionHost();
installClipboardScheduler(scheduleExtensionClipboardClear);
initTheme();
const client = createExtensionApplicationClient();
window.addEventListener('pagehide', () => client.dispose(), { once: true });

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary><App client={client} /></ErrorBoundary>
  </StrictMode>,
);
