import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  newSecretaryConversation: vi.fn(async (_options?: { greeting?: boolean }) => 'conv-1'),
  closeWelcome: vi.fn(),
  saveProfile: vi.fn(
    async (
      _draft: Record<string, unknown>
    ): Promise<{ ok: true; profile: { name: string } } | { ok: false; error: string }> => ({
      ok: true,
      profile: { name: 'Secretary' },
    })
  ),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: {
    getState: () => ({
      newSecretaryConversation: h.newSecretaryConversation,
      closeWelcome: h.closeWelcome,
    }),
  },
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (
    selector: (state: { projects: { id: string; name: string; path: string }[] }) => unknown
  ) => selector({ projects: [{ id: 'p1', name: 'enso', path: '/p/enso' }] }),
}));
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: '',
  ModelPicker: () => createElement('div', { 'data-enso': 'mock-model-picker' }),
}));
vi.mock('@/stores/modelDirectory/useProviders', () => ({ useUsableProviders: () => [] }));

const { SecretaryWelcome } = await import('./SecretaryWelcome');

let root: Root;
let container: HTMLElement;

const button = (text: string): HTMLElement => {
  const found = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.startsWith(text)
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found as unknown as HTMLElement;
};

const click = async (text: string) => {
  await act(async () => button(text).click());
};

describe('SecretaryWelcome', () => {
  beforeEach(async () => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(window, { electronAPI: { secretary: { saveProfile: h.saveProfile } } });
    h.newSecretaryConversation.mockClear();
    h.closeWelcome.mockClear();
    h.saveProfile.mockClear();
    container = window.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => root.render(createElement(SecretaryWelcome)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('先给两个入口，外加一条全部用默认的近路', () => {
    expect(container.querySelector('[data-enso="secretary-welcome"]')).not.toBeNull();
    expect(container.textContent).toContain('Set up your secretary');
    expect(button('Set up with a form')).toBeDefined();
    expect(button('Set up by chatting')).toBeDefined();
    expect(button('Use all defaults and start')).toBeDefined();
  });

  it('引导层盖满聊天区并自己铺实底：透明背景下面板色 alpha 为 0，不能靠 bg-background', () => {
    const overlay = container.querySelector('[data-enso="secretary-welcome"]') as HTMLElement;
    expect(overlay.className).toContain('absolute');
    expect(overlay.className).toContain('inset-0');
    // 实底取原始令牌 --background；bg-background 在 html.bg-image-enabled 下被重映射成全透
    expect(overlay.getAttribute('style')).toContain('var(--background)');
  });

  it('选「聊着设置」：建秘书会话并发引导语，然后让出主区域', async () => {
    await click('Set up by chatting');
    expect(h.newSecretaryConversation).toHaveBeenCalledWith({ greeting: true });
    expect(h.saveProfile).not.toHaveBeenCalled();
    expect(h.closeWelcome).toHaveBeenCalledTimes(1);
  });

  it('全部用默认：直接写默认档案，再建会话', async () => {
    await click('Use all defaults and start');
    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    expect(h.saveProfile.mock.calls[0]?.[0]).toMatchObject({
      name: 'Secretary',
      model: null,
      autonomy: 'ask-first',
      visibleProjectIds: 'all',
      dispatchWorktree: 'auto',
      maxRunningDispatches: 3,
    });
    expect(h.newSecretaryConversation).toHaveBeenCalledTimes(1);
    expect(h.closeWelcome).toHaveBeenCalledTimes(1);
  });

  it('表单三步走完才写档案，写的是完整草案', async () => {
    await click('Set up with a form');
    expect(container.querySelector('[data-enso="secretary-form-name"]')).not.toBeNull();

    await click('Next');
    expect(container.querySelector('[data-enso="mock-model-picker"]')).not.toBeNull();

    await click('Next');
    expect(container.querySelector('[data-enso="secretary-form-autonomy"]')).not.toBeNull();
    expect(h.saveProfile).not.toHaveBeenCalled();

    await click('Start');
    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    expect(h.saveProfile.mock.calls[0]?.[0]).toMatchObject({
      name: 'Secretary',
      autonomy: 'ask-first',
      maxRunningDispatches: 3,
    });
    expect(h.newSecretaryConversation).toHaveBeenCalledTimes(1);
    expect(h.closeWelcome).toHaveBeenCalledTimes(1);
  });

  it('写档案失败时留在欢迎页并给出原因', async () => {
    h.saveProfile.mockResolvedValueOnce({ ok: false, error: 'invalid name' });
    await click('Use all defaults and start');
    expect(container.textContent).toContain('invalid name');
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
    expect(h.closeWelcome).not.toHaveBeenCalled();
  });
});
