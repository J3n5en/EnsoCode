/**
 * 抽屉画在壳页面里，主题要跟完整版走：从同源的 renderer 文档读当前主题变量，
 * 映射成抽屉自己的 --dd-*。读不到的项留给抽屉的明暗默认色。
 */
const SOURCES: Record<string, readonly string[]> = {
  '--dd-bg': ['--popover', '--background'],
  '--dd-fg': ['--popover-foreground', '--foreground'],
  '--dd-muted': ['--muted', '--accent'],
  '--dd-muted-fg': ['--muted-foreground'],
  '--dd-border': ['--border'],
  '--dd-primary': ['--primary'],
  '--dd-primary-fg': ['--primary-foreground'],
  '--dd-destructive': ['--destructive'],
  '--dd-success': ['--success'],
  '--dd-warning': ['--warning'],
  '--dd-ring': ['--ring'],
  '--dd-radius': ['--radius'],
  '--dd-font': ['--font-family-sans'],
};

export interface DeskTheme {
  dark: boolean;
  vars: Record<string, string>;
}

export function readDeskTheme(get: (name: string) => string, dark: boolean): DeskTheme {
  const vars: Record<string, string> = {};
  for (const [target, names] of Object.entries(SOURCES)) {
    for (const name of names) {
      const value = get(name).trim();
      if (!value) continue;
      vars[target] = value;
      break;
    }
  }
  return { dark, vars };
}

export function themeOfFrame(iframe: HTMLIFrameElement | undefined): DeskTheme | null {
  const doc = iframe?.contentDocument;
  const view = doc?.defaultView;
  if (!doc?.documentElement || !view) return null;
  const style = view.getComputedStyle(doc.documentElement);
  return readDeskTheme(
    (name) => style.getPropertyValue(name),
    doc.documentElement.classList.contains('dark')
  );
}

/** 主题切换改 html 的 class/style，或重写 head 里的主题样式表 */
export function watchFrameTheme(iframe: HTMLIFrameElement | undefined, onChange: () => void) {
  const doc = iframe?.contentDocument;
  if (!doc?.documentElement) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  if (doc.head) observer.observe(doc.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
