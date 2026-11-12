import type { OauthFlowLocator } from '@shared/oauthFlow';
import type { OauthLoginPrompt } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OauthLoginStep } from './OauthLoginStep';
import type { OauthLoginFlow } from './useOauthLoginFlow';

// t 保持稳定引用，与真实 useI18n 的 useCallback 一致
const i18n = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));
// linkedom 下受控 input 的 onChange 不触发，换成原生 input 并把 onChange 接到 input 事件；
// 不透传 type：react-dom 先于 linkedom 的 window 加载会启用旧版 input polyfill，type=text 上的 keydown 会崩
vi.mock('@/components/ui/input', () => ({
  Input: ({ onChange, type: _type, ...props }: ComponentProps<'input'>) =>
    createElement('input', { ...props, onInput: onChange }),
}));

const locator: OauthFlowLocator = {
  flowId: '11111111-1111-4111-8111-111111111111',
  host: 'provider-wizard',
  ownerWebContentsId: 7,
};
// 与 Qoder 扩展实际发出的 PAT 提示一致
const qoderPrompt: OauthLoginPrompt = {
  requestId: 'qoder-pat',
  type: 'text',
  message: 'Paste a Qoder Personal Access Token (pt-...), or leave empty for browser login',
  placeholder: 'pt-...',
  allowEmpty: true,
};

let root: Root;
let container: HTMLElement;
const respond = vi.fn<OauthLoginFlow['respond']>();
const mount = (prompt: OauthLoginPrompt) => {
  const flow: OauthLoginFlow = {
    state: {
      phase: 'running',
      providerId: 'qoder',
      binding: locator,
      locator,
      progress: null,
      authUrl: null,
      userCode: null,
      prompt,
    },
    attach: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    reopen: vi.fn(),
    respond,
    reset: vi.fn(),
  };
  return act(async () =>
    root.render(createElement(OauthLoginStep, { flow, providerLabel: 'Qoder' }))
  );
};
const submitButton = () => {
  const button = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === 'Submit'
  );
  if (!button) throw new Error('Missing Submit');
  return button;
};
const pressEnter = () =>
  act(async () => {
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing prompt input');
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: 'Enter' }, isComposing: { value: false } });
    input.dispatchEvent(event);
  });

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  respond.mockReset();
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('OauthLoginStep 留空提交', () => {
  // 真实场景：Qoder 提示「粘贴 PAT，或留空走浏览器登录」，空值时提交按钮被禁用，用户只能贴 PAT
  it('声明 allowEmpty 的提示不填内容也能提交，空值交给登录流程', async () => {
    await mount(qoderPrompt);
    await act(async () => submitButton().click());
    expect(respond.mock.calls).toEqual([['qoder-pat', '']]);
  });

  // 反例：未声明 allowEmpty 的提示（如授权码）留空提交毫无意义，按钮与回车都不能把空值发出去
  it('未声明 allowEmpty 的提示留空时按钮禁用，回车也不提交', async () => {
    const { allowEmpty: _allowEmpty, ...codePrompt } = {
      ...qoderPrompt,
      requestId: 'auth-code',
      message: 'Paste the authorization code',
    };
    await mount(codePrompt);
    expect(submitButton().disabled).toBe(true);
    await act(async () => submitButton().click());
    await pressEnter();
    expect(respond).not.toHaveBeenCalled();
  });
});
