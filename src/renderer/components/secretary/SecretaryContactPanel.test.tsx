import type { SecretaryContactState } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
  }),
}));
vi.mock('@/plugins/PluginIcon', () => ({ PluginIcon: () => null }));
vi.mock('@/plugins/PluginView', () => ({ PluginFrame: () => null }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => '' } }));
vi.mock('@/components/ui/switch', () => ({ Switch: () => null }));

const { SecretaryContactPanel } = await import('./SecretaryContactPanel');

function contactState(groups: SecretaryContactState['telegram']['groups']): SecretaryContactState {
  const caps = {
    buttons: true,
    urlButtons: true,
    edit: true,
    typing: true,
    format: 'html' as const,
    maxChars: 4096,
    commandMenu: true,
    images: true,
    files: true,
  };
  return {
    enabled: true,
    channels: [
      {
        id: 'telegram',
        title: 'Telegram',
        builtin: true,
        status: 'connected',
        caps,
        prefs: { enabled: true, push: true, cardConfirm: true, syncMirror: false, memory: false },
      },
    ],
    telegram: {
      status: 'bound',
      chat: { id: 777, username: 'j3n5en' },
      bot: { id: 42, username: 'enso_bot', name: 'Enso' },
      allowCardConfirm: true,
      allowMemory: false,
      syncMirror: false,
      groups,
      following: [],
      poll: { state: 'running' },
      secure: true,
    },
  };
}

let root: Root;
let container: HTMLElement;
let state: SecretaryContactState;
let contactSettings: ReturnType<typeof vi.fn>;
let contactTest: ReturnType<typeof vi.fn>;
let contactTelegramTopics: ReturnType<typeof vi.fn>;
let pushState: (next: SecretaryContactState) => void;

const groupsBox = () => container.querySelector('[data-enso="secretary-contact-groups"]');
const addButton = () =>
  container.querySelector('[data-enso="secretary-contact-group-add"]') as HTMLButtonElement;

async function render(secretaryId?: string): Promise<void> {
  await act(async () => {
    root.render(<SecretaryContactPanel secretaryId={secretaryId} />);
  });
}

async function typeAndAdd(value: string): Promise<void> {
  const input = container.querySelector(
    '[data-enso="secretary-contact-group-input"]'
  ) as HTMLInputElement;
  await act(async () => {
    // linkedom 里 React 收不到 input 事件：直接调节点上的 onChange
    const key = Object.keys(input).find((name) => name.startsWith('__reactProps'));
    const props = (key ? (input as unknown as Record<string, unknown>)[key] : null) as {
      onChange?: (event: { target: { value: string } }) => void;
    } | null;
    props?.onChange?.({ target: { value } });
  });
  await act(async () => {
    input.closest('form')?.dispatchEvent(new window.Event('submit', { bubbles: true }));
  });
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state = contactState([]);
  contactSettings = vi.fn(async () => ({ ok: true }));
  contactTest = vi.fn(async () => ({ ok: true }));
  contactTelegramTopics = vi.fn(async () => ({ ok: true, forum: false, topics: [] }));
  pushState = () => {};
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      list: async () => [],
      onListChanged: () => () => {},
      contactState: vi.fn(async () => state),
      onContactChanged: vi.fn((callback: (next: SecretaryContactState) => void) => {
        pushState = callback;
        return () => {};
      }),
      contactSettings,
      contactTest,
      contactTelegramTopics,
    },
    extensionPlugins: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const UNREACHABLE = 'Cannot reach api.telegram.org. Check the proxy.';
const errorBanner = () =>
  container.querySelector('[data-enso="secretary-contact-error"]')?.textContent ?? null;

function withPoll(poll: SecretaryContactState['telegram']['poll']): SecretaryContactState {
  const next = contactState([]);
  return { ...next, telegram: { ...next.telegram, poll } };
}

/** Main 推一次新状态；load() 之后读到的也是它 */
async function publish(next: SecretaryContactState): Promise<void> {
  state = next;
  await act(async () => pushState(next));
}

describe('连不上 api.telegram.org 提示', () => {
  it('轮询失败显示；随后成功隐藏；再失败再显示', async () => {
    await render();
    expect(errorBanner()).toBeNull();
    await publish(withPoll({ state: 'backoff', lastError: 'fetch failed' }));
    expect(errorBanner()).toContain(UNREACHABLE);
    await publish(withPoll({ state: 'running' }));
    expect(errorBanner()).toBeNull();
    await publish(withPoll({ state: 'backoff', lastError: 'fetch failed' }));
    expect(errorBanner()).toContain(UNREACHABLE);
  });

  it('测试消息连不上后，轮询恢复即隐藏，不靠再点一次按钮', async () => {
    await render();
    contactTest.mockImplementationOnce(async () => {
      await publish(withPoll({ state: 'backoff', lastError: 'fetch failed' }));
      return { ok: false, error: 'network' };
    });
    await act(async () => {
      (
        container.querySelector('[data-enso="secretary-contact-test"]') as HTMLButtonElement
      ).click();
    });
    expect(errorBanner()).toContain(UNREACHABLE);

    await publish(withPoll({ state: 'running' }));
    expect(errorBanner()).toBeNull();

    await publish(withPoll({ state: 'backoff', lastError: 'fetch failed' }));
    expect(errorBanner()).toContain(UNREACHABLE);
  });

  it('轮询没在跑（比如还没绑定）时，动作连不上照常显示', async () => {
    state = withPoll({ state: 'stopped' });
    await render();
    contactTest.mockResolvedValueOnce({ ok: false, error: 'network' });
    await act(async () => {
      (
        container.querySelector('[data-enso="secretary-contact-test"]') as HTMLButtonElement
      ).click();
    });
    expect(errorBanner()).toContain(UNREACHABLE);
  });
});

describe('Telegram 群白名单', () => {
  it('空名单：说明只认绑定账号，并提示群消息一律不收', async () => {
    await render();
    const text = groupsBox()?.textContent ?? '';
    expect(text).toContain('only messages from the bound account count');
    expect(text).toContain('No groups yet: group messages are not received.');
    expect(addButton().disabled).toBe(true);
  });

  it('见过的群显示标题与 id，没见过只显示 id', async () => {
    state = contactState([
      { id: '-1001', title: 'Dev 群', all: true, topics: [] },
      { id: '-1002', all: true, topics: [] },
    ]);
    await render();
    const rows = [...container.querySelectorAll('[data-enso="secretary-contact-group"]')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      'Dev 群 -1001· Whole group',
      '-1002· Whole group',
    ]);
  });

  it('添加做 trim，空白与重复的不发；删除带原 id', async () => {
    state = contactState([{ id: '-1001', all: true, topics: [] }]);
    await render();
    await typeAndAdd('   ');
    await typeAndAdd(' -1001 ');
    expect(contactSettings).not.toHaveBeenCalled();
    await typeAndAdd('  -1002  ');
    expect(contactSettings).toHaveBeenCalledWith(
      {
        telegramGroup: { action: 'add', chatId: '-1002' },
      },
      undefined
    );
    const remove = container.querySelector(
      '[data-enso="secretary-contact-group-remove"]'
    ) as HTMLButtonElement;
    await act(async () => {
      remove.click();
    });
    expect(contactSettings).toHaveBeenLastCalledWith(
      {
        telegramGroup: { action: 'remove', chatId: '-1001' },
      },
      undefined
    );
  });
});

describe('Telegram 群的论坛话题', () => {
  const click = async (selector: string, index = 0) => {
    const target = container.querySelectorAll(selector)[index] as HTMLButtonElement | undefined;
    if (!target) throw new Error(`missing ${selector}`);
    await act(async () => {
      target.click();
    });
  };
  const scopeText = () =>
    [...container.querySelectorAll('[data-enso="secretary-contact-group-scope"]')].map((node) =>
      node.textContent?.trim()
    );

  it('已绑定的是某几个话题时逐个列出，General 单独标出', async () => {
    state = contactState([
      {
        id: '-1001',
        title: 'EnsoCode 交流群',
        all: false,
        topics: [{ id: '3', title: '插件开发' }, { id: '1' }, { id: '9' }],
      },
    ]);
    await render('sec-b');
    expect(scopeText()).toEqual(['· Topics: 插件开发, General (default topic), Topic #9']);
  });

  it('拉话题失败给出原因与重试；重试成功后勾选话题保存', async () => {
    state = contactState([{ id: '-1001', title: 'EnsoCode 交流群', all: true, topics: [] }]);
    contactTelegramTopics.mockResolvedValueOnce({
      ok: false,
      error: 'api',
      detail: 'Bad Request: chat not found',
    });
    await render('sec-b');
    await click('[data-enso="secretary-contact-group-topics"]');
    expect(contactTelegramTopics).toHaveBeenCalledWith('-1001', 'sec-b');
    const error = container.querySelector('[data-enso="secretary-contact-topics-error"]');
    expect(error?.textContent).toContain('Bad Request: chat not found');
    expect(error?.textContent).toContain('Make sure the bot is in this group.');

    contactTelegramTopics.mockResolvedValueOnce({
      ok: true,
      forum: true,
      topics: [{ id: '1' }, { id: '3', title: '插件开发' }, { id: '7', title: '问题反馈' }],
    });
    await click('[data-enso="secretary-contact-topics-retry"]');
    expect(contactTelegramTopics).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-enso="secretary-contact-topics-error"]')).toBeNull();

    await click('[data-enso="secretary-contact-scope-topics"]');
    const save = () =>
      container.querySelector('[data-enso="secretary-contact-scope-save"]') as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    const labels = [...container.querySelectorAll('[data-enso="secretary-contact-topic"]')].map(
      (node) => node.textContent?.trim()
    );
    expect(labels).toEqual(['General (default topic)', '插件开发', '问题反馈']);
    await click('[data-enso="secretary-contact-topic"]', 1);
    await click('[data-enso="secretary-contact-topic"]', 2);
    await click('[data-enso="secretary-contact-scope-save"]');
    expect(contactSettings).toHaveBeenLastCalledWith(
      { telegramGroupScope: { chatId: '-1001', scope: ['3', '7'] } },
      'sec-b'
    );
    expect(container.querySelector('[data-enso="secretary-contact-group-picker"]')).toBeNull();
  });

  it('改回整群：保存 scope=all', async () => {
    state = contactState([{ id: '-1001', all: false, topics: [{ id: '3', title: '插件开发' }] }]);
    contactTelegramTopics.mockResolvedValueOnce({
      ok: true,
      forum: true,
      topics: [{ id: '1' }, { id: '3', title: '插件开发' }],
    });
    await render('sec-b');
    await click('[data-enso="secretary-contact-group-topics"]');
    const checked = [...container.querySelectorAll('[data-enso="secretary-contact-topic"]')].map(
      (node) => node.getAttribute('aria-checked')
    );
    expect(checked).toEqual(['false', 'true']);
    await click('[data-enso="secretary-contact-scope-all"]');
    await click('[data-enso="secretary-contact-scope-save"]');
    expect(contactSettings).toHaveBeenLastCalledWith(
      { telegramGroupScope: { chatId: '-1001', scope: 'all' } },
      'sec-b'
    );
  });

  it('没开话题的群：说明只能整群，不给话题勾选', async () => {
    state = contactState([{ id: '-1001', all: true, topics: [] }]);
    await render('sec-b');
    await click('[data-enso="secretary-contact-group-topics"]');
    const picker = container.querySelector('[data-enso="secretary-contact-group-picker"]');
    expect(picker?.textContent).toContain(
      'This group has no topics, so it can only be bound as a whole.'
    );
    expect(container.querySelector('[data-enso="secretary-contact-scope-topics"]')).toBeNull();
  });
});
