import { isStandalone } from './push';

/**
 * iOS 独立 PWA 偶发地把 WebView 铺到状态栏下面：正常时状态栏在页面外、
 * safe-area-inset-top 为 0；异常时页面铺满整屏、顶部安全区等于状态栏高度，
 * 系统顶部模糊直接盖住标题（`.phone-chat-root` 的固定实色层对此无效）。
 * 真机上切后台再回来会恢复，触发条件未知，所以运行时检测到才处理：去掉
 * viewport-fit=cover 让 WebView 退回状态栏之下，正常态保持原样。
 */

export interface ViewportGeometry {
  appleMobile: boolean;
  standalone: boolean;
  safeTop: number;
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
}

export function isStatusBarOverlap(g: ViewportGeometry): boolean {
  if (!g.appleMobile || !g.standalone || g.safeTop <= 0) return false;
  if (g.innerHeight <= g.innerWidth) return false;
  // 铺满整屏才算钻进状态栏；键盘弹起等场景视口变矮，不能误判
  return g.innerHeight >= Math.max(g.screenWidth, g.screenHeight) - 1;
}

export function stripViewportFitCover(content: string): string {
  return content
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^viewport-fit\s*=/i.test(part))
    .join(', ');
}

function isAppleMobile(): boolean {
  // iPadOS 默认桌面 UA，靠触控点区分
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function installStatusBarOverlapGuard(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || !isAppleMobile()) return;

  // env() 只能经计算样式读出
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);

  const check = () => {
    const style = getComputedStyle(probe);
    const overlapped = isStatusBarOverlap({
      appleMobile: true,
      standalone: isStandalone(),
      safeTop: Number.parseFloat(style.paddingTop) || 0,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
    });
    if (!overlapped) return;
    // 退出 cover 后 env(safe-area-inset-bottom) 归零，先把 home 条高度留给 pb-safe 兜底
    const safeBottom = Number.parseFloat(style.paddingBottom) || 0;
    document.documentElement.style.setProperty('--phone-safe-bottom', `${safeBottom}px`);
    meta.content = stripViewportFitCover(meta.content);
    window.removeEventListener('resize', check);
    document.removeEventListener('visibilitychange', check);
    probe.remove();
  };

  window.addEventListener('resize', check);
  document.addEventListener('visibilitychange', check);
  check();
}
