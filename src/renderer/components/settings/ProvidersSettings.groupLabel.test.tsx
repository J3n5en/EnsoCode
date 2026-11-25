import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ProvidersSettings 模块顶层会触到 window：先立 DOM 再加载
const dom = parseHTML('<html><body><div id="root"></div></body></html>');
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.document);

const { ProviderGroupLabel } = await import('./providerGroupLabel');

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}(${JSON.stringify(vars)})` : key,
  }),
}));

const doc = document as unknown as Document;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = doc.createElement('div');
  doc.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ProviderGroupLabel 分组标题里的条目计数', () => {
  it('计数和标题在同一行，带单位文案和次要色', async () => {
    await act(async () => {
      root.render(<ProviderGroupLabel label="Custom" count={3} />);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Custom');
    // 「{{count}} 个服务商」而非孤零零的数字
    expect(text).toContain('"count":3');
    expect(text).toContain('providers');
    const count = container.querySelector('span.text-muted-foreground, [class*="muted"]');
    expect(count).not.toBeNull();
  });

  it('单个条目也写明数量而不是省略', async () => {
    await act(async () => {
      root.render(<ProviderGroupLabel label="Anthropic" count={1} />);
    });
    expect(container.textContent ?? '').toContain('"count":1');
  });
});
