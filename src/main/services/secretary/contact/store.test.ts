import { describe, expect, it } from 'vitest';
import {
  emptyContactFile,
  parseContactFile,
  withTelegramGroupAdded,
  withTelegramGroupRemoved,
  withTelegramGroupTitle,
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
