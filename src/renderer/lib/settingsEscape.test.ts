import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireOverlayGuard, resetOverlayGuard, setOverlayGuardSink } from './overlayGuard';
import { escapeBlockedBeforeHandlers, shouldEscapeCloseSettings } from './settingsEscape';

function dom(body: string) {
  const { document } = parseHTML(`<html><body>${body}</body></html>`);
  return document;
}

const esc = (
  target: Element,
  extra: Partial<{ defaultPrevented: boolean; isComposing: boolean; key: string }> = {}
) => ({
  key: 'Escape',
  defaultPrevented: false,
  isComposing: false,
  target,
  ...extra,
});

afterEach(() => resetOverlayGuard());

describe('设置页 Esc 返回工作区', () => {
  it('焦点在页面空白处按 Esc：返回', () => {
    const doc = dom('<main><button id="b">x</button></main>');
    expect(shouldEscapeCloseSettings(esc(doc.getElementById('b') as Element), false)).toBe(true);
  });

  it('焦点在输入框、文本域、下拉框、可编辑区：不返回', () => {
    const doc = dom(
      '<input id="i"><textarea id="t"></textarea><select id="s"></select><div id="c" contenteditable="true"></div>'
    );
    for (const id of ['i', 't', 's', 'c']) {
      expect(shouldEscapeCloseSettings(esc(doc.getElementById(id) as Element), false)).toBe(false);
    }
  });

  it('输入法组字中、别的处理者已经认领、非 Esc 键：不返回', () => {
    const target = dom('<div id="d"></div>').getElementById('d') as Element;
    expect(shouldEscapeCloseSettings(esc(target, { isComposing: true }), false)).toBe(false);
    expect(shouldEscapeCloseSettings(esc(target, { defaultPrevented: true }), false)).toBe(false);
    expect(shouldEscapeCloseSettings(esc(target, { key: 'Enter' }), false)).toBe(false);
  });

  it('按下时有弹层：这次 Esc 归弹层，即使它在处理中已经关掉', () => {
    const target = dom('<div id="d"></div>').getElementById('d') as Element;
    expect(shouldEscapeCloseSettings(esc(target), true)).toBe(false);
  });

  it('弹层判定：对话框、菜单浮层、overlay guard 都算；藏起来的工作区里的浮层不算', () => {
    expect(escapeBlockedBeforeHandlers(dom('<div role="dialog"></div>'))).toBe(true);
    expect(escapeBlockedBeforeHandlers(dom('<div role="alertdialog"></div>'))).toBe(true);
    expect(escapeBlockedBeforeHandlers(dom('<div data-enso-float=""></div>'))).toBe(true);
    expect(
      escapeBlockedBeforeHandlers(
        dom(
          '<div data-enso="workbench"><div data-enso-float=""></div><div role="dialog"></div></div>'
        )
      )
    ).toBe(false);
    expect(escapeBlockedBeforeHandlers(dom('<main></main>'))).toBe(false);
    setOverlayGuardSink(() => {});
    acquireOverlayGuard();
    expect(escapeBlockedBeforeHandlers(dom('<main></main>'))).toBe(true);
  });

  it('toast（aria-modal=false 的 role=dialog）不抢 Esc', () => {
    // base-ui Toast.Root 渲染 role=dialog + aria-modal=false，从不响应 Esc；
    // 装完插件的成功提示若在列，Esc 会被吞到 toast 消失为止
    expect(
      escapeBlockedBeforeHandlers(
        dom('<div data-slot="toast-viewport"><div role="dialog" aria-modal="false"></div></div>')
      )
    ).toBe(false);
  });

  it('已关闭还在退场动画里的弹层不抢 Esc', () => {
    // base-ui 的 open 翻 false 后 Esc 处理立刻短路，但节点要等 transitionend 才卸载；
    // 后台窗口动画不结束节点就一直挂着，不能让它永久吞掉 Esc
    expect(escapeBlockedBeforeHandlers(dom('<div role="dialog" data-closed=""></div>'))).toBe(
      false
    );
    expect(escapeBlockedBeforeHandlers(dom('<div role="dialog" data-ending-style=""></div>'))).toBe(
      false
    );
    expect(escapeBlockedBeforeHandlers(dom('<div data-enso-float="" data-closed=""></div>'))).toBe(
      false
    );
    // 正在进场的弹层仍然算
    expect(
      escapeBlockedBeforeHandlers(dom('<div role="dialog" data-starting-style=""></div>'))
    ).toBe(true);
    expect(escapeBlockedBeforeHandlers(dom('<div role="dialog" data-open=""></div>'))).toBe(true);
  });
});
