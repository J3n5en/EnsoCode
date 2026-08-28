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
 * 覆盖 --app-height，让布局跟着收缩；键盘收起立即回落到 dvh。
 *
 * 判据是「有输入框聚焦」而不是高度比例：standalone（添加到主屏幕）下没有
 * 浏览器工具栏，innerHeight 与 visualViewport.height 的关系与浏览器里不同，
 * 按比例猜会误判成键盘弹起，把 --app-height 钉死成偏小的像素值 —— 表现为
 * 输入框下方一大片空白。
 */
const viewport = window.visualViewport;
if (viewport) {
  const editableFocused = () => {
    const el = document.activeElement;
    return (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLInputElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    );
  };
  const syncHeight = () => {
    // 只有输入中且可见区确实被压缩，才用像素高度；其余一律回到 dvh
    const shrunk = viewport.height < window.innerHeight - 80;
    document.documentElement.style.setProperty(
      '--app-height',
      editableFocused() && shrunk ? `${viewport.height}px` : '100dvh'
    );
  };
  syncHeight();
  viewport.addEventListener('resize', syncHeight);
  viewport.addEventListener('scroll', syncHeight);
  // 失焦后键盘收起，但 visualViewport 未必再触发 resize，显式回落
  document.addEventListener('focusout', () => setTimeout(syncHeight, 100));
  document.addEventListener('focusin', () => setTimeout(syncHeight, 100));
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
