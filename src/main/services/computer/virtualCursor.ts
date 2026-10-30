import { app, BrowserWindow } from 'electron';

const WIDTH = 220;
const HEIGHT = 44;
/** 指针尖在窗口内的位置 */
const TIP_X = 4;
const TIP_Y = 4;
const VISIBLE_MS = 1400;
/** 隐藏后空闲多久销毁窗口（每个窗口带一个 renderer 进程） */
const DESTROY_AFTER_MS = 20_000;
/** 同时保留的指针窗口上限，超出时销毁最久未用的 */
const MAX_WINDOWS = 4;
const COLOR = '#147ce5';

function cursorHtml(): string {
  return `<!doctype html><html><head><style>
html,body{margin:0;background:transparent;overflow:hidden;user-select:none}
#c{position:absolute;left:0;top:0;opacity:0;transition:opacity .18s ease-out}
#c.on{opacity:1}
#l{position:absolute;left:22px;top:18px;max-width:${WIDTH - 30}px;padding:2px 8px;border-radius:9px;
background:${COLOR};color:#fff;font:600 11px/16px -apple-system,BlinkMacSystemFont,sans-serif;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.25)}
</style></head><body><div id="c">
<svg width="22" height="26" viewBox="0 0 22 26" style="position:absolute;left:${TIP_X - 2}px;top:${TIP_Y - 2}px">
<path d="M2 2 L2 20 L7 15.5 L10.5 23 L13.5 21.7 L10 14.3 L17 14.3 Z" fill="${COLOR}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
</svg><div id="l"></div></div>
<script>
let t;
window.__show = (label) => {
  document.getElementById('l').textContent = label;
  const c = document.getElementById('c');
  c.classList.add('on');
  clearTimeout(t);
  t = setTimeout(() => c.classList.remove('on'), ${VISIBLE_MS});
};
</script></body></html>`;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: process.platform !== 'darwin',
    focusable: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    width: WIDTH,
    height: HEIGHT,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  // 不能出现在截图里：模型看到的应是目标 app 本身
  win.setContentProtection(true);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cursorHtml())}`);
  return win;
}

/**
 * 后台动作的可视指针：每个目标进程一个，标明是哪个 app 在被操作。
 * 外观与系统指针区分开（带色与标签），不会被误认为真实鼠标。
 */
export function createVirtualCursor() {
  type Entry = {
    win: BrowserWindow;
    timer?: ReturnType<typeof setTimeout>;
    destroyTimer?: ReturnType<typeof setTimeout>;
    usedAt: number;
  };
  const windows = new Map<string, Entry>();
  const zh = () => app.getLocale().toLowerCase().startsWith('zh');
  const drop = (key: string) => {
    const entry = windows.get(key);
    if (!entry) return;
    windows.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.destroyTimer) clearTimeout(entry.destroyTimer);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  };
  return {
    pointer(input: { pid?: number; app?: string; screenX: number; screenY: number }) {
      if (!app.isReady()) return;
      const key = String(input.pid ?? 'desktop');
      let entry = windows.get(key);
      if (entry?.win.isDestroyed()) {
        drop(key);
        entry = undefined;
      }
      if (!entry) {
        while (windows.size >= MAX_WINDOWS) {
          const oldest = [...windows].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
          if (!oldest) break;
          drop(oldest[0]);
        }
        entry = { win: createWindow(), usedAt: Date.now() };
        windows.set(key, entry);
      }
      entry.usedAt = Date.now();
      if (entry.destroyTimer) clearTimeout(entry.destroyTimer);
      const current = entry;
      const { win } = entry;
      win.setBounds({
        x: Math.round(input.screenX - TIP_X),
        y: Math.round(input.screenY - TIP_Y),
        width: WIDTH,
        height: HEIGHT,
      });
      if (!win.isVisible()) win.showInactive();
      const label = input.app ? `AI · ${input.app}` : zh() ? 'AI 操作中' : 'AI';
      const show = () =>
        void win.webContents.executeJavaScript(`window.__show(${JSON.stringify(label)})`, false);
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show);
      else show();
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (!win.isDestroyed()) win.hide();
        current.destroyTimer = setTimeout(() => {
          if (windows.get(key) === current) drop(key);
        }, DESTROY_AFTER_MS);
      }, VISIBLE_MS + 400);
    },
    dispose() {
      for (const key of [...windows.keys()]) drop(key);
    },
  };
}
