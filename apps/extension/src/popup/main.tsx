import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';
import { installExtensionHost } from '../host-impl';
import '../styles.css';

// 宿主要最先装 —— 见 @coffer/ui/host 的说明
installExtensionHost();

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
