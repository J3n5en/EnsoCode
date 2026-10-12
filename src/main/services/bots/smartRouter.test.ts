import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscussNextInput } from '../../../shared/bots/discussRoute';
import type { SmartRouteInput } from '../../../shared/bots/smartRoute';
import { createSmartRouter } from './smartRouter';

const input: SmartRouteInput = {
  candidates: [
    { id: 'a', name: 'Alice', title: '', scope: 'lead', canAct: false, owner: true },
    { id: 'b', name: 'Bob', title: '', scope: 'backend', canAct: true, owner: false },
    { id: 'c', name: 'Carol', title: '', scope: 'frontend', canAct: true, owner: false },
  ],
  bossBotId: 'a',
  recent: [],
  message: 'who owns the api',
};
const signal = new AbortController().signal;
const judgeModel = { providerId: 'p', modelId: 'fast' };

let settings: Record<string, unknown> | undefined;
const judge = vi.fn();
const classify = vi.fn();
const router = () => createSmartRouter({ settings: () => settings, judge, classify });

beforeEach(() => {
  settings = {};
  judge.mockReset();
  classify.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('createSmartRouter', () => {
  it('点名「大家 / 都 / everyone」时不问模型，全员按群成员顺序依次回复', async () => {
    for (const message of [
      '都自我介绍一下',
      '大家说说各自的看法',
      '各位报个到',
      'everyone introduce yourselves',
      'Each of you, say hi',
    ])
      expect(await router().select({ ...input, message }, signal)).toEqual({
        ids: ['a', 'b', 'c'],
        everyone: true,
      });
    expect(judge).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it('「都」不是在点名全员时照常问模型', async () => {
    judge.mockResolvedValue('Bob');
    for (const message of ['这些都改成蓝色', '都几点了接口还挂着', 'all tests failed'])
      expect((await router().select({ ...input, message }, signal)).ids).toEqual(['b']);
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it('未设置时走 judge（标题模型回退链），默认超时 15s、限输出', async () => {
    judge.mockResolvedValueOnce('Bob');
    expect(router().timeoutMs()).toBe(15_000);
    expect(await router().select(input, signal)).toEqual({ ids: ['b'], intent: 'answer' });
    expect(judge.mock.calls[0][0]).toMatchObject({
      preferred: undefined,
      timeoutMs: 15_000,
      maxTokens: 128,
    });
    expect(judge.mock.calls[0][0].userText).toContain('who owns the api');
    expect(classify).not.toHaveBeenCalled();
  });

  it('指定 judge 模型时排在最前；旧版存下的 3000ms 抬到 15s，其他自定义值照用', async () => {
    settings = { botRouteClassifier: { source: 'judge', model: judgeModel, timeoutMs: 3000 } };
    judge.mockResolvedValueOnce('BOSS');
    expect(router().timeoutMs()).toBe(15_000);
    expect((await router().select(input, signal)).ids).toEqual(['a']);
    expect(judge.mock.calls[0][0]).toMatchObject({ preferred: judgeModel, timeoutMs: 15_000 });
    settings = { botRouteClassifier: { source: 'judge', model: judgeModel, timeoutMs: 12_000 } };
    expect(router().timeoutMs()).toBe(12_000);
  });

  it('用户在设置页明确设的时限照用：3 秒就是 3 秒，越界收到 0.5–30s', async () => {
    const set = (timeoutMs: number) => {
      settings = {
        botRouteClassifier: { source: 'judge', model: judgeModel, timeoutMs, timeoutSet: true },
      };
    };
    set(3000);
    expect(router().timeoutMs()).toBe(3000);
    judge.mockResolvedValueOnce('Bob');
    await router().select(input, signal);
    expect(judge.mock.calls[0][0]).toMatchObject({ timeoutMs: 3000 });
    set(500);
    expect(router().timeoutMs()).toBe(500);
    set(100);
    expect(router().timeoutMs()).toBe(500);
    set(60_000);
    expect(router().timeoutMs()).toBe(30_000);
  });

  it.each(['judge', 'pi-classifier'])('%s 使用用户设置的 30 秒时限', async (source) => {
    settings = {
      botRouteClassifier: {
        source,
        model: judgeModel,
        timeoutMs: 30_000,
        timeoutSet: true,
      },
    };
    judge.mockResolvedValueOnce('Bob');
    classify.mockResolvedValueOnce({ b: 0.9 }).mockResolvedValueOnce({ answer: 0.9 });
    expect(router().timeoutMs()).toBe(30_000);
    expect(await router().select(input, signal)).toEqual({ ids: ['b'], intent: 'answer' });
    const calls = source === 'judge' ? judge.mock.calls : classify.mock.calls;
    expect(calls).toHaveLength(source === 'judge' ? 1 : 2);
    for (const [config] of calls) expect(config.timeoutMs).toBe(30_000);
  });

  it('judge 选中忙碌成员且判为新任务时标 separate；延续任务或选中空闲成员时不标', async () => {
    const busy: SmartRouteInput = {
      ...input,
      candidates: input.candidates.map((c) =>
        c.id === 'b' ? { ...c, busy: { task: 'migrate db' } } : c
      ),
    };
    judge.mockResolvedValueOnce('INTENT: build\nBob\nTASK: new');
    expect(await router().select(busy, signal)).toEqual({
      ids: ['b'],
      intent: 'build',
      separate: true,
    });
    expect(judge.mock.calls[0][0].userText).toMatch(/TASK: continue/);
    judge.mockResolvedValueOnce('INTENT: build\nBob\nTASK: continue');
    expect(await router().select(busy, signal)).toEqual({ ids: ['b'], intent: 'build' });
    judge.mockResolvedValueOnce('INTENT: build\nCarol\nTASK: new');
    expect(await router().select(busy, signal)).toEqual({ ids: ['c'], intent: 'build' });
  });

  it('pi-classifier 选中忙碌成员时再问一次延续还是新任务；未选中忙碌成员不多问', async () => {
    settings = {
      botRouteClassifier: {
        source: 'pi-classifier',
        model: { providerId: 'or', modelId: 'cls' },
        timeoutMs: 3000,
      },
    };
    const busy: SmartRouteInput = {
      ...input,
      candidates: input.candidates.map((c) =>
        c.id === 'b' ? { ...c, busy: { task: 'migrate db' } } : c
      ),
    };
    let route: Record<string, number> = { b: 0.9 };
    let task: Record<string, number> = { new: 0.8, continue: 0.2 };
    classify.mockImplementation(async (_config, question) =>
      'build' in question.criteria ? { answer: 0.9 } : 'new' in question.criteria ? task : route
    );
    expect(await router().select(busy, signal)).toEqual({
      ids: ['b'],
      intent: 'answer',
      separate: true,
    });
    expect(classify).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(classify.mock.calls[2][1])).toContain('migrate db');
    task = { new: 0.3, continue: 0.7 };
    expect(await router().select(busy, signal)).toEqual({ ids: ['b'], intent: 'answer' });
    classify.mockClear();
    route = { c: 0.9 };
    expect(await router().select(busy, signal)).toEqual({ ids: ['c'], intent: 'answer' });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('judge 回复多名时按顺序返回名单', async () => {
    judge.mockResolvedValueOnce('INTENT: discuss\nCarol\nBob');
    expect(await router().select(input, signal)).toEqual({ ids: ['c', 'b'], intent: 'discuss' });
  });

  it('judge 三名有效成员照常保留，第四名截断', async () => {
    judge.mockResolvedValueOnce('INTENT: discuss\nCarol\nBob\nAlice\nDave');
    const four = {
      ...input,
      candidates: [
        ...input.candidates,
        { id: 'd', name: 'Dave', title: '', scope: '', canAct: true, owner: false },
      ],
    };
    expect(await router().select(four, signal)).toEqual({
      ids: ['c', 'b', 'a'],
      intent: 'discuss',
    });
  });

  it('合法表所有成员低于 0.4：answer 不提示，build 按概率找能动手者', async () => {
    settings = {
      botRouteClassifier: { source: 'pi-classifier', model: judgeModel, timeoutMs: 3000 },
    };
    classify.mockImplementation(async (_config, question) =>
      'build' in question.criteria ? null : { a: 0.35, b: 0.3, c: 0.34 }
    );
    expect(await router().select(input, signal)).toEqual({ ids: [], intent: 'answer' });
    expect(await router().select({ ...input, message: 'please fix the api' }, signal)).toEqual({
      ids: ['c'],
      intent: 'build',
    });
  });

  it('没有群主时 judge 仅在否定句提到 boss，不算明确点名，不得按 build 擅自挑人', async () => {
    judge.mockResolvedValueOnce('INTENT: build\nI cannot identify the boss');
    expect(await router().select({ ...input, bossBotId: null }, signal)).toEqual({
      ids: [],
      failure: '判断结果无法识别',
    });
  });

  it('有群主时 judge 仅在散文里提到 boss 同样报无法识别；整段 BOSS（含允许的列表标记与句点）照常交给群主', async () => {
    judge.mockResolvedValueOnce('INTENT: build\nI think the boss should handle this');
    expect(await router().select(input, signal)).toEqual({
      ids: [],
      failure: '判断结果无法识别',
    });
    judge.mockResolvedValueOnce('INTENT: discuss\n1. BOSS.');
    expect(await router().select(input, signal)).toEqual({ ids: ['a'], intent: 'discuss' });
  });

  it('judge 判定 build 时只留一位能动手的成员；首位用群主名字点到只读群主则交给群主；缺 INTENT 行按关键词兜底', async () => {
    judge.mockResolvedValueOnce('INTENT: build\nCarol\nAlice\nBob');
    expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'build' });
    judge.mockResolvedValueOnce('INTENT: build\nAlice\nCarol\nBob');
    expect(await router().select(input, signal)).toEqual({ ids: [], intent: 'build' });
    judge.mockResolvedValueOnce('Bob, Carol');
    expect(await router().select({ ...input, message: '把 README 标题改成 X' }, signal)).toEqual({
      ids: ['b'],
      intent: 'build',
    });
    judge.mockResolvedValueOnce('Alice, Bob');
    expect(await router().select({ ...input, message: '把 README 标题改成 X' }, signal)).toEqual({
      ids: [],
      intent: 'build',
    });
  });

  it('judge 回复不认识时报「判断结果无法识别」；没有可用模型时带失败原因', async () => {
    judge.mockResolvedValueOnce('maybe Dave');
    expect(await router().select(input, signal)).toEqual({
      ids: [],
      failure: '判断结果无法识别',
    });
    judge.mockResolvedValueOnce(null);
    const failed = await router().select(input, signal);
    expect(failed.ids).toEqual([]);
    expect(failed.failure).toBeTruthy();
  });

  it.each(['', 'maybe Dave', 'INTENT: build', 'INTENT: discuss\n', 'bossy'])(
    'judge 回复 %j 既没有名单也不是 BOSS：报无法识别、不带意图，不按意图挑人',
    async (reply) => {
      judge.mockResolvedValueOnce(reply);
      expect(await router().select({ ...input, message: '把 README 标题改成 X' }, signal)).toEqual({
        ids: [],
        failure: '判断结果无法识别',
      });
    }
  );

  it('judge 明确回 BOSS：正常交给群主，不报 failure（群里没有群主时也一样）', async () => {
    judge.mockResolvedValueOnce('INTENT: discuss\nBOSS');
    expect(await router().select(input, signal)).toEqual({ ids: ['a'], intent: 'discuss' });
    judge.mockResolvedValueOnce('BOSS');
    const noBoss = await router().select({ ...input, bossBotId: null }, signal);
    expect(noBoss).toEqual({ ids: [], intent: 'answer' });
  });

  describe('judge 名单首位是群主（BOSS 或群主名字）且意图是 build：以群主为准', () => {
    it('群主名字是普通词时沿用成员解析，不额外收紧或扩大名单匹配', async () => {
      const named = {
        ...input,
        candidates: input.candidates.map((c) => (c.owner ? { ...c, name: '前端' } : c)),
      };
      // 既有解析器允许成员名出现在句中；需求以解析后的名单首位为准。
      judge.mockResolvedValueOnce('INTENT: build\n建议前端处理');
      expect(await router().select(named, signal)).toEqual({ ids: [], intent: 'build' });
      judge.mockResolvedValueOnce('INTENT: build\nBob, 前端');
      expect(await router().select(named, signal)).toEqual({ ids: ['b'], intent: 'build' });
      judge.mockResolvedValueOnce('INTENT: build\n未知成员');
      expect(await router().select(named, signal)).toEqual({
        ids: [],
        failure: '判断结果无法识别',
      });
    });

    it('群主只读、有人能动手：交给群主（名单留空，不附执行提示），不改派给能动手的人', async () => {
      for (const reply of [
        'INTENT: build\nBOSS',
        'INTENT: build\n1. BOSS.',
        'BOSS',
        'INTENT: build\nAlice',
        'INTENT: build\n1. alice.',
        'Alice',
      ]) {
        judge.mockResolvedValueOnce(reply);
        expect(
          await router().select({ ...input, message: '把 README 标题改成 X' }, signal)
        ).toEqual({ ids: [], intent: 'build' });
      }
    });

    it('「BOSS / 群主名, 成员」整个交给群主；「成员, BOSS / 群主名」照 build 规则选首位能动手者', async () => {
      judge.mockResolvedValueOnce('INTENT: build\nBOSS, Carol');
      expect(await router().select(input, signal)).toEqual({ ids: [], intent: 'build' });
      judge.mockResolvedValueOnce('INTENT: build\nAlice, Carol');
      expect(await router().select(input, signal)).toEqual({ ids: [], intent: 'build' });
      judge.mockResolvedValueOnce('INTENT: build\nCarol, BOSS');
      expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'build' });
      judge.mockResolvedValueOnce('INTENT: build\nCarol, Alice');
      expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'build' });
    });

    it('成员本身叫 Boss 时 BOSS 指该成员：照 build 规则选它，不当作点名群主', async () => {
      const named = {
        ...input,
        candidates: [
          ...input.candidates,
          { id: 'm', name: 'Boss', title: '', scope: '', canAct: true, owner: false },
        ],
      };
      judge.mockResolvedValueOnce('INTENT: build\nBOSS\nBob');
      expect(await router().select(named, signal)).toEqual({ ids: ['m'], intent: 'build' });
    });

    it('群主能动手时行为不变：选群主', async () => {
      const capable = {
        ...input,
        candidates: input.candidates.map((c) => (c.owner ? { ...c, canAct: true } : c)),
      };
      judge.mockResolvedValueOnce('INTENT: build\nBOSS\nCarol');
      expect(await router().select(capable, signal)).toEqual({ ids: ['a'], intent: 'build' });
      judge.mockResolvedValueOnce('INTENT: build\nAlice\nCarol');
      expect(await router().select(capable, signal)).toEqual({ ids: ['a'], intent: 'build' });
    });

    it('没有任何能动手的成员时仍提示 noWriter', async () => {
      const readonly = {
        ...input,
        candidates: input.candidates.map((c) => ({ ...c, canAct: false })),
      };
      judge.mockResolvedValueOnce('INTENT: build\nBOSS');
      expect(await router().select(readonly, signal)).toEqual({
        ids: [],
        intent: 'build',
        noWriter: true,
      });
      judge.mockResolvedValueOnce('INTENT: build\nAlice');
      expect(await router().select(readonly, signal)).toEqual({
        ids: [],
        intent: 'build',
        noWriter: true,
      });
    });

    it('answer / discuss 行为不变', async () => {
      judge.mockResolvedValueOnce('INTENT: answer\nBOSS\nCarol');
      expect(await router().select(input, signal)).toEqual({ ids: ['a', 'c'], intent: 'answer' });
      judge.mockResolvedValueOnce('INTENT: discuss\nBOSS');
      expect(await router().select(input, signal)).toEqual({ ids: ['a'], intent: 'discuss' });
    });

    it('没有群主时行为不变：BOSS 不报无法识别，build 照规则选能动手者', async () => {
      judge.mockResolvedValueOnce('INTENT: build\nBOSS');
      expect(await router().select({ ...input, bossBotId: null }, signal)).toEqual({
        ids: ['b'],
        intent: 'build',
      });
    });

    it('pi 分类器没有 BOSS 选项：群主概率最高也照 build 规则选能动手者', async () => {
      settings = {
        botRouteClassifier: { source: 'pi-classifier', model: judgeModel, timeoutMs: 3000 },
      };
      classify.mockImplementation(async (_config, question) =>
        'build' in question.criteria
          ? { build: 0.9, answer: 0.05, discuss: 0.05 }
          : { a: 0.8, c: 0.15, b: 0.05 }
      );
      expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'build' });
    });
  });

  it('judge 抛错时透出归类原因', async () => {
    judge.mockRejectedValueOnce(new Error('模型 gpt-5：鉴权失败'));
    const failed = await router().select(input, signal);
    expect(failed).toEqual({ ids: [], failure: '模型 gpt-5：鉴权失败' });
  });

  it('pi-classifier 取达到 0.4 的候选（降序），都不达标或不可用时返回空名单', async () => {
    settings = {
      botRouteClassifier: {
        source: 'pi-classifier',
        model: { providerId: 'or', modelId: 'cls' },
        timeoutMs: 3000,
      },
    };
    classify.mockResolvedValueOnce({ a: 0.3, b: 0.7 });
    expect((await router().select(input, signal)).ids).toEqual(['b']);
    const [config, question] = classify.mock.calls[0];
    expect(config).toMatchObject({
      source: 'pi-classifier',
      model: { modelId: 'cls' },
      timeoutMs: 15_000,
    });
    expect(classify.mock.calls[1][0].timeoutMs).toBe(15_000);
    expect(Object.keys(question.criteria)).toEqual(['a', 'b', 'c']);
    classify.mockResolvedValueOnce({ a: 0.1, b: 0.42, c: 0.48 }).mockResolvedValueOnce(null);
    expect((await router().select(input, signal)).ids).toEqual(['c', 'b']);
    classify.mockResolvedValueOnce({ a: 0.35, b: 0.3, c: 0.35 }).mockResolvedValueOnce(null);
    expect((await router().select(input, signal)).ids).toEqual([]);
    classify.mockResolvedValueOnce(null);
    expect((await router().select(input, signal)).failure).toBeTruthy();
    expect(judge).not.toHaveBeenCalled();
  });

  describe('pi-classifier 成员概率表的合法性', () => {
    const withClassifier = (members: unknown, intents: unknown = null) => {
      settings = {
        botRouteClassifier: { source: 'pi-classifier', model: judgeModel, timeoutMs: 3000 },
      };
      classify.mockImplementation(async (_config, question) =>
        'build' in question.criteria ? intents : members
      );
    };

    it.each<[string, Record<string, number>]>([
      ['空表', {}],
      ['只有名单外键', { ghost: 1 }],
      ['越界值', { b: -1, c: 2 }],
      ['NaN', { a: Number.NaN, b: 0.9 }],
      ['Infinity', { b: Number.POSITIVE_INFINITY }],
      ['全 0', { a: 0, b: 0, c: 0 }],
      ['总和超上限', { a: 0.7, b: 0.2, c: 0.2 }],
    ])('%s：报「判断结果无法识别」交给群主，build 意图也不按意图挑人', async (_label, members) => {
      withClassifier(members, { build: 0.9, answer: 0.05, discuss: 0.05 });
      expect(await router().select(input, signal)).toEqual({
        ids: [],
        failure: '判断结果无法识别',
      });
      expect(console.warn).toHaveBeenCalled();
      expect(judge).not.toHaveBeenCalled();
    });

    it('合法的完整表与稀疏表照常选人，不报 failure', async () => {
      withClassifier({ a: 0.2, b: 0.7, c: 0.1 });
      expect(await router().select(input, signal)).toEqual({ ids: ['b'], intent: 'answer' });
      withClassifier({ c: 0.9 });
      expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'answer' });
      withClassifier({ a: 0.34, b: 0.33, c: 0.34 });
      expect(await router().select(input, signal)).toEqual({ ids: [], intent: 'answer' });
    });

    it('意图概率表不合法：走关键词兜底，不算失败、不提示', async () => {
      for (const intents of [
        {},
        { ghost: 1 },
        { build: -1, answer: 2 },
        { build: Number.NaN },
        { build: 0, answer: 0, discuss: 0 },
        { build: 0.9, answer: 0.9, discuss: 0 },
      ]) {
        withClassifier({ a: 0.1, b: 0.8, c: 0.1 }, intents);
        expect(await router().select({ ...input, message: 'please fix the api' }, signal)).toEqual({
          ids: ['b'],
          intent: 'build',
        });
        expect(await router().select(input, signal)).toEqual({ ids: ['b'], intent: 'answer' });
      }
    });
  });

  it('pi-classifier 抛错时透出原因给群里', async () => {
    settings = {
      botRouteClassifier: {
        source: 'pi-classifier',
        model: { providerId: 'or', modelId: 'cls' },
        timeoutMs: 3000,
      },
    };
    classify.mockRejectedValueOnce(new Error('模型 cls：网络连接失败')).mockResolvedValueOnce(null);
    const failed = await router().select(input, signal);
    expect(failed).toEqual({ ids: [], failure: '模型 cls：网络连接失败' });
  });

  it('pi-classifier 另问意图；build 按概率取第一位能动手的成员，意图不确定时用关键词', async () => {
    settings = {
      botRouteClassifier: {
        source: 'pi-classifier',
        model: { providerId: 'or', modelId: 'cls' },
        timeoutMs: 3000,
      },
    };
    classify.mockImplementation(async (_config, question) =>
      'build' in question.criteria
        ? { build: 0.8, answer: 0.1, discuss: 0.1 }
        : { a: 0.6, b: 0.1, c: 0.3 }
    );
    expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'build' });
    classify.mockImplementation(async (_config, question) =>
      'build' in question.criteria
        ? { build: 0.4, answer: 0.3, discuss: 0.3 }
        : { a: 0.5, b: 0.45, c: 0.05 }
    );
    expect(await router().select(input, signal)).toEqual({ ids: ['a', 'b'], intent: 'answer' });
    expect(await router().select({ ...input, message: 'please fix the api' }, signal)).toEqual({
      ids: ['b'],
      intent: 'build',
    });
  });
});

describe('讨论判断 next()', () => {
  const discuss: DiscussNextInput = {
    candidates: [
      { id: 'b', name: 'Bob', title: '', scope: 'backend', turns: 1 },
      { id: 'c', name: 'Carol', title: '', scope: 'frontend', turns: 0 },
    ],
    topic: '讨论下方案',
    recent: [{ speaker: 'Alice', text: '我先说' }],
    lastSpeaker: 'Alice',
  };

  it('未设置时走 judge 回退链：NEXT / END，默认超时 15s、限输出', async () => {
    judge.mockResolvedValueOnce('NEXT: Carol').mockResolvedValueOnce('END');
    expect(await router().next(discuss, signal)).toEqual({ next: 'c' });
    expect(await router().next(discuss, signal)).toEqual({ end: true });
    expect(judge.mock.calls[0][0]).toMatchObject({
      preferred: undefined,
      timeoutMs: 15_000,
      maxTokens: 128,
    });
    expect(judge.mock.calls[0][0].userText).toContain('NEXT: <name>');
    // 讨论判断的 judge 请求带 #33 的新规则：END 只表示已有结论，兜圈子交给群主拍板
    expect(judge.mock.calls[0][0].userText).toContain(
      'Answer END only when the discussion has reached a conclusion or a clear next step'
    );
    expect(judge.mock.calls[0][0].userText).toContain('pick the group owner');
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    { label: '未设置', classifier: undefined, expected: 15_000 },
    { label: '旧版默认 3000 未明确设置', classifier: { timeoutMs: 3000 }, expected: 15_000 },
    { label: '明确设成 3000', classifier: { timeoutMs: 3000, timeoutSet: true }, expected: 3000 },
    { label: '自定义 12s', classifier: { timeoutMs: 12_000 }, expected: 12_000 },
    // 上限随 4afd25f8 放宽到 30 秒（CLASSIFIER_TIMEOUT_MAX_MS）
    { label: '超过上限', classifier: { timeoutMs: 60_000, timeoutSet: true }, expected: 30_000 },
    { label: '低于下限', classifier: { timeoutMs: 100, timeoutSet: true }, expected: 500 },
  ])(
    '讨论判断与首轮选人同一套超时规则（judge）：$label → $expected',
    async ({ classifier, expected }) => {
      settings = classifier
        ? { botRouteClassifier: { source: 'judge', model: judgeModel, ...classifier } }
        : {};
      judge.mockResolvedValueOnce('Bob').mockResolvedValueOnce('END');
      await router().select(input, signal);
      await router().next(discuss, signal);
      expect(router().timeoutMs()).toBe(expected);
      expect(judge.mock.calls.map((call) => call[0].timeoutMs)).toEqual([expected, expected]);
      expect(judge.mock.calls.map((call) => call[0].maxTokens)).toEqual([128, 128]);
    }
  );

  it.each([
    { classifier: { timeoutMs: 3000 }, expected: 15_000 },
    { classifier: { timeoutMs: 3000, timeoutSet: true }, expected: 3000 },
    { classifier: { timeoutMs: 60_000, timeoutSet: true }, expected: 30_000 },
    { classifier: { timeoutMs: 100, timeoutSet: true }, expected: 500 },
  ])('讨论判断与首轮选人同一套超时规则（pi 分类器）：%j', async ({ classifier, expected }) => {
    settings = {
      botRouteClassifier: { source: 'pi-classifier', model: judgeModel, ...classifier },
    };
    classify
      .mockResolvedValueOnce({ a: 0.1, b: 0.9, c: 0 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ b: 0.1, c: 0.8, end: 0.1 });
    await router().select(input, signal);
    expect(await router().next(discuss, signal)).toEqual({ next: 'c' });
    expect(router().timeoutMs()).toBe(expected);
    expect(classify.mock.calls.map((call) => call[0].timeoutMs)).toEqual([
      expected,
      expected,
      expected,
    ]);
  });

  it('judge 不可用、回复无法识别、抛错都返回 failure', async () => {
    judge.mockResolvedValueOnce(null);
    expect(await router().next(discuss, signal)).toEqual({ failure: '判断模型不可用' });
    judge.mockResolvedValueOnce('Carol 吧');
    expect(await router().next(discuss, signal)).toEqual({ failure: '判断结果无法识别' });
    judge.mockRejectedValueOnce(new Error('boom'));
    expect(await router().next(discuss, signal)).toMatchObject({ failure: expect.any(String) });
  });

  it('设成 pi 分类器时用分类器，选项含保留键 end', async () => {
    settings = {
      botRouteClassifier: { source: 'pi-classifier', model: judgeModel, timeoutMs: 4000 },
    };
    classify.mockResolvedValueOnce({ b: 0.1, c: 0.8, end: 0.1 });
    expect(await router().next(discuss, signal)).toEqual({ next: 'c' });
    expect(Object.keys(classify.mock.calls[0][1].criteria)).toEqual(['b', 'c', 'end']);
    classify.mockResolvedValueOnce({ b: 0.1, c: 0.2, end: 0.7 });
    expect(await router().next(discuss, signal)).toEqual({ end: true });
    classify.mockResolvedValueOnce(null);
    expect(await router().next(discuss, signal)).toEqual({ failure: '判断模型不可用' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('取消时不报 failure', async () => {
    const abort = new AbortController();
    judge.mockImplementationOnce(async () => {
      abort.abort();
      throw new Error('aborted');
    });
    expect(await router().next(discuss, abort.signal)).toEqual({ end: true });
  });

  it.each([{}, { ghost: 1 }, { b: Number.NaN, c: Number.POSITIVE_INFINITY }, { b: -1, c: 2 }])(
    '分类器无法识别的概率结果 %j 必须报 failure，不能当成正常 END 或 NEXT',
    async (probabilities) => {
      settings = {
        botRouteClassifier: { source: 'pi-classifier', model: judgeModel, timeoutMs: 4000 },
      };
      classify.mockResolvedValueOnce(probabilities);
      expect(await router().next(discuss, signal)).toMatchObject({ failure: expect.any(String) });
    }
  );
});
