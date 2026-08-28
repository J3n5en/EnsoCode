import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installElectronApiShim } from './stubs/electron-api';
import { initTheme } from './theme';
import './styles.css';

// 复用的桌面组件里有少量 electronAPI 调用，先装降级实现（必须早于组件加载）
installElectronApiShim();

// 主题：本地覆盖 > 桌面下发 > 跟随系统（桌面偏好经 client 的 appearance 帧到达）
initTheme();

/*
 * 键盘弹起时 dvh 不变，输入框会被键盘盖住。用 visualViewport 的实际可见高度
 * 覆盖 --app-height，让布局跟着收缩（键盘收起时回落到 dvh）。
 */
const viewport = window.visualViewport;
if (viewport) {
  const syncHeight = () => {
    // 键盘占屏超过 15% 才认为是弹起，避免地址栏微调时抖动
    const keyboardShown = viewport.height < window.innerHeight * 0.85;
    document.documentElement.style.setProperty(
      '--app-height',
      keyboardShown ? `${viewport.height}px` : '100dvh'
    );
  };
  syncHeight();
  viewport.addEventListener('resize', syncHeight);
  viewport.addEventListener('scroll', syncHeight);
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
