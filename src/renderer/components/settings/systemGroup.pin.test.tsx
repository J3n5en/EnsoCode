import type { SecretaryContactState, SecretaryProfile } from '@shared/types/secretary';
import type { UsageSummary, UsageTotals } from '@shared/usage/types';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/**
 * 迁移时只改这里：分区 → 页面组件。import 顶层并行发起：顺序瀑布在高负载下要
 * 十几秒，会撑爆 beforeAll 的 10s 超时；顶层 await 属于模块求值，不进钩子计时。
 */
const SYSTEM_GROUP_PAGES = await (async () => {
  const [
    { SecretarySettings },
    { ContactsSettings },
    { DevicesSettings },
    { SshSettings },
    { UsageSettings },
    { ResourcesSettings },
    { ExperimentalSettings },
    { BotSettings },
    { BotTemplatesSettings },
  ] = await Promise.all([
    import('./SecretarySettings'),
    import('./ContactsSettings'),
    import('./DevicesSettings'),
    import('./SshSettings'),
    import('./UsageSettings'),
    import('./ResourcesSettings'),
    import('./ExperimentalSettings'),
    import('./BotSettings'),
    import('./BotTemplatesSettings'),
  ]);
  return {
    secretary: SecretarySettings,
    contacts: ContactsSettings,
    phone: DevicesSettings,
    ssh: SshSettings,
    usage: UsageSettings,
    resources: ResourcesSettings,
    experimental: () => <ExperimentalSettings onOpenBots={() => {}} />,
    bots: BotSettings,
    botTemplates: BotTemplatesSettings,
  };
})();

const PROFILE: SecretaryProfile = {
  version: 1,
  name: '秘书',
  avatar: { color: '#7c5cff' },
  takeoverScope: { mode: 'projects', projectIds: [] },
  visibleProjectIds: 'all',
  maxRunningDispatches: 3,
  patrolEnabled: true,
  replyLanguage: 'ui',
  style: 'concise',
  notify: 'needs-user',
  updatedAt: 1,
};

const CONTACT: SecretaryContactState = {
  enabled: true,
  channels: [
    {
      id: 'telegram',
      title: 'Telegram',
      builtin: true,
      status: 'connected',
      caps: {
        buttons: true,
        urlButtons: true,
        edit: true,
        typing: true,
        format: 'html',
        maxChars: 4096,
        commandMenu: true,
        images: true,
        files: true,
      },
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
    groups: [],
    following: [],
    poll: { state: 'running' },
    secure: true,
  },
  owner: { githubLogins: ['j3n5en'], externalConfirm: false },
};

const TOTALS: UsageTotals = {
  cost: 1.5,
  input: 1000,
  output: 500,
  cacheRead: 200,
  cacheWrite: 100,
  tokens: 1800,
  sessions: 2,
  messages: 6,
  activeMs: 60_000,
};
const USAGE: UsageSummary = {
  days: 7,
  rangeStart: 0,
  rangeEnd: 7 * 86_400_000,
  totals: TOTALS,
  previous: TOTALS,
  daily: Array.from({ length: 7 }, (_, i) => ({
    day: `2026-01-0${i + 1}`,
    input: 100,
    output: 50,
    cache: 30,
    cost: 0.2,
  })),
  heatmap: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 10)),
  byModel: [{ model: 'claude', cost: 1.5, tokens: 1800, messages: 6, share: 1, pricing: null }],
  byProject: [{ project: 'enso', cost: 1.5, tokens: 1800, sessions: 2 }],
  unpricedModels: ['local-model'],
  pricing: {},
};

const pin = setupPin({
  pages: () => SYSTEM_GROUP_PAGES,
  results: {
    'electronAPI.secretary.list': [{ id: 's1', name: '秘书' }],
    'electronAPI.secretary.getProfile': { ok: true, profile: PROFILE, persona: '' },
    'electronAPI.secretary.listSchedules': { ok: true, schedules: [] },
    'electronAPI.secretary.listSkills': { ok: true, skills: [] },
    'electronAPI.secretary.listTools': { ok: true, tools: [] },
    'electronAPI.secretary.listTakeovers': { ok: true, takeovers: [] },
    'electronAPI.secretary.listUntracked': { ok: true, untracked: [] },
    'electronAPI.secretary.contactState': CONTACT,
    'electronAPI.secretary.contactGithubSuggest': { login: null },
    'electronAPI.extensionPlugins.list': [],
    ...Object.fromEntries(
      ['Bind', 'Cancel', 'Following', 'ForgetBot', 'Settings', 'Test', 'Unbind'].map((name) => [
        `electronAPI.secretary.contact${name}`,
        { ok: true },
      ])
    ),
    'electronAPI.sshConnections.list': [],
    'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
    'electronAPI.nodes.list': { nodes: [], secureStorage: true },
    'electronAPI.usage.summary': { ok: true, summary: USAGE },
    'electronAPI.bots.usageSummary': { ok: true, rows: [] },
    'electronAPI.bots.templates.get': { ok: false },
  },
  props: { 'electronAPI.env.platform': 'darwin', 'electronAPI.remote': undefined },
});

// 逐页渲染并点遍控件较慢，机器忙时 5s 默认超时会偶发失败
describe('秘书 / 连接 / 系统组设置迁移前后行为一致', { timeout: 30_000 }, () => {
  it('每页都渲染出来了', () => {
    const empty = [...pin.container.querySelectorAll('[data-pin-page]')]
      .filter((page) => (page.textContent ?? '').trim() === '')
      .map((page) => page.getAttribute('data-pin-page'));
    expect(empty).toEqual([]);
  });

  it('深链行 id 一个不少', () => {
    expect(pin.rows()).toMatchSnapshot();
  });

  it('每个控件的当前值（默认值）与读写的 store key / electronAPI 调用不变', async () => {
    expect(await pin.probe({ pressGroups: true })).toMatchSnapshot();
  });

  it('打开 Bot 模式与秘书后同样不变', async () => {
    await act(async () => pin.store.setState({ botModeEnabled: true, secretaryEnabled: true }));
    await pin.settle();
    expect(await pin.probe({ pressGroups: true })).toMatchSnapshot();
  });
});
