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
      prefs: {
        enabled: true,
        push: true,
        cardConfirm: true,
        approvalRemote: false,
        syncMirror: false,
        memory: false,
      },
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
    'electronAPI.secretary.listTriggers': {
      ok: true,
      server: {
        host: '127.0.0.1',
        port: 17654,
        configuredPort: 17654,
        status: 'listening',
        activeCount: 0,
      },
      triggers: [],
    },
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

  /**
   * 深链行断言只覆盖系统组的关键行：删除或改名这些行会红，
   * 新增一行设置不会红——这是与快照对比的分界线。
   */
  it('关键深链行都在', () => {
    const rows = pin.rows().filter((row): row is string => row !== null);
    const required = [
      'bots.maxRunningTurns',
      'bots.routeClassifier',
      'contacts.channels',
      'contacts.enable-contacts',
      'contacts.external-messages',
      'contacts.github-accounts',
      'experimental.botMode',
      'experimental.secretary',
      'secretary.dispatchLimit',
      'secretary.profile',
      'secretary.reply-language',
      'secretary.style',
      'secretary.system-notifications',
      'secretary.takeoverScope',
      'secretary.triggers',
      'secretary.triggers.server',
      'ssh.timeout',
    ];
    expect(rows.filter((row) => required.includes(row)).sort()).toEqual([...required].sort());
    // 行 id 必须是合法的深链形式（category.kebab-path），不允许裸 id
    expect(rows.filter((row) => !/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/.test(row))).toEqual([]);
  });

  type Effect = { store: Record<string, unknown>; api: string[] };
  const parseEffects = (raw: unknown[]): Effect[] =>
    raw.map((effect) => (typeof effect === 'string' ? JSON.parse(effect) : effect) as Effect);

  /**
   * 行为契约：这些行的控件点击后必须写进约定的 store key 或调用约定的
   * electronAPI 路径。契约按行声明，新增一行设置不红，改错 key/路径红。
   * api 条目为正则字符串，同时锚住调用路径与关键负载。
   */
  type ControlSpec = {
    row: string;
    kind: string;
    /** 同一 row+kind 多个控件时的序号（DOM 顺序） */
    idx?: number;
    /** 点击后允许写动的 store key 全集（可以是空集=不写 store） */
    storeKeys: string[];
    /** 每个 effect 里每个 api 调用必须命中其一；空数组=不允许任何 api 调用 */
    api: string[];
    /** 至少一个 effect 里必须出现匹配此正则的 api 调用 */
    mustCall?: string;
    /** 至少一个 effect 里必须把该 key 写成非空值 */
    mustWriteStore?: string;
  };
  const esc = (s: string) => s.replace(/[{}[\]()":\\]/g, '\\$&');
  const contract: ControlSpec[] = [
    {
      row: 'bots.maxRunningTurns',
      kind: 'choice',
      storeKeys: ['botMaxRunningTurns'],
      api: [],
      mustWriteStore: 'botMaxRunningTurns',
    },
    {
      row: 'contacts.channels',
      kind: 'switch',
      idx: 0,
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('{"channelId":"telegram","prefs":{"approvalRemote":true}}'),
    },
    {
      row: 'contacts.channels',
      kind: 'switch',
      idx: 1,
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('{"channelId":"telegram","prefs":{"memory":true}}'),
    },
    {
      row: 'contacts.channels',
      kind: 'switch',
      idx: 2,
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('{"channelId":"telegram","prefs":{"syncMirror":true}}'),
    },
    {
      row: 'contacts.channels',
      kind: 'switch',
      idx: 3,
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('{"channelId":"telegram","prefs":{"cardConfirm":false}}'),
    },
    {
      row: 'contacts.channels',
      kind: 'switch',
      idx: 4,
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('{"channelId":"telegram","prefs":{"enabled":false}}'),
    },
    {
      row: 'contacts.channels',
      kind: 'switch',
      idx: 5,
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('{"channelId":"telegram","prefs":{"push":false}}'),
    },
    {
      row: 'contacts.enable-contacts',
      kind: 'switch',
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('contactSettings({"enabled":false}'),
    },
    {
      row: 'contacts.external-messages',
      kind: 'choice',
      storeKeys: [],
      api: ['secretary\\.contactSettings', 'secretary\\.contactState'],
      mustCall: esc('contactSettings({"externalConfirm":true}'),
    },
    {
      row: 'experimental.botMode',
      kind: 'switch',
      storeKeys: ['botModeEnabled'],
      api: ['bots\\.usageSummary', 'usage\\.summary'],
      mustWriteStore: 'botModeEnabled',
    },
    {
      row: 'experimental.dropShelf',
      kind: 'switch',
      storeKeys: ['dropShelfEnabled'],
      api: [],
      mustWriteStore: 'dropShelfEnabled',
    },
    {
      row: 'experimental.scratchSessions',
      kind: 'switch',
      storeKeys: ['scratchSessionsEnabled'],
      api: [],
      mustWriteStore: 'scratchSessionsEnabled',
    },
    {
      row: 'experimental.secretary',
      kind: 'switch',
      storeKeys: ['secretaryEnabled'],
      api: [],
      mustWriteStore: 'secretaryEnabled',
    },
    {
      row: 'secretary.communication-style',
      kind: 'choice',
      storeKeys: [],
      api: ['secretary\\.saveProfile'],
      mustCall: esc('saveProfile({"style":"detailed"}'),
    },
    {
      row: 'secretary.dispatchLimit',
      kind: 'choice',
      storeKeys: [],
      api: ['secretary\\.saveProfile'],
      mustCall: 'saveProfile\\(\\{"maxRunningDispatches":10\\}',
    },
    {
      row: 'secretary.reply-language',
      kind: 'choice',
      storeKeys: [],
      api: ['secretary\\.saveProfile'],
      mustCall: esc('saveProfile({"replyLanguage":"zh"}'),
    },
    {
      row: 'secretary.system-notifications',
      kind: 'choice',
      storeKeys: [],
      api: ['secretary\\.saveProfile'],
      mustCall: esc('saveProfile({"notify":"off"}'),
    },
    {
      row: 'secretary.takeoverScope',
      kind: 'choice',
      storeKeys: [],
      api: ['secretary\\.saveProfile'],
      mustCall: esc('saveProfile({"takeoverScope":{"mode":"all"}}'),
    },
    {
      row: 'ssh.timeout',
      kind: 'choice',
      storeKeys: ['sshTimeoutSeconds'],
      api: [],
      mustWriteStore: 'sshTimeoutSeconds',
    },
  ];

  const assertContract = (probe: { row: string | null; kind: string; effects: unknown[] }[]) => {
    const failures: string[] = [];
    for (const spec of contract) {
      const matches = probe.filter((c) => c.row === spec.row && c.kind === spec.kind);
      const control = spec.idx === undefined ? matches[0] : matches[spec.idx];
      if (!control) {
        failures.push(
          `${spec.row} (${spec.kind}${spec.idx !== undefined ? `#${spec.idx}` : ''}): 控件不存在`
        );
        continue;
      }
      const where = `${spec.row}.${spec.kind}${spec.idx !== undefined ? `#${spec.idx}` : ''}`;
      if (control.effects.length === 0) {
        failures.push(`${where}: 没有任何 effect`);
        continue;
      }
      const apiAllowed = spec.api.map((pattern) => new RegExp(pattern));
      let sawMustCall = false;
      let sawMustWrite = false;
      const mustCall = spec.mustCall ? new RegExp(spec.mustCall) : null;
      for (const effect of parseEffects(control.effects)) {
        for (const key of Object.keys(effect.store)) {
          if (!spec.storeKeys.includes(key)) {
            failures.push(`${where}: 写入了契约外的 store key「${key}」`);
          }
          if (spec.mustWriteStore === key && effect.store[key] !== undefined) sawMustWrite = true;
        }
        for (const call of effect.api) {
          if (!apiAllowed.some((re) => re.test(call))) {
            failures.push(`${where}: 调用了契约外的 api「${call}」`);
          }
          if (mustCall?.test(call)) sawMustCall = true;
        }
      }
      if (mustCall && !sawMustCall) failures.push(`${where}: 没有调用 ${spec.mustCall}`);
      if (spec.mustWriteStore && !sawMustWrite) {
        failures.push(`${where}: 没有写入 store key「${spec.mustWriteStore}」`);
      }
    }
    expect(failures).toEqual([]);
  };

  it('每个控件写动的 store key 与 electronAPI 调用符合契约', async () => {
    assertContract(await pin.probe({ pressGroups: true }));
  });

  it('打开 Bot 模式与秘书后契约同样成立', async () => {
    await act(async () => pin.store.setState({ botModeEnabled: true, secretaryEnabled: true }));
    await pin.settle();
    assertContract(await pin.probe({ pressGroups: true }));
  });
});
