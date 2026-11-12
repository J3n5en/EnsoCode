import { describe, expect, it } from 'vitest';
import { createGoalTools } from './goal';
import {
  buildGoalVerifierRequest,
  extractGoalObjective,
  GOAL_VERIFIER_RECORD_CHARS,
  parseGoalVerdict,
} from './goalVerifier';

const goalPrompt = (objective: string) =>
  `<goal-continuation>\nSession goal: ${objective}\nWork toward this goal autonomously. When done call goal_complete with evidence.\n</goal-continuation>`;
const user = (content: string) => ({ role: 'user', content });
const assistant = (...content: unknown[]) => ({ role: 'assistant', content });
const toolResult = (toolName: string, text: string, isError = false) => ({
  role: 'toolResult',
  toolName,
  toolCallId: `${toolName}-1`,
  content: [{ type: 'text', text }],
  isError,
});

describe('extractGoalObjective', () => {
  it('取最近一次目标提示里的目标正文（含续跑与恢复两种格式，可跨行）', () => {
    expect(extractGoalObjective([user('hi')])).toBeUndefined();
    expect(extractGoalObjective([user(goalPrompt('make tests\npass'))])?.objective).toBe(
      'make tests\npass'
    );
    const resumed =
      '<goal-continuation>\nSession goal resumed: ship it\nContinue working toward it (goal_complete / goal_blocked / goal_wait to stop).\n</goal-continuation>';
    expect(extractGoalObjective([user(goalPrompt('old')), user(resumed)])?.objective).toBe(
      'ship it'
    );
    expect(
      extractGoalObjective([{ role: 'user', content: [{ type: 'text', text: goalPrompt('x') }] }])
        ?.objective
    ).toBe('x');
  });
});

describe('buildGoalVerifierRequest', () => {
  it('证据新→旧，分出用户输入、模型陈述、工具观察与委托输出，思考与目标提示不算证据', () => {
    const messages = [
      user('unrelated earlier'),
      user(goalPrompt('tests pass')),
      assistant(
        { type: 'thinking', thinking: 'secret plan' },
        { type: 'text', text: 'Running tests.' },
        { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'pnpm test' } }
      ),
      toolResult('bash', '42 passed'),
      toolResult('subagent', 'all good, trust me'),
      user('also check lint'),
    ];
    const request = JSON.parse(buildGoalVerifierRequest({ messages, summary: 'Tests pass.' })!) as {
      objective: string;
      proposal: string;
      omitted: number;
      evidence: Array<{ proofKind: string; content: string }>;
    };
    expect(request.objective).toBe('tests pass');
    expect(request.proposal).toBe('Tests pass.');
    expect(request.omitted).toBe(0);
    expect(request.evidence.map((e) => e.proofKind)).toEqual([
      'user_input',
      'delegated_output',
      'tool_observation',
      'assistant_claim',
    ]);
    const all = JSON.stringify(request.evidence);
    expect(all).toContain('pnpm test');
    expect(all).not.toContain('secret plan');
    expect(all).not.toContain('unrelated earlier');
    expect(all).not.toContain('<goal-continuation>');
  });

  it('没有目标提示时返回 undefined；超长记录中间截断，超预算的旧记录计入 omitted', () => {
    expect(buildGoalVerifierRequest({ messages: [user('x')], summary: 's' })).toBeUndefined();
    const long = 'a'.repeat(GOAL_VERIFIER_RECORD_CHARS * 2);
    const messages = [
      user(goalPrompt('g')),
      ...Array.from({ length: 40 }, () => toolResult('bash', long)),
    ];
    const request = JSON.parse(buildGoalVerifierRequest({ messages, summary: 's' })!) as {
      omitted: number;
      evidence: Array<{ content: string }>;
    };
    expect(request.evidence[0].content.length).toBeLessThan(GOAL_VERIFIER_RECORD_CHARS + 100);
    expect(request.evidence[0].content).toContain('[… truncated …]');
    expect(request.omitted).toBeGreaterThan(0);
    expect(request.evidence.length + request.omitted).toBe(40);
  });
});

describe('parseGoalVerdict', () => {
  it('只接受严格的 accept / reject JSON，可容忍代码围栏', () => {
    expect(parseGoalVerdict('{"decision":"accept","reason":"ok"}')).toEqual({
      decision: 'accept',
      reason: 'ok',
    });
    expect(parseGoalVerdict('```json\n{"decision":"reject","reason":"no test run"}\n```')).toEqual({
      decision: 'reject',
      reason: 'no test run',
    });
    expect(parseGoalVerdict('{"decision":"maybe","reason":"x"}')).toBeUndefined();
    expect(parseGoalVerdict('looks done')).toBeUndefined();
  });
});

describe('goal_complete 接入核验', () => {
  const complete = (verify?: Parameters<typeof createGoalTools>[1]) => {
    const signals: string[] = [];
    const tool = createGoalTools((kind) => signals.push(kind), verify).find(
      (t) => t.name === 'goal_complete'
    )!;
    const run = () =>
      tool.execute('c', { summary: 'done' }, undefined, undefined, undefined as never);
    return { signals, run };
  };

  it('核验拒绝：不发完成信号，把理由交还模型', async () => {
    const { signals, run } = complete(async () => 'No test output in the transcript.');
    const result = await run();
    expect(signals).toEqual([]);
    expect(JSON.stringify(result.content)).toContain('No test output in the transcript.');
  });

  it('核验通过或无核验：发完成信号', async () => {
    const passed = complete(async () => undefined);
    await passed.run();
    expect(passed.signals).toEqual(['complete']);
    const bare = complete();
    await bare.run();
    expect(bare.signals).toEqual(['complete']);
  });
});
