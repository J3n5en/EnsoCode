import { describe, expect, it } from 'vitest';
import { scheduleFolds, splitInjectedBlocks, updatesFold } from './injectedBlocks';

describe('scheduleFolds', () => {
  it('短名称后面的提示词作为一行人话，多行正文留给展开', () => {
    expect(
      scheduleFolds(
        '<secretary-schedule>\n- [schedule] 巡检：巡检进行中的派发会话\n逐个看是否卡住\n</secretary-schedule>'
      )
    ).toEqual([{ summary: '巡检进行中的派发会话', body: '巡检进行中的派发会话\n逐个看是否卡住' }]);
  });

  it('长标题本身就是那句话，不从冒号切开', () => {
    expect(
      scheduleFolds(
        '<secretary-schedule>\n- [schedule] 巡检进行中的派发会话：请检查\n</secretary-schedule>'
      )
    ).toEqual([
      {
        summary: '巡检进行中的派发会话：请检查',
        body: '巡检进行中的派发会话：请检查',
      },
    ]);
  });

  it('外壳标签不会留在正文里', () => {
    const [fold] = scheduleFolds('<secretary-schedule>\n- [schedule] 巡检\n</secretary-schedule>');
    expect(fold?.body).toBe('巡检');
    expect(fold?.body).not.toContain('secretary-schedule');
  });
});

describe('updatesFold', () => {
  it('解析失败时去掉标签，摘要用第一行正文', () => {
    expect(updatesFold('<session-updates>\n不是列表\n第二行\n</session-updates>')).toEqual({
      summary: '不是列表',
      body: '不是列表\n第二行',
    });
  });
});

describe('splitInjectedBlocks', () => {
  it('定时块和回传块分开，目标块仍是目标', () => {
    const segments = splitInjectedBlocks(
      '<secretary-schedule>\n- [schedule] 巡检\n</secretary-schedule>\n<session-updates>\n- [proposal] 提案已执行\n</session-updates>'
    );
    expect(
      segments
        ?.filter((segment) => segment.kind !== 'text' || segment.text.trim())
        .map((segment) => segment.kind)
    ).toEqual(['schedule', 'updates']);
  });
});
