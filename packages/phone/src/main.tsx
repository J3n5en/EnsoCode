import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installElectronApiShim } from './stubs/electron-api';
import './styles.css';

// 复用的桌面组件里有少量 electronAPI 调用，先装降级实现（必须早于组件加载）
installElectronApiShim();

// 跟随系统深浅色（主题变量由 .dark class 切换，与桌面同源）
const applyTheme = (dark: boolean) => document.documentElement.classList.toggle('dark', dark);
const media = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(media.matches);
media.addEventListener('change', (e) => applyTheme(e.matches));

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
