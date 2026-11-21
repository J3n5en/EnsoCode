import { describe, expect, it } from 'vitest';
import {
  emptyContactFile,
  matchTelegramRoute,
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

describe('Telegram 论坛话题绑定', () => {
  const GROUP = '-1001234567890';

  it('坏配置：话题绑定与话题名里不合法的项丢掉，重复的去重', () => {
    const file = parseContactFile({
      telegramTopics: [
        { chatId: GROUP, topicId: '3' },
        { chatId: GROUP, topicId: '3' },
        { chatId: 'abc', topicId: '4' },
        { chatId: GROUP, topicId: 'x' },
        { chatId: GROUP },
        'bad',
      ],
      telegramTopicTitles: { [`${GROUP}:3`]: '插件开发', bad: '坏的', [`${GROUP}:5`]: 9 },
    });
    expect(file.telegramTopics).toEqual([{ chatId: GROUP, topicId: '3' }]);
    expect(file.telegramTopicTitles).toEqual({ [`${GROUP}:3`]: '插件开发' });
    expect(emptyContactFile().telegramTopics).toEqual([]);
  });

  it('选几个话题：群从整群名单里拿掉，只留这几个话题；再选整群就清掉话题', () => {
    const whole = { ...emptyContactFile(), telegramGroups: [GROUP, '-5'] };
    const picked = withTelegramGroupScope(whole, GROUP, ['3', ' 7 ', '3']);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.file.telegramGroups).toEqual(['-5']);
    expect(picked.file.telegramTopics).toEqual([
      { chatId: GROUP, topicId: '3' },
      { chatId: GROUP, topicId: '7' },
    ]);
    const all = withTelegramGroupScope(picked.file, GROUP, 'all');
    expect(all.ok && all.file.telegramGroups).toEqual(['-5', GROUP]);
    expect(all.ok && all.file.telegramTopics).toEqual([]);
  });

  it('坏输入：群 id 不对、话题为空或不是数字一律拒绝', () => {
    const file = emptyContactFile();
    expect(withTelegramGroupScope(file, '@dev', 'all')).toEqual({
      ok: false,
      error: 'invalid-chat-id',
    });
    expect(withTelegramGroupScope(file, GROUP, [])).toEqual({ ok: false, error: 'invalid-topic' });
    expect(withTelegramGroupScope(file, GROUP, ['abc'])).toEqual({
      ok: false,
      error: 'invalid-topic',
    });
    expect(withTelegramGroupScope(file, GROUP, 'some')).toEqual({
      ok: false,
      error: 'invalid-topic',
    });
  });

  it('解绑一个群：整群和它的话题一起清，别的群不动', () => {
    const file = {
      ...emptyContactFile(),
      telegramGroups: ['-5'],
      telegramTopics: [
        { chatId: GROUP, topicId: '3' },
        { chatId: '-5', topicId: '2' },
      ],
    };
    const next = withTelegramGroupRemoved(file, GROUP);
    expect(next.telegramGroups).toEqual(['-5']);
    expect(next.telegramTopics).toEqual([{ chatId: '-5', topicId: '2' }]);
  });

  it('路由键：话题绑定优先于整群；整群兜住没有单独绑的话题；都没有就不收', () => {
    const file = {
      ...emptyContactFile(),
      telegramGroups: [GROUP],
      telegramTopics: [{ chatId: GROUP, topicId: '3' }],
    };
    expect(matchTelegramRoute(file, Number(GROUP), '3')).toEqual({ chatId: GROUP, topicId: '3' });
    expect(matchTelegramRoute(file, GROUP, '9')).toEqual({ chatId: GROUP });
    expect(matchTelegramRoute(file, GROUP, undefined)).toEqual({ chatId: GROUP });
    const topicsOnly = { ...file, telegramGroups: [] };
    expect(matchTelegramRoute(topicsOnly, GROUP, '3')).toEqual({ chatId: GROUP, topicId: '3' });
    expect(matchTelegramRoute(topicsOnly, GROUP, '9')).toBeNull();
    expect(matchTelegramRoute(topicsOnly, GROUP, undefined)).toBeNull();
    expect(matchTelegramRoute(topicsOnly, '-5', '3')).toBeNull();
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

  it('话题目录与设置页视图：按 id 排序，已绑但没见过的话题也列出；整群与话题分开标', () => {
    const file = {
      ...emptyContactFile(),
      telegramGroups: ['-5'],
      telegramGroupTitles: { [GROUP]: 'EnsoCode 交流群' },
      telegramTopics: [{ chatId: GROUP, topicId: '12' }],
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
    ]);
  });
});
