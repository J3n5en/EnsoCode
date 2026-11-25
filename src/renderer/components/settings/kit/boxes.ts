/**
 * 「带框容器」的判定：设置页内容已经在主区那层卡片里，再出现就是卡片套卡片。
 * 只看无前缀的类名（hover:/dark: 等状态类不算画框）；控件自带的边框不算。
 */
const BORDER = /^border(?:-\d+|-\[[^\]]+\])?$/;
const ROUNDED = /^rounded(?:-(?!none$)[\w.[\]/-]+)?$/;
const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'KBD']);
const CONTROL_ROLES = new Set(['switch', 'radio', 'checkbox', 'combobox', 'textbox', 'button']);
const CARD_SLOTS = new Set(['card', 'frame']);

export function isBoxedClassName(className: string): boolean {
  const tokens = className.split(/\s+/).filter((token) => token && !token.includes(':'));
  if (tokens.includes('bg-card')) return true;
  return tokens.some((t) => BORDER.test(t)) && tokens.some((t) => ROUNDED.test(t));
}

function isBox(el: Element): boolean {
  const slot = el.getAttribute('data-slot');
  if (slot === 'settings-group') {
    return Boolean(
      el.parentElement?.closest('[data-slot="settings-group"], [data-settings-preview]')
    );
  }
  if (slot === 'settings-preview') {
    // Allowed standalone or in <SettingsSection bare>; forbidden inside another settings-group
    return Boolean(el.parentElement?.closest('[data-slot="settings-group"]'));
  }
  if (slot) return CARD_SLOTS.has(slot);
  if (CONTROL_TAGS.has(el.tagName.toUpperCase())) return false;
  if (CONTROL_ROLES.has(el.getAttribute('role') ?? '')) return false;
  return isBoxedClassName(el.getAttribute('class') ?? '');
}

/** 渲染出的设置页里所有带框容器；`data-settings-preview` 的预览对象本身放行，里面的框照算 */
export function findNestedBoxes(root: Element): Element[] {
  return [...root.querySelectorAll('*')].filter(
    (el) =>
      isBox(el) &&
      (el.getAttribute('data-slot') === 'settings-preview' ||
        !el.hasAttribute('data-settings-preview'))
  );
}

/** 源码里的带框类名字符串与 ui Card/Frame 用法计数 */
export function countBoxesInSource(source: string): number {
  let count =
    (source.match(/<(?:Card|Frame)[\s/>]/g)?.length ?? 0) +
    (source.match(/data-slot=["']settings-(?:group|preview)["']/g)?.length ?? 0);
  for (const match of source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
    if (isBoxedClassName(match[1] ?? match[2] ?? match[3] ?? '')) count++;
  }
  return count;
}
