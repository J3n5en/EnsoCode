import './stubs/install-electron-api';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installKeyboardInset } from './keyboard';
import { watchShellUpdate } from './shellUpdate';
import { installStatusBarOverlapGuard } from './statusBarOverlap';
import { loadActiveDeviceId, loadDevices } from './storage';
import { requestPersistence, syncPairedMark } from './storageGuard';
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

// 主题：本地覆盖 > 桌面下发 > 跟随系统（桌面偏好经 client 的 appearance 帧到达）
initTheme();

// iOS 独立 PWA 偶发钻到状态栏下被系统模糊盖住标题：检测到才退出 viewport-fit=cover
installStatusBarOverlapGuard();

// 键盘避让：只在触屏、有输入框聚焦且可见区确实被压掉时把根容器摆到可见区上，其余时候不碰布局
if (!deskTarget) installKeyboardInset(window);

// 壳是旧版本缓存出来的：等下次回到前台再整页换新
if (!deskTarget && 'serviceWorker' in navigator)
  watchShellUpdate({
    container: navigator.serviceWorker,
    doc: document,
    storage: sessionStorage,
    canReloadNow: () => false,
    reload: () => location.reload(),
  });

const root = document.getElementById('root');
if (root && !deskTarget)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
