import type { ModelProvider } from '@shared/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
