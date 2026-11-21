import type { ModelProvider } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderApiForm } from './ProviderApiForm';

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

const ERROR =
  'Header values can only contain tab and single-byte characters (no Chinese, newlines, or NUL).';

function saveButton(html: string): string {
  const matches = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const found = matches.find((button) => />Save<\/button>/.test(button));
  if (!found) throw new Error('Save button missing');
  return found;
}

function saveIsDisabled(html: string): boolean {
  const open = (saveButton(html).match(/^<button\b[^>]*>/)?.[0] ?? '').replace(
    / class="[^"]*"/g,
    ''
  );
  return /\sdisabled(?:=""|(?=[\s>]))/.test(open);
}

describe('ProviderApiForm 自定义请求头', () => {
  it('非法值阻止保存并显示错误', () => {
    const html = renderToStaticMarkup(
      <ProviderApiForm
        initialValue={{ ...provider, headers: { 'X-Title': 'Enso 编辑器' } }}
        oauth={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(html).toContain(ERROR);
    expect(saveIsDisabled(html)).toBe(true);
  });

  it('可发送的值允许保存且没有这条错误', () => {
    const html = renderToStaticMarkup(
      <ProviderApiForm
        initialValue={{ ...provider, headers: { 'X-Title': 'Enso' } }}
        oauth={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(html).not.toContain(ERROR);
    expect(saveIsDisabled(html)).toBe(false);
  });
});

describe('ProviderApiForm model refresh interval', () => {
  const selector = '[data-slot="provider-model-refresh-interval-hours"]';
  const autoFetchSelector = '[data-field="provider-auto-fetch-models"] [role="switch"]';
  let root: Root | undefined;

  function mountForm() {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('electronAPI', { providers: {} });
    const container = dom.document.getElementById('root');
    if (!container) throw new Error('Missing test root');
    root = createRoot(container);
    return { dom, container };
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
  });

  it.each([
    { hours: undefined, expected: '1' },
    { hours: 168, expected: '168' },
  ])('shows the saved interval or the one-hour default ($hours)', ({ hours, expected }) => {
    const html = renderToStaticMarkup(
      <ProviderApiForm
        initialValue={{ ...provider, modelRefreshIntervalHours: hours }}
        oauth={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const interval = parseHTML(html).document.querySelector<HTMLInputElement>(selector);
    expect(interval?.value).toBe(expected);
    expect(interval?.id).toBeTruthy();
    expect(html).toContain(`for="${interval?.id}"`);
    expect(saveIsDisabled(html)).toBe(false);
  });

  it.each([undefined, false, true])(
    'shows the saved auto-fetch state or defaults to off (%s)',
    (enabled) => {
      const html = renderToStaticMarkup(
        <ProviderApiForm
          initialValue={{ ...provider, autoFetchModels: enabled }}
          oauth={false}
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />
      );
      const { document } = parseHTML(html);
      const control = document.querySelector(autoFetchSelector);
      expect(control?.getAttribute('aria-checked')).toBe(String(enabled === true));
      expect(
        document.getElementById(control?.getAttribute('aria-labelledby') ?? '')?.textContent
      ).toBe('Automatically fetch models');
    }
  );

  it('does not render automatic fetching controls for OAuth providers', () => {
    const html = renderToStaticMarkup(
      <ProviderApiForm initialValue={provider} oauth onCancel={vi.fn()} onSave={vi.fn()} />
    );
    expect(html).not.toContain('provider-model-refresh-interval-hours');
    expect(html).not.toContain('provider-auto-fetch-models');
  });

  it('hides automatic fetching for a disabled provider', () => {
    const html = renderToStaticMarkup(
      <ProviderApiForm
        initialValue={{ ...provider, autoFetchModels: true }}
        providerEnabled={false}
        oauth={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(html).not.toContain('provider-auto-fetch-models');
    expect(html).not.toContain('provider-model-refresh-interval-hours');
  });

  it.each([
    { ok: true, text: 'Last fetched {{time}}' },
    { ok: false, text: 'Last fetch failed {{time}}' },
  ])('shows the latest automatic fetch result (ok: $ok)', ({ ok, text }) => {
    const render = (autoFetchModels: boolean) =>
      renderToStaticMarkup(
        <ProviderApiForm
          initialValue={{ ...provider, autoFetchModels }}
          modelRefreshStatus={{ ok, at: Date.now() }}
          oauth={false}
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />
      );
    const status = parseHTML(render(true)).document.querySelector(
      '[data-slot="provider-model-refresh-status"]'
    );
    expect(status?.textContent).toBe(text);
    expect(render(false)).not.toContain('provider-model-refresh-status');
  });

  it('announces invalid input, blocks save, and only submits a valid draft on save', async () => {
    const { dom, container } = mountForm();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    await act(async () =>
      root?.render(
        <ProviderApiForm
          initialValue={provider}
          oauth={false}
          onCancel={onCancel}
          onSave={onSave}
        />
      )
    );

    const interval = container.querySelector<HTMLInputElement>(selector);
    const buttons = Array.from(container.querySelectorAll('button'));
    const save = buttons.find((button) => button.textContent === 'Save');
    const cancel = buttons.find((button) => button.textContent === 'Cancel');
    if (!interval || !save || !cancel) throw new Error('Missing refresh interval controls');
    expect(interval.id).not.toBe('provider-model-refresh-interval-hours');
    expect(container.querySelector(`label[for="${interval.id}"]`)?.textContent).toBe(
      'Model fetch interval'
    );
    const enter = async (value: string) => {
      await act(async () => {
        interval.value = value;
        interval.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    for (const invalid of ['', '0', '1.5', '169']) {
      await enter(invalid);
      const error = container.querySelector('[role="alert"]');
      expect(interval.getAttribute('aria-invalid')).toBe('true');
      expect(interval.getAttribute('aria-describedby')).toBe(error?.id);
      expect(error?.textContent).toContain('Enter a whole number');
      expect(save.disabled).toBe(true);
    }
    await enter('168');
    expect(save.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ autoFetchModels: false, modelRefreshIntervalHours: 168 }),
      expect.any(Set)
    );
  });

  it('discards a toggled draft on cancel and submits it on save for a new API key', async () => {
    const { dom, container } = mountForm();
    vi.stubGlobal('PointerEvent', dom.window.Event);
    const onSave = vi.fn();
    const initialValue = { ...provider, models: [] };
    const render = (open: boolean) => {
      root?.render(
        open ? (
          <ProviderApiForm
            initialValue={initialValue}
            oauth={false}
            onCancel={() => render(false)}
            onSave={onSave}
          />
        ) : null
      );
    };
    const toggle = async () => {
      const control = container.querySelector<HTMLElement>(autoFetchSelector);
      const input = control?.parentElement?.querySelector<HTMLInputElement>('input[aria-hidden]');
      if (!control || !input) throw new Error('Missing auto-fetch switch');
      expect(control.getAttribute('aria-checked')).toBe('false');
      // linkedom 没有实现点击复选框时的默认切换行为。
      //
      // linkedom does not implement the default toggle when clicking a checkbox.
      input.addEventListener('click', () => {
        input.checked = !input.checked;
      });
      await act(async () => control.click());
      expect(control.getAttribute('aria-checked')).toBe('true');
    };
    const click = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find(
        (element) => element.textContent === label
      );
      if (!button) throw new Error(`Missing ${label} button`);
      await act(async () => button.click());
    };

    await act(async () => render(true));
    await toggle();
    await click('Cancel');
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector(autoFetchSelector)).toBeNull();

    await act(async () => render(true));
    await toggle();
    await click('Save');
    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ autoFetchModels: true, modelRefreshIntervalHours: 1 }),
      expect.any(Set)
    );
  });
});
