import type { ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai';
import { classify as cloudflareClassify } from '@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one';
import { classify as llamaCppClassify } from '@earendil-works/pi-ai/api/llama-cpp-classify';
import { classify as typesafeClassify } from '@earendil-works/pi-ai/api/typesafe-system-one';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import { describe, expect, it, vi } from 'vitest';
import {
  type DiscussNextInput,
  discussNextQuestion,
  pickDiscussNext,
} from '../../../shared/bots/discussRoute';

/**
 * 讨论判断的分类器结果规则要对 pi 的所有分类器后端成立：直接调用真实 adapter，只模拟 HTTP。
 * - llama-cpp-classify：本地对全部选项做 softmax，键表完整、和为 1；
 * - typesafe-system-one（TypeSafe / OpenRouter / Vercel AI Gateway / OpenCode 共用）与
 *   cloudflare-workers-ai-system-one：原样读出服务端概率表，只校验是有限数，不补键、不归一化。
 * - TypeSafe 官方 Jev：用 pi 目录里预置的 jev-latest 条目本身（worker 按 provider=typesafe 解析的就是它）。
 */

const input: DiscussNextInput = {
  candidates: [
    { id: 'b', name: 'Bob', title: '后端', scope: '接口', turns: 0 },
    { id: 'c', name: 'Carol', title: '前端', scope: '页面', turns: 1 },
  ],
  topic: '讨论下方案',
  recent: [{ speaker: 'Alice', text: '我先说' }],
  lastSpeaker: 'Alice',
};

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model = <T extends string>(api: T, provider: string, id: string, baseUrl: string) =>
  ({
    type: 'classifier',
    api,
    provider,
    id,
    name: id,
    baseUrl,
    input: ['text'],
    cost,
    contextWindow: 32000,
  }) as unknown as ClassifierModel<T>;

/** 与 worker（supervisor.classifyChoice）一致：单个 choice 问题，只取有限数概率交给 Main */
function context() {
  const question = discussNextQuestion(input);
  return {
    state: question.state as never,
    questions: {
      choice: {
        type: 'choice' as const,
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  };
}
function probabilitiesOf(result: ClassifierResult): Record<string, number> {
  expect(result.stopReason).toBe('stop');
  const answer = result.answers.choice;
  if (answer?.type !== 'choice') throw new Error('not a choice answer');
  return Object.fromEntries(
    Object.entries(answer.probabilities).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  );
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** pi 目录里的 TypeSafe 官方 Jev 分类器条目 */
function catalogJev(): ClassifierModel<'typesafe-system-one'> {
  const entry = typesafeProvider()
    .getAllModels?.()
    .find((item) => item.id === 'jev-latest');
  if (entry?.type !== 'classifier' || entry.api !== 'typesafe-system-one')
    throw new Error('jev-latest classifier missing from the pi catalog');
  return entry as ClassifierModel<'typesafe-system-one'>;
}

describe('llama-cpp-classify：完整概率表', () => {
  const labels = [...'ABC'];
  const tokenOf = (label: string) => 100 + labels.indexOf(label);
  const server = (weights: number[]) =>
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as { content?: string };
      if (path === '/tokenize') {
        const content = body.content ?? '';
        const rest = content.startsWith('\n') ? content.slice(1) : content;
        const tokens = [
          ...(content.startsWith('\n') ? [10] : []),
          ...(rest ? [tokenOf(rest)] : []),
        ];
        return json({ tokens });
      }
      if (path === '/apply-template') return json({ prompt: 'PROMPT' });
      if (path === '/completion')
        return json({
          completion_probabilities: [
            {
              top_logprobs: weights.map((weight, index) => ({
                id: 100 + index,
                logprob: Math.log(weight),
              })),
            },
          ],
        });
      throw new Error(`unexpected ${path}`);
    });
  const run = async (weights: number[]) => {
    const fetch = server(weights);
    const result = await llamaCppClassify(
      model('llama-cpp-classify', 'local-llama', 'qwen3-4b', 'http://127.0.0.1:8080/v1'),
      context(),
      { fetch: fetch as never, maxRetries: 0 }
    );
    expect(fetch).toHaveBeenCalled();
    return probabilitiesOf(result);
  };

  it('键表完整、和为 1，按最高成员选人或结束', async () => {
    const picked = await run([0.7, 0.1, 0.2]);
    expect(Object.keys(picked)).toEqual(['b', 'c', 'end']);
    expect(picked.b! + picked.c! + picked.end!).toBeCloseTo(1, 12);
    expect(pickDiscussNext(picked, input)).toEqual({ next: 'b' });
    expect(pickDiscussNext(await run([0.2, 0.2, 0.6]), input)).toEqual({ end: true });
    expect(pickDiscussNext(await run([0.35, 0.3, 0.35]), input)).toEqual({ end: true });
    // 最高成员不到 0.4 且 end 更低：交给群主（Carol），群主不在候选里才结束
    const unsure = await run([0.38, 0.3, 0.32]);
    const owned: DiscussNextInput = {
      ...input,
      candidates: input.candidates.map((c) => (c.id === 'c' ? { ...c, owner: true } : c)),
    };
    expect(pickDiscussNext(unsure, owned)).toEqual({ next: 'c' });
    expect(pickDiscussNext(unsure, input)).toEqual({ end: true });
  });
});

const answerBody = (probabilities: Record<string, unknown>) => ({
  model: 'jev-1.13.0',
  answers: {
    choice: {
      type: 'choice',
      choice: Object.keys(probabilities)[0] ?? 'end',
      confidence: 0.8,
      probabilities,
    },
  },
  usage: { input_tokens: 10, output_tokens: 1 },
});

const remotes = [
  {
    name: 'TypeSafe',
    classify: typesafeClassify,
    model: model('typesafe-system-one', 'typesafe', 'jev-latest', 'https://api.typesafe.ai/v1/'),
    url: 'https://api.typesafe.ai/v1/systemone',
    wrap: (body: unknown) => body,
  },
  {
    name: 'TypeSafe 官方 Jev（pi 目录条目）',
    classify: typesafeClassify,
    model: catalogJev(),
    url: 'https://api.typesafe.ai/v1/systemone',
    wrap: (body: unknown) => body,
  },
  {
    name: 'OpenRouter',
    classify: typesafeClassify,
    model: model(
      'typesafe-system-one',
      'openrouter',
      'typesafe/jev-1.13',
      'https://openrouter.ai/api/v1'
    ),
    url: 'https://openrouter.ai/api/v1/systemone',
    wrap: (body: unknown) => body,
  },
  {
    name: 'Cloudflare Workers AI',
    classify: cloudflareClassify,
    model: model(
      'cloudflare-workers-ai-system-one',
      'cloudflare-workers-ai',
      'typesafe/jev',
      'https://api.cloudflare.com/client/v4/accounts/acct/ai'
    ),
    url: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run',
    wrap: (body: unknown) => ({ success: true, result: { state: 'Completed', result: body } }),
  },
];

describe.each(remotes)('$name：服务端概率表原样透传', (remote) => {
  const run = async (probabilities: Record<string, unknown>) => {
    const fetch = vi.fn(async () => json(remote.wrap(answerBody(probabilities))));
    const result = await remote.classify(remote.model as never, context(), {
      apiKey: 'test-key',
      fetch: fetch as never,
      maxRetries: 0,
    });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(remote.url);
    return result;
  };

  it('完整表（两位小数舍入）照常判断', async () => {
    const picked = probabilitiesOf(await run({ b: 0.84, c: 0.16, end: 0 }));
    expect(pickDiscussNext(picked, input)).toEqual({ next: 'b' });
    const even = probabilitiesOf(await run({ b: 0.33, c: 0.33, end: 0.33 }));
    expect(pickDiscussNext(even, input)).toEqual({ end: true });
  });

  it('稀疏表：adapter 不补键，缺的选项按 0 判断', async () => {
    const sparse = probabilitiesOf(await run({ b: 0.9 }));
    expect(sparse).toEqual({ b: 0.9 });
    expect(pickDiscussNext(sparse, input)).toEqual({ next: 'b' });
    expect(pickDiscussNext(probabilitiesOf(await run({ end: 0.9 })), input)).toEqual({
      end: true,
    });
    expect(pickDiscussNext(probabilitiesOf(await run({ c: 0.3 })), input)).toEqual({ end: true });
  });

  it('舍入范围内的表：adapter 不归一化，按原值判断', async () => {
    const rounded = probabilitiesOf(await run({ b: 0.51, c: 0.25, end: 0.25 }));
    expect(rounded).toEqual({ b: 0.51, c: 0.25, end: 0.25 });
    expect(pickDiscussNext(rounded, input)).toEqual({ next: 'b' });
  });

  it('超额表：adapter 原样透传，判断层报 failure', async () => {
    for (const probabilities of [
      { b: 0.7, c: 0.2, end: 0.2 },
      { b: 1, c: 1, end: 0 },
      { b: 1, c: 1, end: 1 },
    ]) {
      const loose = probabilitiesOf(await run(probabilities));
      expect(loose).toEqual(probabilities);
      expect(pickDiscussNext(loose, input)).toEqual({ failure: '判断结果无法识别' });
    }
  });

  it('空表、名单外键、越界值仍判为 failure', async () => {
    for (const probabilities of [{}, { ghost: 1 }, { b: -1, c: 2 }]) {
      expect(pickDiscussNext(probabilitiesOf(await run(probabilities)), input)).toEqual({
        failure: '判断结果无法识别',
      });
    }
  });

  it('非数字概率在 adapter 层就报错，不会到达判断', async () => {
    const result = await run({ b: 'NaN', c: 0.1, end: 0.1 });
    expect(result.stopReason).toBe('error');
  });
});

describe('TypeSafe 官方 Jev：讨论判断的请求', () => {
  it('发给 Jev 的是同一道单选题：键为每位候选 + end', async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json(answerBody({ c: 0.7, b: 0.2, end: 0.1 }))
    );
    const result = await typesafeClassify(catalogJev(), context(), {
      apiKey: 'test-key',
      fetch: fetch as never,
      maxRetries: 0,
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? '{}')) as {
      model?: string;
      questions?: Record<string, { type?: string; criteria?: Record<string, string> }>;
    };
    expect(body.model).toBe('jev-latest');
    expect(body.questions?.choice?.type).toBe('choice');
    expect(Object.keys(body.questions?.choice?.criteria ?? {})).toEqual(['b', 'c', 'end']);
    expect(pickDiscussNext(probabilitiesOf(result), input)).toEqual({ next: 'c' });
  });
});
