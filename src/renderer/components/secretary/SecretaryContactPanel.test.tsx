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
    owner: { githubLogins: [], externalConfirm: false },
  };
}

let root: Root;
let container: HTMLElement;
let state: SecretaryContactState;
let contactSettings: ReturnType<typeof vi.fn>;
let contactTest: ReturnType<typeof vi.fn>;
let contactTelegramTopics: ReturnType<typeof vi.fn>;
let contactBind: ReturnType<typeof vi.fn>;
let pushState: (next: SecretaryContactState) => void;

const groupsBox = () => container.querySelector('[data-enso="secretary-contact-groups"]');
const addButton = () =>
  container.querySelector('[data-enso="secretary-contact-group-add"]') as HTMLButtonElement;

async function render(secretaryId?: string): Promise<void> {
  await act(async () => {
    root.render(
      <SecretaryContactPanel
        secretaryId={secretaryId}
        frames={{
          owner: (node) => <div data-frame="owner">{node}</div>,
          channels: (node) => <div data-frame="channels">{node}</div>,
        }}
      />
    );
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
  contactBind = vi.fn(async () => ({ ok: true }));
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
      contactBind,
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

describe('主人身份', () => {
  const setInput = async (selector: string, value: string) => {
    const input = container.querySelector(selector) as HTMLInputElement;
    const key = Object.keys(input).find((name) => name.startsWith('__reactProps'));
    const props = (key ? (input as unknown as Record<string, unknown>)[key] : null) as {
      onChange?: (event: {
        target: { value: string };
        currentTarget: { value: string };
        defaultPrevented: boolean;
        nativeEvent: { defaultPrevented: boolean };
      }) => void;
    } | null;
    await act(async () => {
      // base-ui 的 FieldControl 内部读 currentTarget/nativeEvent/defaultPrevented
      props?.onChange?.({
        target: { value },
        currentTarget: { value },
        defaultPrevented: false,
        nativeEvent: { defaultPrevented: false },
      });
    });
  };

  it('联系方式关掉也显示；保存才提交账号，填入不保存，确认开关单独提交', async () => {
    const suggest = vi.fn(async () => ({ login: 'J3n5en' }));
    (
      window as unknown as {
        electronAPI: { secretary: { contactGithubSuggest: typeof suggest } };
      }
    ).electronAPI.secretary.contactGithubSuggest = suggest;
    state = {
      ...contactState([]),
      enabled: false,
      owner: { githubLogins: [], externalConfirm: false },
    };
    await render('sec-a');
    expect(container.querySelector('[data-enso="secretary-contact-owner"]')).not.toBeNull();
    expect(container.textContent).toContain('J3n5en');
    const fill = container.querySelector(
      '[data-enso="secretary-contact-github-fill"]'
    ) as HTMLButtonElement;
    await act(async () => {
      fill.click();
    });
    expect(contactSettings).not.toHaveBeenCalled();
    expect(
      (container.querySelector('[data-enso="secretary-contact-github-logins"]') as HTMLInputElement)
        .value
    ).toBe('J3n5en');
    await setInput('[data-enso="secretary-contact-github-logins"]', 'J3n5en, octocat');
    await act(async () => {
      (
        container.querySelector('[data-enso="secretary-contact-github-save"]') as HTMLButtonElement
      ).click();
    });
    expect(contactSettings).toHaveBeenCalledWith({ githubLogins: ['J3n5en', 'octocat'] }, 'sec-a');
    await act(async () => {
      (
        container.querySelector(
          '[data-enso="secretary-contact-external-confirm"]'
        ) as HTMLButtonElement
      ).click();
    });
    expect(contactSettings).toHaveBeenLastCalledWith({ externalConfirm: true }, 'sec-a');
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
    expect(
      rows.map(
        (row) => row.querySelector('[data-enso="secretary-contact-group-name"]')?.textContent
      )
    ).toEqual(['Dev 群 -1001', '-1002']);
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
    expect(scopeText()).toEqual(['Topics: 插件开发, General (default topic), Topic #9']);
  });

  it('拉话题失败给出原因与重试；重试成功后勾选话题保存', async () => {
    state = contactState([{ id: '-1001', title: 'EnsoCode 交流群', all: true, topics: [] }]);
    contactTelegramTopics.mockResolvedValueOnce({
      ok: false,
      error: 'api',
      detail: 'Bad Request: chat not found',
    });
    await render('sec-b');
    await click('[data-enso="secretary-contact-scope-topics"]');
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

  it('整群 / 选话题直接显示在群这一行，不用展开；改话题沿用已勾的，点整群直接保存', async () => {
    state = contactState([{ id: '-1001', all: false, topics: [{ id: '3', title: '插件开发' }] }]);
    contactTelegramTopics.mockResolvedValueOnce({
      ok: true,
      forum: true,
      topics: [{ id: '1' }, { id: '3', title: '插件开发' }],
    });
    await render('sec-b');
    const segment = (enso: string) =>
      container.querySelector(`[data-enso="${enso}"]`)?.getAttribute('aria-checked');
    expect(segment('secretary-contact-scope-all')).toBe('false');
    expect(segment('secretary-contact-scope-topics')).toBe('true');
    expect(contactTelegramTopics).not.toHaveBeenCalled();

    await click('[data-enso="secretary-contact-group-topics"]');
    const checked = [...container.querySelectorAll('[data-enso="secretary-contact-topic"]')].map(
      (node) => node.getAttribute('aria-checked')
    );
    expect(checked).toEqual(['false', 'true']);
    await click('[data-enso="secretary-contact-scope-all"]');
    expect(contactSettings).toHaveBeenLastCalledWith(
      { telegramGroupScope: { chatId: '-1001', scope: 'all' } },
      'sec-b'
    );
  });

  it('没开话题的群：说明只能整群，不给话题勾选', async () => {
    state = contactState([{ id: '-1001', all: true, topics: [] }]);
    await render('sec-b');
    await click('[data-enso="secretary-contact-scope-topics"]');
    const picker = container.querySelector('[data-enso="secretary-contact-group-picker"]');
    expect(picker?.textContent).toContain(
      'This group has no topics, so it can only be bound as a whole.'
    );
    expect(container.querySelector('[data-enso="secretary-contact-topic"]')).toBeNull();
    expect(contactSettings).not.toHaveBeenCalled();
  });
});

describe('多个秘书共用一个 bot', () => {
  const shared: NonNullable<SecretaryContactState['telegram']['shared']> = [
    { secretaryId: 'sec-b', name: '小 B', self: true, enabled: true, groups: [] },
    {
      secretaryId: 'default',
      name: '爱酱',
      self: false,
      enabled: true,
      privateChat: { id: 777, username: 'j3n5en' },
      groups: [{ id: '-1001', title: '工作群', all: true, topics: [] }],
    },
  ];

  function awaiting(
    rejected?: NonNullable<SecretaryContactState['telegram']['bind']>['rejected'],
    expiresAt = Date.now() + 5 * 60_000
  ): SecretaryContactState {
    const base = contactState([]);
    return {
      ...base,
      telegram: {
        ...base.telegram,
        status: 'awaiting-start',
        chat: undefined,
        shared,
        bind: {
          code: '123456',
          link: 'https://t.me/enso_bot?start=123456',
          groupLink: 'https://t.me/enso_bot?startgroup=123456',
          topicCommand: '/bind@enso_bot 123456',
          expiresAt,
          ...(rejected ? { rejected } : {}),
        },
      },
    };
  }

  const text = (enso: string) =>
    container.querySelector(`[data-enso="${enso}"]`)?.textContent ?? null;
  const click = async (selector: string) => {
    const target = container.querySelector(selector) as HTMLButtonElement | null;
    if (!target) throw new Error(`missing ${selector}`);
    await act(async () => {
      target.click();
    });
  };

  it('私聊已归别的秘书：等码时就提示改绑群或话题，给出群链接、话题命令和群列表，并列出共用情况', async () => {
    state = awaiting();
    await render('sec-b');
    expect(text('secretary-contact-private-owned')).toContain('爱酱');
    expect(
      container.querySelector('[data-enso="secretary-contact-group-link"]')?.getAttribute('href')
    ).toBe('https://t.me/enso_bot?startgroup=123456');
    expect(text('secretary-contact-topic-command')).toBe('/bind@enso_bot 123456');
    expect(groupsBox()).not.toBeNull();
    const users = [...container.querySelectorAll('[data-enso="secretary-contact-shared-user"]')];
    expect(users.map((user) => user.textContent)).toEqual([
      expect.stringContaining('小 B'),
      expect.stringContaining('Private chat with @j3n5en'),
    ]);
    const others = [...container.querySelectorAll('[data-enso="secretary-contact-group-other"]')];
    expect(others.map((node) => node.textContent)).toEqual([
      expect.stringContaining('工作群 · Whole group'),
    ]);
    expect(others[0]?.textContent).toContain('爱酱');
    expect(others[0]?.querySelector('button')).toBeNull();
  });

  it('发码被拒：写明原因（私聊归谁）而不是一直等', async () => {
    state = awaiting({ reason: 'private-owned', owner: '爱酱' });
    await render('sec-b');
    expect(
      container
        .querySelector('[data-enso="secretary-contact-bind-rejected"]')
        ?.getAttribute('data-reason')
    ).toBe('private-owned');
    expect(text('secretary-contact-bind-rejected')).toContain('爱酱');
    expect(container.querySelector('[data-enso="secretary-contact-private-owned"]')).toBeNull();
  });

  it('码过期：显示已过期，「重新生成」成为主按钮', async () => {
    state = awaiting(undefined, Date.now() - 1000);
    await render('sec-b');
    expect(container.querySelector('[data-enso="secretary-contact-code-expired"]')).not.toBeNull();
    expect(
      container.querySelector('[data-enso="secretary-contact-regenerate"]')?.getAttribute('class')
    ).toContain('bg-foreground');
    // 不带 token 重新生成：秘书 id 走第二个参数，不能被当成 token
    await click('[data-enso="secretary-contact-regenerate"]');
    expect(contactBind).toHaveBeenCalledWith(undefined, 'sec-b');
  });

  it('勾话题：已单独归别的秘书的话题标出归属且不能勾', async () => {
    state = contactState([{ id: '-1001', all: false, topics: [{ id: '9' }] }]);
    contactTelegramTopics.mockResolvedValue({
      ok: true,
      forum: true,
      topics: [{ id: '1' }, { id: '3', title: '插件开发', owner: '爱酱' }, { id: '9' }],
    });
    await render('sec-b');
    await click('[data-enso="secretary-contact-group-topics"]');
    const topics = [...container.querySelectorAll('[data-enso="secretary-contact-topic"]')];
    expect(topics.map((topic) => topic.textContent)).toEqual([
      'General (default topic)',
      '插件开发 · taken by 爱酱',
      'Topic #9',
    ]);
    expect(topics.map((topic) => topic.hasAttribute('disabled'))).toEqual([false, true, false]);
  });

  it('只绑了群和话题：头部不再显示空的 @', async () => {
    const base = contactState([{ id: '-1002', all: true, topics: [] }]);
    state = { ...base, telegram: { ...base.telegram, chat: undefined, shared } };
    await render('sec-b');
    expect(text('secretary-contact-bound')).toContain('Bound to groups and topics');
    expect(container.querySelector('[data-enso="secretary-contact-shared"]')).not.toBeNull();
  });
});

describe('群和话题入口', () => {
  const box = () => groupsBox()?.textContent ?? '';
  const click = async (selector: string) => {
    const target = container.querySelector(selector) as HTMLButtonElement | null;
    if (!target) throw new Error(`missing ${selector}`);
    await act(async () => {
      target.click();
    });
  };

  it('还没填 bot：也显示群和话题这一块，说明先验证 bot', async () => {
    const base = contactState([]);
    state = {
      ...base,
      telegram: { ...base.telegram, status: 'unbound', chat: undefined, bot: undefined },
    };
    await render('sec-b');
    expect(groupsBox()).not.toBeNull();
    expect(box()).toContain('Add the bot to the group');
    expect(box()).toContain('Verify a bot above first');
    expect(container.querySelector('[data-enso="secretary-contact-groups-new-code"]')).toBeNull();
  });

  it('已绑私聊、还没绑群：写明怎么绑，一键拿到这个秘书的绑定码', async () => {
    await render('sec-b');
    expect(box()).toContain('Add the bot to the group');
    expect(box()).toContain('/bind@enso_bot');
    await click('[data-enso="secretary-contact-groups-new-code"]');
    expect(contactBind).toHaveBeenCalledWith(undefined, 'sec-b');
  });

  it('有码时直接显示码、拉群链接和要发的命令', async () => {
    const base = contactState([]);
    state = {
      ...base,
      telegram: {
        ...base.telegram,
        bind: {
          code: '654321',
          link: 'https://t.me/enso_bot?start=654321',
          groupLink: 'https://t.me/enso_bot?startgroup=654321',
          topicCommand: '/bind@enso_bot 654321',
          expiresAt: Date.now() + 5 * 60_000,
        },
      },
    };
    await render('sec-b');
    const group = groupsBox();
    expect(
      group?.querySelector('[data-enso="secretary-contact-groups-code"]')?.textContent
    ).toContain('654321');
    expect(
      group?.querySelector('[data-enso="secretary-contact-group-link"]')?.getAttribute('href')
    ).toBe('https://t.me/enso_bot?startgroup=654321');
    expect(group?.querySelector('[data-enso="secretary-contact-topic-command"]')?.textContent).toBe(
      '/bind@enso_bot 654321'
    );
  });

  it('等私聊 Start 时（私聊没被占）也显示群和话题', async () => {
    const base = contactState([]);
    state = {
      ...base,
      telegram: {
        ...base.telegram,
        status: 'awaiting-start',
        chat: undefined,
        bind: {
          code: '123456',
          link: 'https://t.me/enso_bot?start=123456',
          groupLink: 'https://t.me/enso_bot?startgroup=123456',
          topicCommand: '/bind@enso_bot 123456',
          expiresAt: Date.now() + 5 * 60_000,
        },
      },
    };
    await render('sec-b');
    expect(groupsBox()).not.toBeNull();
    expect(
      container.querySelectorAll('[data-enso="secretary-contact-topic-command"]')
    ).toHaveLength(1);
  });
});

describe('插件渠道出站失败', () => {
  function withWechat(
    outbound?: SecretaryContactState['channels'][number]['outbound']
  ): SecretaryContactState {
    const base = contactState([]);
    const telegram = base.channels[0];
    if (!telegram) throw new Error('missing telegram');
    return {
      ...base,
      channels: [
        telegram,
        {
          ...telegram,
          id: 'enso.clawbot:wechat',
          title: '微信',
          builtin: false,
          pluginId: 'enso.clawbot',
          ...(outbound ? { outbound } : {}),
        },
      ],
    };
  }
  const wechatCard = () =>
    container.querySelector(
      '[data-enso="secretary-contact-channel"][data-channel="enso.clawbot:wechat"]'
    );

  it('暂停中：标出暂停推送，插件提示原样展示，带原因、最近失败时间与被拦下的条数', async () => {
    state = withWechat({
      state: 'paused',
      consecutiveFailures: 3,
      lastErrorAt: Date.now() - 60_000,
      lastErrorCode: 'api',
      detail: '[SESSION_EXPIRED] sendmessage ret=-2 prepare failed',
      pluginCode: 'SESSION_EXPIRED',
      userMessage: '微信会话已过期，请在微信里给机器人发任意一条消息',
      pausedUntil: Date.now() + 5 * 60_000,
      suppressedCount: 4,
    });
    await render('sec-a');
    const card = wechatCard();
    expect(
      card?.querySelector('[data-enso="secretary-contact-channel-outbound"]')?.textContent
    ).toBe('Pushes paused');
    const notice = card?.querySelector('[data-enso="secretary-contact-outbound"]');
    expect(notice?.getAttribute('data-state')).toBe('paused');
    expect(notice?.textContent).toContain('Pushes paused: 3 sends failed in a row');
    expect(
      notice?.querySelector('[data-enso="secretary-contact-outbound-hint"]')?.textContent
    ).toBe('微信会话已过期，请在微信里给机器人发任意一条消息');
    expect(
      notice?.querySelector('[data-enso="secretary-contact-outbound-detail"]')?.textContent
    ).toBe('[SESSION_EXPIRED] sendmessage ret=-2 prepare failed');
    expect(notice?.textContent).toContain('Last failure:');
    expect(notice?.textContent).toContain('4 pushes held back.');
    // Telegram 卡片不受影响
    expect(
      container.querySelector('[data-channel="telegram"] [data-enso="secretary-contact-outbound"]')
    ).toBeNull();
  });

  it('立即重试：按渠道 id 调测试接口；发送失败的原因留在卡片上，不在顶部报 Telegram 错误', async () => {
    state = withWechat({
      state: 'degraded',
      consecutiveFailures: 1,
      lastErrorAt: Date.now(),
      lastErrorCode: 'api',
      detail: 'sendmessage ret=-2 prepare failed',
      suppressedCount: 0,
    });
    contactTest.mockResolvedValueOnce({ ok: false, error: 'api' });
    await render('sec-a');
    const retry = container.querySelector(
      '[data-channel="enso.clawbot:wechat"] [data-enso="secretary-contact-outbound-retry"]'
    ) as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    expect(contactTest).toHaveBeenCalledWith('sec-a', 'enso.clawbot:wechat');
    expect(errorBanner()).toBeNull();
  });

  it('发送正常时不显示失败块', async () => {
    state = withWechat();
    await render('sec-a');
    expect(wechatCard()?.querySelector('[data-enso="secretary-contact-outbound"]')).toBeNull();
  });
});
