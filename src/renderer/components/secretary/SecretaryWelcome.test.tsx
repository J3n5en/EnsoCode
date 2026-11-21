import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  newSecretaryConversation: vi.fn(
    async (_options?: { greeting?: boolean; secretaryId?: string }) => 'conv-1'
  ),
  closeWelcome: vi.fn(),
  /** 欢迎页对着的秘书：单秘书时 Main 也接受省略，多秘书时必须带上 */
  store: {
    focusedId: null as string | null,
    secretaries: [] as { id: string; projectId: string; name: string | null }[],
  },
  saveProfile: vi.fn(
    async (
      _draft: Record<string, unknown>,
      _secretaryId?: string
    ): Promise<{ ok: true; profile: { name: string } } | { ok: false; error: string }> => ({
      ok: true,
      profile: { name: 'Secretary' },
    })
  ),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  useSecretaryStore: Object.assign(
    (selector: (state: typeof h.store) => unknown) => selector(h.store),
    {
      getState: () => ({
        ...h.store,
        newSecretaryConversation: h.newSecretaryConversation,
        closeWelcome: h.closeWelcome,
      }),
    }
  ),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (
    selector: (state: { projects: { id: string; name: string; path: string }[] }) => unknown
  ) => selector({ projects: [{ id: 'p1', name: 'enso', path: '/p/enso' }] }),
}));

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

const render = async () => {
  await act(async () => root.render(createElement(SecretaryWelcome)));
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
    h.store.focusedId = null;
    h.store.secretaries = [];
    container = window.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
    await render();
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
      visibleProjectIds: 'all',
      maxRunningDispatches: 3,
    });
    expect(h.newSecretaryConversation).toHaveBeenCalledTimes(1);
    expect(h.closeWelcome).toHaveBeenCalledTimes(1);
  });

  it('表单一页平铺：名字、头像、可见项目、并发上限与巡检都在，点开始写完整草案', async () => {
    await click('Set up with a form');
    for (const enso of [
      'secretary-form-name',
      'secretary-form-visible-mode',
      'secretary-form-max-running',
      'secretary-form-patrol',
    ])
      expect(container.querySelector(`[data-enso="${enso}"]`), enso).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-form-step"]')).toBeNull();
    expect(container.textContent).not.toContain('Next');
    expect(h.saveProfile).not.toHaveBeenCalled();

    await click('Start');
    expect(h.saveProfile).toHaveBeenCalledTimes(1);
    const draft = h.saveProfile.mock.calls[0]?.[0];
    expect(draft).toMatchObject({
      name: 'Secretary',
      maxRunningDispatches: 3,
      patrolEnabled: true,
    });
    expect(draft).not.toHaveProperty('autonomy');
    expect(draft).not.toHaveProperty('model');
    expect(h.newSecretaryConversation).toHaveBeenCalledWith();
    expect(h.closeWelcome).toHaveBeenCalledTimes(1);
  });

  it('写档案失败时留在欢迎页并给出原因', async () => {
    h.saveProfile.mockResolvedValueOnce({ ok: false, error: 'invalid name' });
    await click('Use all defaults and start');
    expect(container.textContent).toContain('invalid name');
    expect(h.newSecretaryConversation).not.toHaveBeenCalled();
    expect(h.closeWelcome).not.toHaveBeenCalled();
  });

  describe('第二个秘书', () => {
    beforeEach(async () => {
      h.store.focusedId = 's-2';
      h.store.secretaries = [
        { id: 'default', projectId: 'p-sec', name: 'Secretary' },
        { id: 's-2', projectId: 'p-sec-2', name: null },
      ];
      await render();
    });

    it('全部用默认：档案写给这个秘书、会话建在它名下，默认名避开第一个秘书', async () => {
      await click('Use all defaults and start');
      expect(h.saveProfile).toHaveBeenCalledTimes(1);
      const [draft, secretaryId] = h.saveProfile.mock.calls[0] ?? [];
      expect(secretaryId).toBe('s-2');
      expect(draft).toMatchObject({ name: 'Secretary 2' });
      expect(h.newSecretaryConversation).toHaveBeenCalledWith({ secretaryId: 's-2' });
      expect(h.closeWelcome).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.text-destructive')).toBeNull();
    });

    it('逐项设置：表单提交也写给这个秘书', async () => {
      await click('Set up with a form');
      await click('Start');
      expect(h.saveProfile.mock.calls[0]?.[1]).toBe('s-2');
      expect(h.newSecretaryConversation).toHaveBeenCalledWith({ secretaryId: 's-2' });
      expect(h.closeWelcome).toHaveBeenCalledTimes(1);
    });

    it('聊着设置：引导会话建在这个秘书名下', async () => {
      await click('Set up by chatting');
      expect(h.newSecretaryConversation).toHaveBeenCalledWith({
        greeting: true,
        secretaryId: 's-2',
      });
    });

    it('名字撞上别的秘书时说人话，不露错误码', async () => {
      h.saveProfile.mockResolvedValueOnce({ ok: false, error: 'name-taken' });
      await click('Use all defaults and start');
      expect(container.textContent).toContain('Another secretary already uses this name.');
      expect(container.textContent).not.toContain('name-taken');
    });
  });
});
