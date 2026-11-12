import { shell, type WebContents } from 'electron';

function decodePath(pathname: string): string | null {
  try {
    // Chromium 会把 file URL 的盘符规范成大写，pathToFileURL 则保留原样
    return decodeURIComponent(pathname).replace(/^\/([a-z]):/, (_, drive: string) => {
      return `/${drive.toUpperCase()}:`;
    });
  } catch {
    return null;
  }
}

/**
 * 应用页面带完整 preload（window.electronAPI）：主 frame 一旦被页面里的链接带去别处，
 * 对方页面就拿到全部 IPC 出口，所以只放行回到本应用自身页面的导航。
 * 「本应用」以窗口初次加载的地址为准：dev server 按 origin；file:// 没有可比的 origin，
 * 按初次加载的文件所在目录（out/renderer/）划边界。
 */
export function isAppNavigationAllowed(target: string, appUrl: string): boolean {
  let to: URL;
  let app: URL;
  try {
    to = new URL(target);
    app = new URL(appUrl);
  } catch {
    return false;
  }
  // 协议必须一致：同源的 blob: / data: 也不是应用页面
  if (to.protocol !== app.protocol) return false;
  if (app.protocol !== 'file:') return app.origin !== 'null' && to.origin === app.origin;
  if (to.host !== app.host) return false;
  // 编码过的路径分隔符在转成磁盘路径时可能被还原成目录跳转
  if (/%2f|%5c/i.test(to.pathname)) return false;
  // URL 解析已消掉字面量与 %2e 形式的 ..；两边都解码后比较，规避编码差异
  const root = decodePath(app.pathname.slice(0, app.pathname.lastIndexOf('/') + 1));
  const path = decodePath(to.pathname);
  if (root === null || path === null) return false;
  return path.startsWith(root);
}

/** 子 frame 另外放行 srcdoc / 空白页：插件页面与产物预览靠 srcdoc iframe 承载 */
export function isAppFrameNavigationAllowed(target: string, appUrl: string): boolean {
  return (
    target === 'about:srcdoc' || target === 'about:blank' || isAppNavigationAllowed(target, appUrl)
  );
}

/** 与 setWindowOpenHandler 相同：只把 http(s) 交给系统浏览器 */
export function openExternalWebUrl(url: string): void {
  if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url);
}

/**
 * 挂在加载应用页面的 webContents 上，只拦页面自己发起的跳转（链接点击、location 赋值、iframe src）。
 * hash 变化与 Main 侧 loadURL / reload 不触发这些事件；页面内 location.reload() 会触发，
 * 目标仍是本页，照常放行。
 */
export function attachAppNavigationGuard(contents: WebContents, appUrl: string): void {
  contents.on('will-navigate', (event) => {
    if (isAppNavigationAllowed(event.url, appUrl)) return;
    event.preventDefault();
    openExternalWebUrl(event.url);
  });
  // dev server 下同源 302 只走 will-redirect，不走 will-navigate。主 frame 与 will-navigate 同一策略
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame) return;
    if (isAppNavigationAllowed(event.url, appUrl)) return;
    event.preventDefault();
    openExternalWebUrl(event.url);
  });
  contents.on('will-frame-navigate', (event) => {
    // 主 frame 交给 will-navigate；子 frame 的内容可能是插件脚本，拦下但不替它打开浏览器
    if (event.isMainFrame) return;
    if (!isAppFrameNavigationAllowed(event.url, appUrl)) event.preventDefault();
  });
}
