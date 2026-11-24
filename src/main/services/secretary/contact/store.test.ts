import { describe, expect, it } from 'vitest';
import {
  ContactStore,
  emptyContactFile,
  parseContactFile,
  telegramGroupBindings,
  telegramTopicCatalog,
  withTelegramGroupAdded,
  withTelegramGroupRemoved,
  withTelegramGroupScope,
  withTelegramGroupTitle,
  withTelegramTopicTitle,
} from './store';

describe('Telegram 群白名单', () => {
  it('默认是空名单', () => {
    expect(emptyContactFile().telegramGroups).toEqual([]);
    expect(parseContactFile({}).telegramGroups).toEqual([]);
  });

  it('坏配置：非数组当空，非整数 id、空串与重复项丢掉', () => {
    expect(parseContactFile({ telegramGroups: 'x' }).telegramGroups).toEqual([]);
    expect(
      parseContactFile({ telegramGroups: [' -100123 ', '', '-100123', 'abc', 42, '-5'] })
        .telegramGroups
    ).toEqual(['-100123', '-5']);
  });

  it('添加做 trim；空的不加，重复的不加，不是数字 id 的拒绝', () => {
    const file = emptyContactFile();
    const added = withTelegramGroupAdded(file, '  -1001234567890 ');
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) return;
    expect(added.file.telegramGroups).toEqual(['-1001234567890']);
    const again = withTelegramGroupAdded(added.file, '-1001234567890');
    expect(again.ok && again.file.telegramGroups).toEqual(['-1001234567890']);
    expect(withTelegramGroupAdded(file, '   ')).toEqual({ ok: false });
    expect(withTelegramGroupAdded(file, '@devgroup')).toEqual({ ok: false });
    expect(withTelegramGroupAdded(file, 12)).toEqual({ ok: false });
  });

  it('删除只删那一个', () => {
    const file = { ...emptyContactFile(), telegramGroups: ['-1', '-2'] };
    expect(withTelegramGroupRemoved(file, ' -1 ').telegramGroups).toEqual(['-2']);
    expect(withTelegramGroupRemoved(file, '-9').telegramGroups).toEqual(['-1', '-2']);
  });

  it('见过的群名：只记最近的，标题没变不算改动', () => {
    let file = emptyContactFile();
    for (let index = 1; index <= 60; index += 1) {
      file = withTelegramGroupTitle(file, String(-index), `群${index}`) ?? file;
    }
    const titles = parseContactFile(file).telegramGroupTitles;
    expect(Object.keys(titles)).toHaveLength(50);
    expect(titles['-60']).toBe('群60');
    expect(titles['-1']).toBeUndefined();
    expect(withTelegramGroupTitle(file, '-60', '群60')).toBeNull();
    expect(withTelegramGroupTitle(file, '-60', '改名了')?.telegramGroupTitles['-60']).toBe(
      '改名了'
    );
  });
});

describe('Telegram 论坛话题绑定（落在路由表上）', () => {
  const GROUP = '-1001234567890';
  const NOW = 1_000;

  it('坏配置：话题名里不合法的项丢掉；旧的 telegramTopics 字段不再读', () => {
    const file = parseContactFile({
      telegramTopics: [{ chatId: GROUP, topicId: '3' }],
      telegramTopicTitles: { [`${GROUP}:3`]: '插件开发', bad: '坏的', [`${GROUP}:5`]: 9 },
    });
    expect(file.telegramTopicTitles).toEqual({ [`${GROUP}:3`]: '插件开发' });
    expect(file.telegramRoutes).toEqual([]);
    expect('telegramTopics' in file).toBe(false);
    expect(emptyContactFile().telegramTopicTitles).toEqual({});
  });

  it('选几个话题：拿掉白名单与整群路由，只留这几个话题路由；已有的话题路由原样保留', () => {
    const whole = {
      ...emptyContactFile(),
      telegramGroups: [GROUP, '-5'],
      telegramGroupTitles: { [GROUP]: 'EnsoCode 交流群' },
      telegramRoutes: [
        { chatId: GROUP, boundAt: 1 },
        { chatId: GROUP, topicId: '3', title: '旧标题', boundAt: 2 },
        { chatId: '-5', topicId: '2', boundAt: 3 },
      ],
    };
    const picked = withTelegramGroupScope(whole, GROUP, ['3', ' 7 ', '3'], NOW);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.file.telegramGroups).toEqual(['-5']);
    expect(picked.file.telegramRoutes).toEqual([
      { chatId: '-5', topicId: '2', boundAt: 3 },
      { chatId: GROUP, topicId: '3', title: '旧标题', boundAt: 2 },
      { chatId: GROUP, topicId: '7', title: 'EnsoCode 交流群', boundAt: NOW },
    ]);
  });

  it('选回整群：清掉这个群的话题路由；没有整群绑定时加进白名单，已有整群路由就沿用', () => {
    const topics = {
      ...emptyContactFile(),
      telegramRoutes: [
        { chatId: GROUP, topicId: '3', boundAt: 2 },
        { chatId: '-5', topicId: '2', boundAt: 3 },
      ],
    };
    const all = withTelegramGroupScope(topics, GROUP, 'all', NOW);
    expect(all.ok && all.file.telegramGroups).toEqual([GROUP]);
    expect(all.ok && all.file.telegramRoutes).toEqual([{ chatId: '-5', topicId: '2', boundAt: 3 }]);

    const routed = {
      ...topics,
      telegramRoutes: [...topics.telegramRoutes, { chatId: GROUP, boundAt: 4 }],
    };
    const kept = withTelegramGroupScope(routed, GROUP, 'all', NOW);
    expect(kept.ok && kept.file.telegramGroups).toEqual([]);
    expect(kept.ok && kept.file.telegramRoutes).toEqual([
      { chatId: '-5', topicId: '2', boundAt: 3 },
      { chatId: GROUP, boundAt: 4 },
    ]);
  });

  it('坏输入：群 id 不对、话题为空或不是数字一律拒绝', () => {
    const file = emptyContactFile();
    expect(withTelegramGroupScope(file, '@dev', 'all', NOW)).toEqual({
      ok: false,
      error: 'invalid-chat-id',
    });
    for (const scope of [[], ['abc'], 'some']) {
      expect(withTelegramGroupScope(file, GROUP, scope, NOW)).toEqual({
        ok: false,
        error: 'invalid-topic',
      });
    }
  });

  it('解绑一个群：白名单和这个群的整群、话题路由一起清，别的群不动', () => {
    const file = {
      ...emptyContactFile(),
      telegramGroups: [GROUP, '-5'],
      telegramRoutes: [
        { chatId: GROUP, topicId: '3', boundAt: 1 },
        { chatId: GROUP, boundAt: 1 },
        { chatId: '-5', topicId: '2', boundAt: 1 },
      ],
    };
    const next = withTelegramGroupRemoved(file, GROUP);
    expect(next.telegramGroups).toEqual(['-5']);
    expect(next.telegramRoutes).toEqual([{ chatId: '-5', topicId: '2', boundAt: 1 }]);
  });

  it('话题名：见过没名字的先占位，后来知道名字再补上；有名字不被空名覆盖', () => {
    let file = emptyContactFile();
    file = withTelegramTopicTitle(file, GROUP, '3', '') ?? file;
    expect(file.telegramTopicTitles).toEqual({ [`${GROUP}:3`]: '' });
    file = withTelegramTopicTitle(file, GROUP, '3', '插件开发') ?? file;
    expect(withTelegramTopicTitle(file, GROUP, '3', '')).toBeNull();
    expect(withTelegramTopicTitle(file, GROUP, '3', '插件开发')).toBeNull();
    expect(withTelegramTopicTitle(file, GROUP, 'x', '坏的')).toBeNull();
    expect(parseContactFile(file).telegramTopicTitles).toEqual({ [`${GROUP}:3`]: '插件开发' });
  });

  it('话题目录与设置页视图：白名单与路由表按群合并，整群与话题分开标', () => {
    const file = {
      ...emptyContactFile(),
      telegramGroups: ['-5'],
      telegramGroupTitles: { [GROUP]: 'EnsoCode 交流群' },
      telegramRoutes: [
        { chatId: GROUP, topicId: '12', boundAt: 1 },
        { chatId: '-7', title: '绑定码绑的群', boundAt: 1 },
      ],
      telegramTopicTitles: { [`${GROUP}:3`]: '插件开发', [`${GROUP}:7`]: '', '-5:2': '别的群' },
    };
    expect(telegramTopicCatalog(file, GROUP)).toEqual([
      { id: '3', title: '插件开发' },
      { id: '7' },
      { id: '12' },
    ]);
    expect(telegramGroupBindings(file)).toEqual([
      { id: '-5', all: true, topics: [] },
      { id: GROUP, title: 'EnsoCode 交流群', all: false, topics: [{ id: '12' }] },
      { id: '-7', title: '绑定码绑的群', all: true, topics: [] },
    ]);
  });
});

describe('GitHub 主人与外部确认', () => {
  it('解析时按大小写去重、丢掉坏值，最多留 10 个；externalConfirm 只有 true 才打开', () => {
    const extra = Array.from({ length: 12 }, (_, index) => `user${index}`);
    const file = parseContactFile({
      githubLogins: [
        ' J3n5en ',
        'j3n5en',
        'bad login',
        'github-actions[bot]',
        '',
        1,
        'a'.repeat(40),
        '-nope',
        ...extra,
      ],
      externalConfirm: 'yes',
    });
    expect(file.githubLogins[0]).toBe('J3n5en');
    expect(file.githubLogins).toHaveLength(10);
    expect(new Set(file.githubLogins.map((login) => login.toLowerCase())).size).toBe(10);
    expect(file.githubLogins).not.toContain('bad login');
    expect(file.externalConfirm).toBe(false);
    expect(parseContactFile({ externalConfirm: true }).externalConfirm).toBe(true);
    expect(emptyContactFile().githubLogins).toEqual([]);
    expect(emptyContactFile().externalConfirm).toBe(false);
  });

  it('解绑和更换 bot 后仍保留 GitHub 账号与外部确认', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'contact-github-'));
    try {
      const store = new ContactStore(dir);
      await store.ready();
      store.save({
        ...emptyContactFile(),
        githubLogins: ['J3n5en'],
        externalConfirm: true,
        bot: { id: 1, username: 'enso_bot', name: 'Enso' },
        chat: { id: 2, username: 'j3n5en' },
      });
      const unbound = store.saveUnbound();
      expect(unbound.githubLogins).toEqual(['J3n5en']);
      expect(unbound.externalConfirm).toBe(true);
      expect(unbound.chat).toBeUndefined();
      const forgotten = await store.saveForgotten();
      expect(forgotten.githubLogins).toEqual(['J3n5en']);
      expect(forgotten.externalConfirm).toBe(true);
      expect(forgotten.bot).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
