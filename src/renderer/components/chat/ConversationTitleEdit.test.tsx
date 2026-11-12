import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationTitleEdit } from './ConversationTitleEdit';

let root: Root;
let container: HTMLElement;
const onCommit = vi.fn();
const onCancel = vi.fn();

const press = (key: string, isComposing: boolean) =>
  act(async () => {
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing input');
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing } });
    input.dispatchEvent(event);
  });

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onCommit.mockReset();
  onCancel.mockReset();
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(ConversationTitleEdit, { title: 'Old title', onCommit, onCancel }))
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ConversationTitleEdit 输入法组字', () => {
  // 真实场景：macOS 中文输入法按回车确认候选词时，keydown 是 key=Enter、isComposing=true
  it('组字中按回车只是确认候选词，不结束编辑', async () => {
    await press('Enter', true);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('组字中按 Esc 只是取消候选词，不退出编辑', async () => {
    await press('Escape', true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('组字结束后按回车照常结束编辑', async () => {
    // 标题没改时回车按约定视为取消
    await press('Enter', false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
