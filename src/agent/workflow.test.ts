import type { AgentControlToolRequest, AgentControlToolResponse } from '@shared/types/agent';
import { generateWorkflowScript } from '@shared/workflowDesign';
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowTool, WORKFLOW_STOPPED_BY_USER, workflowChildOutcome } from './workflow';
import { loadWorkflowPreset } from './workflowPresets';

type FakeSpawn = { prompt: string; description: string };
type FakeChild = { runId: string; status?: 'succeeded' | 'failed'; text?: string };

/** 模拟 Main 的 agent control：spawn 立即回 runId，wait 可被 hold 挂住且响应 abort */
function fakeChildren(child: (spawn: FakeSpawn) => FakeChild, hold?: Promise<void>) {
  const runs = new Map<string, FakeChild>();
  const stopped: string[] = [];
  const invoke = vi.fn(
    async (
      request: AgentControlToolRequest,
      signal?: AbortSignal
    ): Promise<AgentControlToolResponse> => {
      if (request.operation === 'spawn') {
        const run = child(request);
        runs.set(run.runId, run);
        return { ok: true, value: { agentId: `child-${run.runId}`, runId: run.runId } };
      }
      if (request.operation === 'wait') {
        if (hold) {
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return reject(new Error('Agent control wait interrupted.'));
            signal?.addEventListener('abort', () =>
              reject(new Error('Agent control wait interrupted.'))
            );
            void hold.then(resolve);
          });
        }
        const run = runs.get(request.runIds[0] ?? '');
        return {
          ok: true,
          value: {
            runs: [{ status: run?.status ?? 'succeeded' }],
            timedOut: false,
            interrupted: false,
          },
        };
      }
      if (request.operation === 'report') {
        return { ok: true, value: { text: runs.get(request.runId)?.text ?? '' } };
      }
      if (request.operation === 'stop') {
        stopped.push(request.runId);
        return { ok: true, value: {} };
      }
      throw new Error(`unexpected ${request.operation}`);
    }
  );
  return { invoke, stopped };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(predicate()).toBe(true);
};

describe('workflowChildOutcome', () => {
  it('成功子代理取文本，失败、超时和中断都不是成功', () => {
    expect(
      workflowChildOutcome({ report: { runs: [{ status: 'succeeded' }] } }, { text: 'done' })
    ).toEqual({ failed: false, text: 'done' });
    expect(
      workflowChildOutcome({ report: { runs: [{ status: 'failed' }] } }, { text: 'partial' }).failed
    ).toBe(true);
    expect(
      workflowChildOutcome({ report: { runs: [{ status: 'succeeded' }], timedOut: true } }, {})
        .failed
    ).toBe(true);
  });

  it('请求预算停止仍带回部分输出并标明原因，不当成失败', () => {
    expect(
      workflowChildOutcome(
        { report: { runs: [{ status: 'succeeded', requestBudgetStop: true }] } },
        { text: '查到一半的结论' }
      )
    ).toEqual({
      failed: false,
      text: '因请求预算停止，以下是已有的部分输出。\n查到一半的结论',
    });
  });
});

describe('workflow tool', () => {
  it('schema 声明完整类型，并且只在显式编排时使用', () => {
    const tool = createWorkflowTool({ invoke: vi.fn(), emit: vi.fn() });
    const parameters = tool.parameters as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: {
        preset: { type: string };
        script: { type: string };
        meta: { type: string; required: string[]; properties: { name: { type: string } } };
        args: { type: string };
        background: { type: string };
        stop: { type: string };
      };
    };
    expect(parameters.type).toBe('object');
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required).toEqual([]);
    expect(parameters.properties.preset.type).toBe('string');
    expect(parameters.properties.script.type).toBe('string');
    expect(parameters.properties.meta.type).toBe('object');
    expect(parameters.properties.meta.required).toEqual(['name', 'description']);
    expect(parameters.properties.meta.properties.name.type).toBe('string');
    expect(parameters.properties.args.type).toBe('object');
    expect(parameters.properties.background.type).toBe('boolean');
    expect(parameters.properties.stop.type).toBe('string');
    expect(tool.promptGuidelines?.join('\n')).toMatch(/explicit|asks for a workflow/i);
  });

  it('扇出两个子代理，失败的一个变成 null，侧边栏快照能看到阶段和成员', async () => {
    const emit = vi.fn();
    const { invoke } = fakeChildren((spawn) => {
      const bad = spawn.prompt.includes('bad');
      return {
        runId: bad ? 'bad' : 'good',
        status: bad ? 'failed' : 'succeeded',
        text: bad ? '' : 'ok:good',
      };
    });
    const tool = createWorkflowTool({ invoke, emit, randomUuid: () => 'workflow-1' });
    const result = await tool.execute(
      'call-1',
      {
        meta: { name: 'audit', description: 'Audit two files' },
        script:
          "await phase('review');\n" +
          'const rows = await parallel([\n' +
          "  () => agent('good file', { label: 'good' }),\n" +
          "  () => agent('bad file', { label: 'bad' }),\n" +
          ']);\n' +
          'return rows;',
      },
      undefined,
      undefined,
      {} as never
    );
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(result.details).toMatchObject({
      runId: 'workflow-1',
      agentsStarted: 2,
      result: ['ok:good', null],
    });
    const last = emit.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({
      runId: 'workflow-1',
      name: 'audit',
      status: 'completed',
      phase: 'review',
    });
    expect(last.members).toEqual([
      {
        seq: 1,
        label: 'good',
        phase: 'review',
        batch: 1,
        status: 'completed',
        prompt: 'good file',
        result: 'ok:good',
        childId: 'child-good',
      },
      {
        seq: 2,
        label: 'bad',
        phase: 'review',
        batch: 1,
        status: 'failed',
        prompt: 'bad file',
        childId: 'child-bad',
      },
    ]);
  });

  it('成员跑过单次 wait 上限时接着等，不判失败也不停掉', async () => {
    const emit = vi.fn();
    let waits = 0;
    const invoke = vi.fn(async (request: AgentControlToolRequest) => {
      if (request.operation === 'spawn') return { ok: true as const, value: { runId: 'slow' } };
      if (request.operation === 'wait') {
        waits++;
        // Main 单次 wait 封顶，成员超过上限仍在跑：前两次超时带 pending 进度
        return {
          ok: true as const,
          value:
            waits < 3
              ? {
                  runs: [{ status: 'running' }],
                  timedOut: true,
                  interrupted: false,
                  pending: [{ runId: 'slow', status: 'running', elapsedMs: waits * 600_000 }],
                }
              : { runs: [{ status: 'succeeded' }], timedOut: false, interrupted: false },
        };
      }
      if (request.operation === 'report') return { ok: true as const, value: { text: 'late ok' } };
      throw new Error(`unexpected ${request.operation}`);
    });
    const tool = createWorkflowTool({ invoke, emit, randomUuid: () => 'workflow-slow' });
    const result = await tool.execute(
      'call-slow',
      {
        meta: { name: 'slow', description: 'Long member' },
        script: "return await agent('slow work', { label: 'slow' });",
      },
      undefined,
      undefined,
      {} as never
    );
    expect(waits).toBe(3);
    expect(result.details).toMatchObject({ result: 'late ok' });
    expect(invoke.mock.calls.map(([request]) => request.operation)).not.toContain('stop');
  });

  it('先后启动的子代理不进同一并行批次', async () => {
    const emit = vi.fn();
    const tool = createWorkflowTool({
      invoke: fakeChildren((spawn) => ({ runId: spawn.prompt, text: 'done' })).invoke,
      emit,
      randomUuid: () => 'workflow-seq',
    });
    await tool.execute(
      'call-seq',
      {
        meta: { name: 'seq', description: 'Sequential agents' },
        script:
          "await agent('first', { label: 'first' }); await agent('second', { label: 'second' });",
      },
      undefined,
      undefined,
      {} as never
    );
    const members = emit.mock.calls.at(-1)?.[0].members;
    expect(members.map((member: { batch: number }) => member.batch)).toEqual([1, 2]);
  });

  it('不支持的 agent 选项会让整次运行失败', async () => {
    const emit = vi.fn();
    const tool = createWorkflowTool({
      invoke: vi.fn(),
      emit,
      randomUuid: () => 'workflow-2',
    });
    const result = await tool.execute(
      'call-2',
      {
        meta: { name: 'bad-option', description: 'Reject unknown option' },
        script: "return await agent('work', { effort: 'high' });",
      },
      undefined,
      undefined,
      {} as never
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/not supported/),
    });
  });

  describe('background', () => {
    const script = {
      meta: { name: 'bg', description: 'Background run' },
      script: "return await agent('work', { label: 'work' });",
    };
    const make = (hold: Promise<void>, status: 'succeeded' | 'failed' = 'succeeded') => {
      const emit = vi.fn();
      const notify = vi.fn();
      const activeRuns = new Map<string, AbortController>();
      const children = fakeChildren(() => ({ runId: 'child-run', status, text: 'found it' }), hold);
      const tool = createWorkflowTool({
        invoke: children.invoke,
        emit,
        notify,
        activeRuns,
        randomUuid: () => 'wf-bg',
      });
      const run = (params: Record<string, unknown>, signal?: AbortSignal) =>
        tool.execute('call-bg', params, signal, undefined, {} as never);
      return { emit, notify, activeRuns, run, ...children };
    };

    it('background:true 立即返回 runId，跑完经通知把结果送回主 agent', async () => {
      const gate = deferred();
      const { emit, notify, activeRuns, run } = make(gate.promise);
      const result = await run({ ...script, background: true });
      expect(result.details).toMatchObject({ runId: 'wf-bg', background: true });
      expect(JSON.stringify(result.content)).toMatch(/wf-bg/);
      expect(activeRuns.has('wf-bg')).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      gate.release();
      await until(() => notify.mock.calls.length > 0);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]?.[0]).toMatch(/wf-bg[\s\S]*completed[\s\S]*"found it"/);
      expect(notify.mock.calls[0]?.[1]).toBe(false);
      expect(activeRuns.size).toBe(0);
      expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ runId: 'wf-bg', status: 'completed' });
    });

    it('后台运行失败时通知标为紧急', async () => {
      const { notify, run } = make(Promise.resolve());
      await run({
        meta: { name: 'bg', description: 'Background run' },
        script: "throw new Error('boom');",
        background: true,
      });
      await until(() => notify.mock.calls.length > 0);
      expect(notify.mock.calls[0]?.[0]).toMatch(/boom/);
      expect(notify.mock.calls[0]?.[1]).toBe(true);
    });

    it('stop 取消后台运行并停掉在跑的子代理，模型已知情不再通知', async () => {
      const gate = deferred();
      const { emit, notify, activeRuns, run, invoke, stopped } = make(gate.promise);
      await run({ ...script, background: true });
      await until(() => invoke.mock.calls.some(([request]) => request.operation === 'wait'));
      const stoppedResult = await run({ stop: 'wf-bg' });
      expect(JSON.stringify(stoppedResult.content)).toMatch(/stopped/i);
      await until(() => emit.mock.calls.at(-1)?.[0].status === 'cancelled');
      expect(stopped).toEqual(['child-run']);
      expect(activeRuns.size).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(notify).not.toHaveBeenCalled();
    });

    it('用户从侧边栏停止后台运行：停掉子代理并告诉主 agent 别重跑', async () => {
      const gate = deferred();
      const { emit, notify, activeRuns, run, invoke, stopped } = make(gate.promise);
      await run({ ...script, background: true });
      await until(() => invoke.mock.calls.some(([request]) => request.operation === 'wait'));
      activeRuns.get('wf-bg')?.abort(WORKFLOW_STOPPED_BY_USER);
      await until(() => notify.mock.calls.length > 0);
      expect(stopped).toEqual(['child-run']);
      expect(notify.mock.calls[0]?.[0]).toMatch(/stopped by the user[\s\S]*do not restart/i);
      expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'cancelled' });
      expect(activeRuns.size).toBe(0);
    });

    it('同步运行也登记在 activeRuns，用户停止后工具返回说明原因', async () => {
      const gate = deferred();
      const { activeRuns, run, invoke, stopped } = make(gate.promise);
      const pending = run(script);
      await until(() => invoke.mock.calls.some(([request]) => request.operation === 'wait'));
      activeRuns.get('wf-bg')?.abort(WORKFLOW_STOPPED_BY_USER);
      const result = await pending;
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/stopped by the user/i);
      expect(stopped).toEqual(['child-run']);
      expect(activeRuns.size).toBe(0);
    });

    it('stop 未知 runId、未接入通知时的 background 都在启动前拒绝', async () => {
      const { run } = make(Promise.resolve());
      await expect(run({ stop: 'nope' })).rejects.toThrow(/no running background workflow/);
      const tool = createWorkflowTool({ invoke: vi.fn(), emit: vi.fn() });
      await expect(
        tool.execute('c', { ...script, background: true }, undefined, undefined, {} as never)
      ).rejects.toThrow(/background/);
    });

    it('同步运行被中断时停掉在跑的子代理', async () => {
      const gate = deferred();
      const { emit, run, invoke, stopped } = make(gate.promise);
      const controller = new AbortController();
      const pending = run(script, controller.signal);
      await until(() => invoke.mock.calls.some(([request]) => request.operation === 'wait'));
      controller.abort();
      const result = await pending;
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(stopped).toEqual(['child-run']);
      expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'cancelled' });
    });
  });

  describe('preset', () => {
    const saved = {
      id: 'echo',
      source: 'project' as const,
      name: 'Echo preset',
      description: 'Return the resolved args',
      args: [
        { key: 'target', label: 'Target', default: 'HEAD' },
        { key: 'focus', label: 'Focus', required: true },
      ],
      script: 'return args;',
    };
    const make = () => {
      const emit = vi.fn();
      const loadPreset = vi.fn((id: string) => (id === 'echo' ? saved : null));
      const tool = createWorkflowTool({
        invoke: vi.fn(),
        emit,
        loadPreset,
        randomUuid: () => 'wf-p',
      });
      const run = (params: Record<string, unknown>) =>
        tool.execute('call-p', params, undefined, undefined, {} as never);
      return { emit, run };
    };

    it('按 id 运行预设脚本，补默认参数并用预设元数据展示', async () => {
      const { emit, run } = make();
      const result = await run({ preset: 'echo', args: { focus: 'perf' } });
      expect(result.details).toMatchObject({ result: { target: 'HEAD', focus: 'perf' } });
      expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
        name: 'Echo preset',
        description: 'Return the resolved args',
        status: 'completed',
      });
    });

    it('可用预设写进工具说明（单行、截断），并允许模型自行挑选合适的预设', () => {
      const noPresets = createWorkflowTool({ invoke: vi.fn(), emit: vi.fn() });
      expect(noPresets.description).not.toMatch(/Available presets/);
      const tool = createWorkflowTool({
        invoke: vi.fn(),
        emit: vi.fn(),
        presets: [
          { ...saved, description: `line one\nline two ${'x'.repeat(400)}` },
          { id: 'plain', source: 'builtin', name: 'Plain', description: 'No args', args: [] },
        ],
      });
      const lines = tool.description.split('\n');
      const echo = lines.find((line) => line.startsWith('- echo:'));
      expect(echo).toMatch(/Echo preset — line one line two x+… \(args: target="HEAD", focus\*\)$/);
      expect(echo?.length).toBeLessThan(300);
      expect(lines).toContain('- plain: Plain — No args');
      const guidelines = tool.promptGuidelines?.join('\n') ?? '';
      expect(guidelines).toMatch(/listed preset/i);
      expect(guidelines).not.toMatch(/never guess preset ids/);
    });

    it('未知预设、同时给脚本、缺必填参数都在启动前拒绝', async () => {
      const { emit, run } = make();
      await expect(run({ preset: 'nope' })).rejects.toThrow(/unknown workflow preset/);
      await expect(
        run({ preset: 'echo', script: 'return 1;', args: { focus: 'x' } })
      ).rejects.toThrow(/either preset or script/);
      await expect(run({ preset: 'echo' })).rejects.toThrow(/focus/);
      expect(emit).not.toHaveBeenCalled();
    });

    it('内置预设在沙箱里按默认参数扇出只读子代理', async () => {
      const { invoke } = fakeChildren((spawn) => ({ runId: spawn.description, text: 'none' }));
      const tool = createWorkflowTool({
        invoke,
        emit: vi.fn(),
        loadPreset: (id) => loadWorkflowPreset(id, []),
      });
      const result = await tool.execute(
        'call-b',
        { preset: 'parallel-review' },
        undefined,
        undefined,
        {} as never
      );
      expect(result.details).toMatchObject({
        agentsStarted: 3,
        result: [
          { dimension: 'correctness', findings: 'none' },
          { dimension: 'security', findings: 'none' },
          { dimension: 'performance', findings: 'none' },
        ],
      });
      const spawns = invoke.mock.calls
        .map(([request]) => request)
        .filter((r) => r.operation === 'spawn');
      expect(spawns.every((r) => r.agentType === 'reviewer')).toBe(true);
    });
  });

  describe('model', () => {
    const models = [
      { name: 'Max/claude-opus-5', config: {} as never },
      { name: 'OpenAI/gpt-6', config: {} as never },
    ];

    it('model 参数说明带上选型描述，空白描述不产生空条目', () => {
      const noted = createWorkflowTool({
        invoke: vi.fn(),
        emit: vi.fn(),
        models: [
          { name: 'Max/claude-opus-5', config: {} as never, description: '只读调研' },
          { name: 'OpenAI/gpt-6', config: {} as never, description: '  ' },
        ],
      });
      const schema = noted.parameters as { properties: { model: { description: string } } };
      expect(schema.properties.model.description).toContain('Max/claude-opus-5: 只读调研');
      expect(schema.properties.model.description).not.toContain('OpenAI/gpt-6:');
      expect((noted.promptGuidelines ?? []).join('\n')).toContain('Max/claude-opus-5: 只读调研');
    });
    const agentTypes = [
      { name: 'reviewer', allowModelOverride: true },
      { name: 'worker', allowModelOverride: true },
      { name: 'fixed', allowModelOverride: false },
    ];
    const make = () => {
      const { invoke } = fakeChildren((spawn) => ({ runId: spawn.description, text: 'ok' }));
      const emit = vi.fn();
      const tool = createWorkflowTool({ invoke, emit, models, agentTypes });
      const run = (params: Record<string, unknown>) =>
        tool.execute('call-m', params, undefined, undefined, {} as never);
      const spawns = () =>
        invoke.mock.calls.map(([request]) => request).filter((r) => r.operation === 'spawn');
      return { tool, run, spawns, emit };
    };
    const meta = { name: 'm', description: 'model test' };

    it('顶层 model 由未自带 model 的 agent() 继承，脚本显式 model 优先，固定模型的类型不带', async () => {
      const { run, spawns } = make();
      await run({
        meta,
        model: 'Max/claude-opus-5',
        script: `await parallel([
          () => agent("a", { label: "a", agentType: "reviewer" }),
          () => agent("b", { label: "b" }),
          () => agent("c", { label: "c", agentType: "reviewer", model: "OpenAI/gpt-6" }),
          () => agent("d", { label: "d", agentType: "fixed" }),
        ]); return 1;`,
      });
      const byLabel = Object.fromEntries(spawns().map((r) => [r.description, r.model]));
      expect(byLabel).toEqual({
        a: 'Max/claude-opus-5',
        b: 'Max/claude-opus-5',
        c: 'OpenAI/gpt-6',
        d: undefined,
      });
    });

    it('类型要求选模型而未给 model 时，不启动子代理，错误列出可选模型', async () => {
      const { run, spawns } = make();
      const result = await run({
        meta,
        script: 'return await agent("a", { agentType: "reviewer" });',
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/"reviewer" requires a model/);
      expect(text).toContain('Max/claude-opus-5, OpenAI/gpt-6');
      expect(spawns()).toHaveLength(0);
    });

    it('未知 model 在启动前拒绝；参数与说明暴露可选模型和需要选模型的类型', async () => {
      const { tool, run, emit } = make();
      await expect(run({ meta, model: 'opus', script: 'return 1;' })).rejects.toThrow(
        /unknown model "opus"/
      );
      expect(emit).not.toHaveBeenCalled();
      const params = tool.parameters as { properties: Record<string, { enum?: string[] }> };
      expect(params.properties.model?.enum).toEqual(['Max/claude-opus-5', 'OpenAI/gpt-6']);
      const guidelines = tool.promptGuidelines?.join('\n') ?? '';
      expect(guidelines).toContain('reviewer, worker');
      expect(guidelines).toContain('Max/claude-opus-5, OpenAI/gpt-6');
      const bare = createWorkflowTool({ invoke: vi.fn(), emit: vi.fn() });
      expect(
        (bare.parameters as { properties: Record<string, unknown> }).properties.model
      ).toBeUndefined();
    });
  });

  // 模板字面量语法混进参数值，确认不会被当成代码
  const TEMPLATE_LIKE = 'x`$' + '{y}';

  it('设计器生成的脚本：阶段内并行、参数代入、下一阶段拿到上一阶段带标签的输出', async () => {
    const spawns: { prompt: string; description: string; agentType?: string }[] = [];
    let n = 0;
    const { invoke } = fakeChildren((spawn) => {
      spawns.push(spawn);
      n += 1;
      return { runId: `r${n}`, status: n === 2 ? 'failed' : 'succeeded', text: `out${n}` };
    });
    const tool = createWorkflowTool({ invoke, emit: vi.fn(), randomUuid: () => 'wf' });
    const script = generateWorkflowScript({
      phases: [
        {
          title: 'Investigate',
          steps: [
            { label: 'code', agentType: 'scout', prompt: 'Topic "{{args.topic}}" in code' },
            { label: 'tests', agentType: '', prompt: 'Topic {{args.missing}} in tests' },
          ],
        },
        {
          title: 'Summarize',
          steps: [{ label: 'report', agentType: '', prompt: 'Merge:\n{{prev}}' }],
        },
      ],
    });
    const result = await tool.execute(
      'call-1',
      { meta: { name: 'designed', description: 'd' }, script, args: { topic: TEMPLATE_LIKE } },
      undefined,
      undefined,
      {} as never
    );
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(spawns.map((s) => s.prompt)).toEqual([
      `Topic "${TEMPLATE_LIKE}" in code`,
      'Topic  in tests',
      'Merge:\n## code\n\nout1\n\n## tests\n\n(failed)',
    ]);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ agentType: 'scout', description: 'code' });
    expect(
      invoke.mock.calls.find((c) => (c[0] as { description?: string }).description === 'tests')?.[0]
    ).not.toHaveProperty('agentType');
    expect(result.details).toMatchObject({ result: '## report\n\nout3' });
  });
});
