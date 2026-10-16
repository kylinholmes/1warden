import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installDesktopHost } from '../host-impl';
import { initTheme } from '../theme';
import { initPlatform } from '../platform';
import { initNativeFeel } from '../native';
import { Quick } from './Quick';
import '../styles.css';

installDesktopHost();
initTheme(); initPlatform(); initNativeFeel();
createRoot(document.getElementById('root')!).render(<StrictMode><Quick /></StrictMode>);
