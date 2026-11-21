import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installStatusBarOverlapGuard } from './statusBarOverlap';
import { loadActiveDeviceId, loadDevices } from './storage';
import { requestPersistence, syncPairedMark } from './storageGuard';
import { installElectronApiShim } from './stubs/electron-api';
import { initTheme } from './theme';
import { launchTarget, loadUiMode, saveUiMode } from './uiMode';
import './styles.css';

// 记住的界面模式：上次在桌面模式就直接回去；从桌面模式点回来（?mode=phone）则落盘为手机版
const params = new URLSearchParams(location.search);
if (params.get('mode') === 'phone') {
  saveUiMode('phone');
  params.delete('mode');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}
const devices = loadDevices();
const deskTarget = launchTarget(location.search, loadUiMode(), devices, loadActiveDeviceId());
if (deskTarget) location.replace(deskTarget);
else if (devices.length > 0) {
  void requestPersistence();
  void syncPairedMark(true);
}

// 复用的桌面组件里有少量 electronAPI 调用，先装降级实现（必须早于组件加载）
installElectronApiShim();

// 主题：本地覆盖 > 桌面下发 > 跟随系统（桌面偏好经 client 的 appearance 帧到达）
initTheme();

// iOS 独立 PWA 偶发钻到状态栏下被系统模糊盖住标题：检测到才退出 viewport-fit=cover
installStatusBarOverlapGuard();

/*
 * 不用 JS 干预视口高度：布局直接吃 CSS 的 100dvh。
 * 曾用 visualViewport 覆盖 --app-height 来避让键盘，但在 standalone 下反复
 * 误判、把高度钉死成偏小的像素值，造成输入框下方大片空白；而 iOS 本来就会
 * 在键盘弹起时把聚焦的输入框滚进可视区，这层机制得不偿失。
 */

const root = document.getElementById('root');
if (root && !deskTarget)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
