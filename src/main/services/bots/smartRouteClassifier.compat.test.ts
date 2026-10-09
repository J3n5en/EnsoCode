import type { ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai';
import { classify as typesafeClassify } from '@earendil-works/pi-ai/api/typesafe-system-one';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartRouteInput } from '../../../shared/bots/smartRoute';
import { createSmartRouter, type SmartRouterDeps } from './smartRouter';

/**
 * 首轮智能选人走 pi 分类器时，结果规则要对 TypeSafe 官方 Jev 成立：
 * 直接调用真实 typesafe-system-one adapter（pi 目录里的 jev-latest 条目），只模拟 HTTP；
 * Main 侧按 worker（supervisor.classifyChoice）的方式只取有限数概率，再交给 createSmartRouter。
 * 成员题与意图题各是一道单选（choice）题：成员题的键是每位候选的 id（群主也是普通候选，没有 BOSS 保留键）。
 */

const input: SmartRouteInput = {
  candidates: [
    { id: 'a', name: 'Alice', title: '群主', scope: 'lead', canAct: false, owner: true },
    { id: 'b', name: 'Bob', title: '后端', scope: '接口', canAct: true, owner: false },
    { id: 'c', name: 'Carol', title: '前端', scope: '页面', canAct: true, owner: false },
  ],
  bossBotId: 'a',
  recent: [{ speaker: 'Human', text: '上次说的接口' }],
  message: 'who owns the api',
};

/** pi 目录里的 TypeSafe 官方 Jev 分类器条目 */
function catalogJev(): ClassifierModel<'typesafe-system-one'> {
  const entry = typesafeProvider()
    .getAllModels?.()
    .find((item) => item.id === 'jev-latest');
  if (entry?.type !== 'classifier' || entry.api !== 'typesafe-system-one')
    throw new Error('jev-latest classifier missing from the pi catalog');
  return entry as ClassifierModel<'typesafe-system-one'>;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const answerBody = (probabilities: Record<string, unknown>) => ({
  model: 'jev-1.13.0',
  answers: {
    choice: {
      type: 'choice',
      choice: Object.keys(probabilities)[0] ?? 'a',
      confidence: 0.8,
      probabilities,
    },
  },
  usage: { input_tokens: 10, output_tokens: 1 },
});

interface SentBody {
  model?: string;
  questions?: Record<string, { type?: string; criteria?: Record<string, string> }>;
}

let members: Record<string, unknown>;
let intents: Record<string, unknown>;
const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as SentBody;
  const criteria = body.questions?.choice?.criteria ?? {};
  return json(answerBody('build' in criteria ? intents : members));
});

/** 与 worker 一致：单个 choice 问题，stopReason 不是 stop 视为不可用，只取有限数概率交给 Main */
const classify: SmartRouterDeps['classify'] = async (_config, question, signal) => {
  const result: ClassifierResult = await typesafeClassify(
    catalogJev(),
    {
      state: question.state as never,
      questions: {
        choice: {
          type: 'choice',
          instructions: question.instructions,
          criteria: question.criteria,
        },
      },
    },
    { apiKey: 'test-key', fetch: fetch as never, maxRetries: 0, signal }
  );
  const answer = result.answers.choice;
  if (result.stopReason !== 'stop' || answer?.type !== 'choice') return null;
  return Object.fromEntries(
    Object.entries(answer.probabilities).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  );
};

const router = () =>
  createSmartRouter({
    settings: () => ({
      botRouteClassifier: {
        source: 'pi-classifier',
        model: { providerId: 'typesafe', modelId: 'jev-latest' },
        timeoutMs: 3000,
      },
    }),
    judge: vi.fn(),
    classify,
  });
const signal = new AbortController().signal;

beforeEach(() => {
  fetch.mockClear();
  members = { a: 0.1, b: 0.8, c: 0.1 };
  intents = { build: 0.1, answer: 0.8, discuss: 0.1 };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('TypeSafe 官方 Jev：首轮智能选人', () => {
  it('发给 Jev 的是两道单选题：成员题键为每位候选，意图题键为三种意图', async () => {
    expect(await router().select(input, signal)).toEqual({ ids: ['b'], intent: 'answer' });
    const bodies = fetch.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body ?? '{}')) as SentBody
    );
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.typesafe.ai/v1/systemone',
      'https://api.typesafe.ai/v1/systemone',
    ]);
    expect(bodies.map((body) => body.model)).toEqual(['jev-latest', 'jev-latest']);
    expect(bodies.map((body) => body.questions?.choice?.type)).toEqual(['choice', 'choice']);
    expect(bodies.map((body) => Object.keys(body.questions?.choice?.criteria ?? {}))).toEqual([
      ['a', 'b', 'c'],
      ['build', 'answer', 'discuss'],
    ]);
  });

  it('完整表（两位小数舍入）与稀疏表照常选人', async () => {
    members = { a: 0.13, b: 0.42, c: 0.45 };
    expect(await router().select(input, signal)).toEqual({ ids: ['c', 'b'], intent: 'answer' });
    members = { c: 0.9 };
    expect(await router().select(input, signal)).toEqual({ ids: ['c'], intent: 'answer' });
    members = { a: 0.34, b: 0.33, c: 0.34 };
    expect(await router().select(input, signal)).toEqual({ ids: [], intent: 'answer' });
  });

  it('空表、名单外键、越界、全 0、超额表：adapter 原样透传，选人报「判断结果无法识别」', async () => {
    for (const probabilities of [
      {},
      { ghost: 1 },
      { b: -1, c: 2 },
      { a: 0, b: 0, c: 0 },
      { a: 0.7, b: 0.2, c: 0.2 },
      { a: 1, b: 1, c: 1 },
    ]) {
      members = probabilities;
      expect(await router().select(input, signal), JSON.stringify(probabilities)).toEqual({
        ids: [],
        failure: '判断结果无法识别',
      });
    }
  });

  it('意图表不合法：走关键词兜底，选人照常', async () => {
    intents = { build: 0.9, answer: 0.9, discuss: 0.9 };
    expect(await router().select({ ...input, message: 'please fix the api' }, signal)).toEqual({
      ids: ['b'],
      intent: 'build',
    });
    intents = { ghost: 1 };
    expect(await router().select(input, signal)).toEqual({ ids: ['b'], intent: 'answer' });
  });

  it('非数字概率在 adapter 层就报错：按「选人模型不可用」交给群主', async () => {
    members = { a: 'NaN', b: 0.1, c: 0.1 };
    expect(await router().select(input, signal)).toEqual({
      ids: [],
      failure: '选人模型不可用',
    });
  });
});
