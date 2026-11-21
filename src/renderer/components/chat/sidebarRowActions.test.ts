import { describe, expect, it } from 'vitest';
import {
  GROUP_EDIT_BUTTON_CLASS,
  PROJECT_ROW_ACTION_CLASS,
  PROJECT_ROW_MENU_CLASS,
} from './sidebarRowActions';

const TOUCH = '[@media(hover:none)]:';
const tokens = (className: string) => className.split(/\s+/).filter(Boolean);
const desktop = (className: string) => tokens(className).filter((t) => !t.startsWith(TOUCH));
const touch = (className: string) =>
  tokens(className)
    .filter((t) => t.startsWith(TOUCH))
    .map((t) => t.slice(TOUCH.length));

describe('侧栏行尾悬停按钮', () => {
  it('分组行编辑按钮：桌面仍绝对定位盖在计数上、悬停才出现', () => {
    expect(desktop(GROUP_EDIT_BUTTON_CLASS)).toEqual(
      tokens(
        'absolute right-1.5 bottom-0.5 flex size-5 items-center justify-center rounded-[5px] opacity-0 transition-opacity hover:bg-foreground/5 hover:text-foreground group-hover:opacity-100'
      )
    );
  });

  it('分组行编辑按钮：触屏回到文档流排在计数旁，常显且点击区 32px', () => {
    const overrides = touch(GROUP_EDIT_BUTTON_CLASS);
    expect(overrides).toContain('static');
    expect(overrides).toContain('opacity-100');
    expect(overrides).toContain('size-[32px]');
  });

  it('项目行新建会话与更多菜单：桌面不变，触屏常显且点击区 32px', () => {
    expect(desktop(PROJECT_ROW_ACTION_CLASS)).toEqual(
      tokens(
        'shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100'
      )
    );
    expect(desktop(PROJECT_ROW_MENU_CLASS)).toEqual(
      tokens(
        'shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-popup-open:bg-muted data-popup-open:text-foreground data-popup-open:opacity-100'
      )
    );
    for (const className of [PROJECT_ROW_ACTION_CLASS, PROJECT_ROW_MENU_CLASS]) {
      const overrides = touch(className);
      expect(overrides).toContain('opacity-100');
      expect(overrides).toContain('size-[32px]');
      expect(overrides).not.toContain('absolute');
    }
  });
});
