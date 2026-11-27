import { describe, expect, it } from 'vitest';
import { scheduleFolds, splitInjectedBlocks, triggerFolds, updatesFold } from './injectedBlocks';

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

  it('触发器块拆成 trigger 段并折叠为可读摘要，剥离不可信外壳', () => {
    const raw =
      '<secretary-trigger>\n' +
      '- [trigger id=trg-abc12345 name="微信售后群"] (参半群)\n' +
      '指令：汇总订单异常\n' +
      '<untrusted-content source="trigger:trg-abc12345">客户反馈包装破损</untrusted-content>\n' +
      '</secretary-trigger>';
    const segments = splitInjectedBlocks(raw);
    expect(segments?.map((segment) => segment.kind)).toEqual(['trigger']);
    expect(triggerFolds(raw)).toEqual([
      {
        summary: '微信售后群 · 参半群',
        body: '指令：汇总订单异常\n客户反馈包装破损',
      },
    ]);
  });
});
