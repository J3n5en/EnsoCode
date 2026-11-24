import type { ModelProvider, ProviderApiConfig } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderApiForm, type ProviderApiFormValue } from './ProviderApiForm';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const provider: ModelProvider = {
  id: 'chat',
  name: 'Chat provider',
  api: 'openai-completions',
  apiKey: 'test-key',
  baseUrl: 'https://example.com/v1',
  enabled: true,
  models: [{ id: 'chat-model', enabled: true }],
};

const ERROR = 'Enter an http(s) proxy URL';

describe('ProviderApiForm 独立代理（静态渲染）', () => {
  const render = (value: Partial<ProviderApiFormValue>, oauth = false) =>
    renderToStaticMarkup(
      <ProviderApiForm
        initialValue={{ ...provider, ...value }}
        oauth={oauth}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );

  it('默认跟随全局且高级区折叠', () => {
    const html = render({});
    expect(html).not.toContain('provider-proxy-mode');
  });

  it.each([
    [{ mode: 'none' as const }, 'All requests to this provider connect directly'],
    [
      { mode: 'custom' as const, url: 'http://127.0.0.1:7890' },
      'All requests to this provider go through this proxy.',
    ],
  ])('已配置独立代理 %j 时高级区默认展开并显示当前模式', (proxy, hint) => {
    const html = render({ proxy });
    const { document } = parseHTML(html);
    expect(document.querySelector('[data-slot="provider-proxy-mode"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="provider-proxy-hint"]')?.textContent).toContain(
      hint
    );
    const url = document.querySelector<HTMLInputElement>('[data-slot="provider-proxy-url"]');
    if (proxy.mode === 'custom') expect(url?.value).toBe(proxy.url);
    else expect(url).toBeNull();
    expect(html).not.toContain(ERROR);
  });

  it('OAuth 条目不显示代理设置', () => {
    expect(render({ proxy: { mode: 'none' } }, true)).not.toContain('provider-proxy');
  });

  it('带账密的代理地址默认按密码框遮住，不带账密的照常显示', () => {
    const input = (url: string) =>
      parseHTML(render({ proxy: { mode: 'custom', url } })).document.querySelector(
        '[data-slot="provider-proxy-url"]'
      );
    expect(input('http://user:secret@127.0.0.1:7890')?.getAttribute('type')).toBe('password');
    expect(input('http://127.0.0.1:7890')?.getAttribute('type')).toBe('text');
  });
});

describe('ProviderApiForm 独立代理（交互）', () => {
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
  });

  async function mount(initial: Partial<ProviderApiFormValue>) {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const providers = {
      test: vi.fn(async (_config: ProviderApiConfig, _model?: string) => ({
        ok: true,
        latencyMs: 5,
        message: 'chat-model',
      })),
      listModels: vi.fn(async (_config: ProviderApiConfig) => ({
        ok: true,
        models: [{ id: 'fetched' }],
      })),
    };
    vi.stubGlobal('electronAPI', { providers });
    const container = dom.document.getElementById('root');
    if (!container) throw new Error('Missing test root');
    root = createRoot(container);
    const onSave = vi.fn();
    await act(async () =>
      root?.render(
        <ProviderApiForm
          initialValue={{ ...provider, ...initial }}
          oauth={false}
          onCancel={vi.fn()}
          onSave={onSave}
        />
      )
    );
    const button = (label: string) => {
      const found = [...container.querySelectorAll('button')].find((element) =>
        element.textContent?.includes(label)
      );
      if (!found) throw new Error(`Missing ${label} button`);
      return found as HTMLButtonElement;
    };
    const click = (label: string) => act(async () => button(label).click());
    const typeUrl = async (value: string) => {
      const input = container.querySelector<HTMLInputElement>('[data-slot="provider-proxy-url"]');
      if (!input) throw new Error('Missing proxy URL input');
      await act(async () => {
        input.value = value;
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    return { container, providers, onSave, button, click, typeUrl };
  }

  it('非法自定义地址阻止保存、测试与拉取模型，并显示错误', async () => {
    const ui = await mount({ proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' } });
    await ui.typeUrl('socks5://127.0.0.1:1080');
    const alert = ui.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(ERROR);
    const input = ui.container.querySelector('[data-slot="provider-proxy-url"]');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe(alert?.id);
    expect(ui.button('Save').disabled).toBe(true);

    await ui.click('Test connection');
    await ui.click('Fetch models');
    expect(ui.providers.test).not.toHaveBeenCalled();
    expect(ui.providers.listModels).not.toHaveBeenCalled();
    expect(ui.container.textContent).toContain(ERROR);

    await ui.click('Save');
    expect(ui.onSave).not.toHaveBeenCalled();
  });

  it('测试、拉模型与保存实时使用草稿里的代理，无需先保存', async () => {
    const ui = await mount({ proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' } });
    await ui.typeUrl(' http://user:pw@10.0.0.9:3128 ');
    const draft = { mode: 'custom', url: 'http://user:pw@10.0.0.9:3128' };
    expect(ui.button('Save').disabled).toBe(false);

    await ui.click('Test connection');
    expect(ui.providers.test).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: draft }),
      'chat-model'
    );
    await ui.click('Fetch models');
    expect(ui.providers.listModels).toHaveBeenCalledWith(expect.objectContaining({ proxy: draft }));
    await ui.click('Save');
    expect(ui.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: draft }),
      expect.any(Set)
    );
  });

  it('带账密的代理地址可点眼睛显示明文', async () => {
    const ui = await mount({ proxy: { mode: 'custom', url: 'http://user:secret@127.0.0.1:7890' } });
    const input = () => ui.container.querySelector('[data-slot="provider-proxy-url"]');
    expect(input()?.getAttribute('type')).toBe('password');
    const reveal = ui.container.querySelector<HTMLButtonElement>('[aria-label="Show proxy URL"]');
    await act(async () => reveal?.click());
    expect(input()?.getAttribute('type')).toBe('text');
  });

  it.each([
    [{ mode: 'none' as const }, { mode: 'none' }],
    [undefined, undefined],
  ])('保存透传直连 / 跟随全局（%j）', async (initial, expected) => {
    const ui = await mount({ proxy: initial });
    await ui.click('Test connection');
    const config = ui.providers.test.mock.calls[0]?.[0];
    if (expected) expect(config?.proxy).toEqual(expected);
    else expect(config).not.toHaveProperty('proxy');
    await ui.click('Save');
    expect(ui.onSave.mock.calls[0]?.[0].proxy).toEqual(expected);
  });
});
