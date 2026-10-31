import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeImage, screen, session } from 'electron';
import { PreviewController, type PreviewView } from './appPreviewController';
import { placePreview, previewSize } from './appPreviewLayout';

const PARTITION = 'computer-preview';

function previewHtml(zh: boolean): string {
  const failed = zh
    ? '无法显示画面（需要屏幕录制权限）'
    : 'Preview unavailable (Screen Recording needed)';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; media-src blob: mediastream:">
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-app-region:drag;
font:12px/16px -apple-system,BlinkMacSystemFont,sans-serif;color:#f5f5f7}
#f{position:absolute;inset:0;border-radius:10px;overflow:hidden;background:#1c1c1e;display:flex;flex-direction:column;
box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
#s{flex:1;min-height:0;position:relative;background:#000}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#p{position:absolute;left:0;top:0;width:22px;height:26px;margin:-2px 0 0 -2px;opacity:0;transition:opacity .18s ease-out;pointer-events:none}
#p.on{opacity:1}
#r{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:9px;border:2px solid #147ce5;box-sizing:border-box;opacity:0}
#p.on #r{animation:ring .5s ease-out}
@keyframes ring{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
#e{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:12px;text-align:center;color:#aeaeb2}
body.err #e{display:flex}
#b{height:28px;display:flex;align-items:center;gap:6px;padding:0 6px 0 8px}
#i{width:16px;height:16px;display:none}
#l{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
#d{width:6px;height:6px;border-radius:3px;background:#30d158;flex:none}
#x{-webkit-app-region:no-drag;border:0;background:transparent;color:#aeaeb2;font-size:15px;line-height:20px;width:20px;height:20px;
border-radius:5px;padding:0;cursor:default}
#x:hover{background:rgba(255,255,255,.12);color:#fff}
</style></head><body><div id="f"><div id="s"><video id="v" autoplay muted playsinline></video><div id="p"><div id="r"></div><svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23 L13.5 21.7 L10 14.3 L17 14.3 Z" fill="#147ce5" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div><div id="e">${failed}</div></div>
<div id="b"><span id="d"></span><img id="i" alt=""><span id="l"></span><button id="x" title="${zh ? '关闭' : 'Close'}">×</button></div></div>
<script>
const v = document.getElementById('v');
let stream = null, current = null;
function stop() {
  current = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  v.srcObject = null;
}
window.__label = (label) => { document.getElementById('l').textContent = label; };
window.__icon = (src) => { const i = document.getElementById('i'); i.src = src; i.style.display = 'block'; };
window.__set = async (id) => {
  if (current === id && (stream || document.body.classList.contains('err'))) return;
  stop();
  current = id;
  document.body.classList.remove('err');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: 'window:' + id + ':0', maxFrameRate: 15, maxWidth: 1280, maxHeight: 1280 } } });
    if (current !== id) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    v.srcObject = s;
    // 目标窗口关闭时流会结束
    s.getVideoTracks()[0]?.addEventListener('ended', () => { if (current === id) document.body.classList.add('err'); });
  } catch {
    if (current === id) document.body.classList.add('err');
  }
};
window.__stop = stop;
let pt;
// 点击位置按窗口比例换算到画面（object-fit: contain 留出的黑边要扣掉）
window.__pointer = (fx, fy) => {
  const box = document.getElementById('s').getBoundingClientRect();
  const vw = v.videoWidth || box.width, vh = v.videoHeight || box.height;
  const k = Math.min(box.width / vw, box.height / vh);
  const p = document.getElementById('p');
  p.style.left = (box.width - vw * k) / 2 + fx * vw * k + 'px';
  p.style.top = (box.height - vh * k) / 2 + fy * vh * k + 'px';
  p.classList.remove('on');
  void p.offsetWidth;
  p.classList.add('on');
  clearTimeout(pt);
  pt = setTimeout(() => p.classList.remove('on'), 1400);
};
// 页面没有 preload；用标题变化告诉 Main“用户点了关闭”（window.close() 会直接销毁窗口）
document.getElementById('x').addEventListener('click', () => { document.title = 'close:' + Date.now(); });
</script></body></html>`;
}

function createView(onUserClose: (windowId: string) => void): PreviewView {
  const zh = app.getLocale().toLowerCase().startsWith('zh');
  const file = path.join(app.getPath('userData'), 'computer', 'preview.html');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, previewHtml(zh));
  const previewSession = session.fromPartition(PARTITION);
  let win: BrowserWindow | undefined;
  let current: string | undefined;
  let anchor: { right: number; bottom: number } | undefined;
  let disposing = false;
  const icons = new Map<string, string>();
  // 每次动作都会调 show：同一窗口只在内容真的变了才动浮窗，避免闪烁、跳位
  const sizes = new Map<string, { width: number; height: number }>();
  let label: string | undefined;
  let iconPath: string | undefined;
  // 只允许本预览页取窗口画面
  previewSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(permission === 'media' && contents === win?.webContents)
  );
  previewSession.setPermissionCheckHandler(
    (contents, permission) => permission === 'media' && contents === win?.webContents
  );
  const run = (script: string) => {
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    const exec = () => void contents.executeJavaScript(script, false).catch(() => undefined);
    if (contents.isLoading()) contents.once('did-finish-load', exec);
    else exec();
  };
  const ensure = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;
    const created = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      type: process.platform === 'darwin' ? 'panel' : undefined,
      focusable: false,
      acceptFirstMouse: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      alwaysOnTop: true,
      width: 320,
      height: 228,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    created.setAlwaysOnTop(true, 'floating');
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 不出现在截图里：模型看到的应是目标 app 本身
    created.setContentProtection(true);
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', (event) => event.preventDefault());
    const userClose = () => {
      const closed = current;
      current = undefined;
      run('window.__stop()');
      created.hide();
      if (closed) onUserClose(closed);
    };
    created.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (title.startsWith('close:')) userClose();
    });
    created.on('close', (event) => {
      if (disposing) return;
      event.preventDefault();
      userClose();
    });
    created.on('moved', () => {
      const bounds = created.getBounds();
      anchor = { right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
    });
    void created.loadFile(file);
    win = created;
    return created;
  };
  const icon = (appPath: string) => {
    const cached = icons.get(appPath);
    if (cached) return Promise.resolve(cached);
    // getFileIcon 对 .app 常给通用图标；缩略图走 Quick Look，拿到的是 app 自己的图标
    return nativeImage.createThumbnailFromPath(appPath, { width: 32, height: 32 }).then((image) => {
      const url = image.toDataURL();
      icons.set(appPath, url);
      return url;
    });
  };
  return {
    show(input) {
      if (!app.isReady() || !/^\d+$/.test(input.windowId)) return;
      const target = ensure();
      if (input.size) sizes.set(input.windowId, input.size);
      const size = previewSize(sizes.get(input.windowId));
      const visible = target.isVisible();
      const now = target.getBounds();
      const keep =
        anchor ?? (visible ? { right: now.x + now.width, bottom: now.y + now.height } : undefined);
      const display = keep
        ? screen.getDisplayNearestPoint({ x: keep.right, y: keep.bottom })
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const next = placePreview(display.workArea, size, keep);
      if (
        !visible ||
        next.x !== now.x ||
        next.y !== now.y ||
        next.width !== now.width ||
        next.height !== now.height
      ) {
        target.setBounds(next);
      }
      const nextLabel = zh ? `AI 正在操作 · ${input.app}` : `AI is using ${input.app}`;
      if (nextLabel !== label) {
        label = nextLabel;
        run(`window.__label(${JSON.stringify(nextLabel)})`);
      }
      if (input.path && input.path !== iconPath) {
        iconPath = input.path;
        void icon(input.path).then(
          (url) => run(`window.__icon(${JSON.stringify(url)})`),
          () => undefined
        );
      }
      if (current !== input.windowId) {
        current = input.windowId;
        run(`window.__set(${JSON.stringify(input.windowId)})`);
      }
      if (!target.isVisible()) target.showInactive();
    },
    hide() {
      current = undefined;
      if (!win || win.isDestroyed()) return;
      run('window.__stop()');
      win.hide();
    },
    pointer(fx, fy) {
      if (!current) return;
      run(`window.__pointer(${Number(fx)}, ${Number(fy)})`);
    },
    dispose() {
      disposing = true;
      if (win && !win.isDestroyed()) win.destroy();
      win = undefined;
      current = undefined;
    },
  };
}

/** 后台操作时的画中画：实时显示正在被操作的窗口（即使它被挡住或在别的桌面） */
export function createAppPreview(options: { enabled: () => boolean }) {
  const controller: PreviewController = new PreviewController({
    enabled: () => process.platform === 'darwin' && options.enabled(),
    view: () => createView((windowId) => controller.userClosed(windowId)),
    hideDelayMs: 10_000,
  });
  return controller;
}
