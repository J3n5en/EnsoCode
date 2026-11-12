import { shell, type WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachAppNavigationGuard,
  isAppFrameNavigationAllowed,
  isAppNavigationAllowed,
} from './appNavigation';

const DEV = 'http://localhost:5173/index.html';
const PROD =
  'file:///Applications/EnsoCode.app/Contents/Resources/app.asar/out/renderer/index.html';
const RENDERER = 'file:///Applications/EnsoCode.app/Contents/Resources/app.asar/out/renderer';

describe('isAppNavigationAllowed 开发期（dev server）', () => {
  it('同源的应用页面放行，包括带 query / hash 的地址', () => {
    expect(isAppNavigationAllowed('http://localhost:5173/index.html', DEV)).toBe(true);
    expect(isAppNavigationAllowed('http://localhost:5173/settings.html?tab=a#b', DEV)).toBe(true);
  });

  it('外站、同主机不同端口都拒绝', () => {
    expect(isAppNavigationAllowed('https://evil.example/', DEV)).toBe(false);
    expect(isAppNavigationAllowed('http://localhost:5174/index.html', DEV)).toBe(false);
    expect(isAppNavigationAllowed('https://localhost:5173/index.html', DEV)).toBe(false);
  });

  it('同源的 blob: 也不放行：主 frame 不该被带去任何非应用页面', () => {
    expect(isAppNavigationAllowed('blob:http://localhost:5173/0f8b7a9e', DEV)).toBe(false);
  });
});

describe('isAppNavigationAllowed 生产（file://）', () => {
  it('renderer 目录内的页面放行（reload、其它入口、插件壳页面）', () => {
    expect(isAppNavigationAllowed(PROD, PROD)).toBe(true);
    expect(isAppNavigationAllowed(`${RENDERER}/settings.html`, PROD)).toBe(true);
    expect(isAppNavigationAllowed(`${RENDERER}/plugin-view.html`, PROD)).toBe(true);
    expect(isAppNavigationAllowed(`${RENDERER}/assets/page.html?x=1#y`, PROD)).toBe(true);
  });

  it('用 .. 或编码过的 .. 跳出 renderer 目录时拒绝', () => {
    expect(isAppNavigationAllowed(`${RENDERER}/../main/index.js`, PROD)).toBe(false);
    expect(isAppNavigationAllowed(`${RENDERER}/%2e%2e/main/index.js`, PROD)).toBe(false);
    expect(isAppNavigationAllowed(`${RENDERER}/..%2f..%2fetc/passwd`, PROD)).toBe(false);
    expect(isAppNavigationAllowed(`${RENDERER}/..%5c..%5cetc/passwd`, PROD)).toBe(false);
  });

  it('前缀相同的兄弟目录、其它主机、任意本地文件都拒绝', () => {
    expect(
      isAppNavigationAllowed(
        'file:///Applications/EnsoCode.app/Contents/Resources/app.asar/out/renderer-evil/index.html',
        PROD
      )
    ).toBe(false);
    expect(
      isAppNavigationAllowed(
        'file://server/Applications/EnsoCode.app/Contents/Resources/app.asar/out/renderer/index.html',
        PROD
      )
    ).toBe(false);
    expect(isAppNavigationAllowed('file:///etc/passwd', PROD)).toBe(false);
  });

  it('目录名的百分号编码差异不影响判定', () => {
    // pathToFileURL 与 Chromium 对个别字符是否编码不完全一致
    const app = 'file:///Users/me/Enso%20Code%5B1%5D/out/renderer/index.html';
    expect(isAppNavigationAllowed('file:///Users/me/Enso%20Code[1]/out/renderer/x.html', app)).toBe(
      true
    );
  });

  it('Windows 盘符大小写不同仍视为同一目录', () => {
    // Chromium 规范化 file URL 时把盘符转成大写
    const app = 'file:///c:/Program%20Files/Enso/resources/app.asar/out/renderer/index.html';
    expect(
      isAppNavigationAllowed(
        'file:///C:/Program%20Files/Enso/resources/app.asar/out/renderer/plugin-view.html',
        app
      )
    ).toBe(true);
  });
});

describe('isAppNavigationAllowed 危险协议与坏输入', () => {
  it('javascript: / data: / about: / 外站一律拒绝', () => {
    for (const app of [DEV, PROD]) {
      expect(isAppNavigationAllowed('javascript:alert(1)', app)).toBe(false);
      expect(isAppNavigationAllowed('data:text/html,<script>1</script>', app)).toBe(false);
      expect(isAppNavigationAllowed('about:blank', app)).toBe(false);
      expect(isAppNavigationAllowed('https://evil.example/index.html', app)).toBe(false);
    }
  });

  it('无法解析的地址拒绝', () => {
    expect(isAppNavigationAllowed('not a url', PROD)).toBe(false);
    expect(isAppNavigationAllowed(`${RENDERER}/%E0%A4%A.html`, PROD)).toBe(false);
    expect(isAppNavigationAllowed(PROD, 'not a url')).toBe(false);
  });
});

describe('isAppFrameNavigationAllowed 子 frame', () => {
  it('插件壳页面与 srcdoc 预览放行', () => {
    expect(isAppFrameNavigationAllowed(`${RENDERER}/plugin-view.html`, PROD)).toBe(true);
    expect(isAppFrameNavigationAllowed('about:srcdoc', PROD)).toBe(true);
    expect(isAppFrameNavigationAllowed('about:blank', PROD)).toBe(true);
  });

  it('外站和 data: 仍然拒绝', () => {
    expect(isAppFrameNavigationAllowed('https://evil.example/', PROD)).toBe(false);
    expect(isAppFrameNavigationAllowed('data:text/html,hi', PROD)).toBe(false);
  });
});

type Listener = (event: Record<string, unknown>) => void;
function fakeContents() {
  const listeners = new Map<string, Listener>();
  const contents = {
    on: (name: string, listener: Listener) => {
      listeners.set(name, listener);
      return contents;
    },
  };
  const fire = (name: string, event: Record<string, unknown>) => {
    const preventDefault = vi.fn();
    listeners.get(name)?.({ preventDefault, ...event });
    return preventDefault;
  };
  return { contents: contents as unknown as WebContents, fire };
}

describe('attachAppNavigationGuard', () => {
  afterEach(() => vi.restoreAllMocks());

  // 真实场景：Mermaid 节点 click 生成不带 target 的 <a xlink:href>，点击即主 frame 同窗跳外站，
  // 外站页面拿到完整的 window.electronAPI
  it('主 frame 被链接带去外站时拦下，并交给系统浏览器打开', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, PROD);
    const prevented = fire('will-navigate', { url: 'https://evil.example/x', isMainFrame: true });
    expect(prevented).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('https://evil.example/x');
  });

  it('主 frame 回到应用自身页面不拦', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, PROD);
    expect(fire('will-navigate', { url: PROD, isMainFrame: true })).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('非 http(s) 的跳转只拦不打开', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, PROD);
    expect(
      fire('will-navigate', { url: 'file:///etc/passwd', isMainFrame: true })
    ).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('子 frame 去外站被拦下，且不替它打开浏览器', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, PROD);
    expect(
      fire('will-frame-navigate', { url: 'https://evil.example/', isMainFrame: false })
    ).toHaveBeenCalled();
    expect(
      fire('will-frame-navigate', { url: 'about:srcdoc', isMainFrame: false })
    ).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  // dev server 下同源 302 走 will-redirect，不走 will-navigate
  it('主 frame 被重定向到外站时拦下，并交给系统浏览器', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, DEV);
    const prevented = fire('will-redirect', {
      url: 'https://evil.example/phish',
      isMainFrame: true,
    });
    expect(prevented).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('https://evil.example/phish');
  });

  it('主 frame 重定向回应用自身不拦', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, DEV);
    expect(
      fire('will-redirect', { url: 'http://localhost:5173/index.html', isMainFrame: true })
    ).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('主 frame 重定向到非 http(s) 只拦不打开', () => {
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue();
    const { contents, fire } = fakeContents();
    attachAppNavigationGuard(contents, DEV);
    expect(
      fire('will-redirect', { url: 'file:///etc/passwd', isMainFrame: true })
    ).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
