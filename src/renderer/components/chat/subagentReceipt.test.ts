import { describe, expect, it } from 'vitest';
import { parseSubagentReceipt, subagentErrorReason } from './subagentReceipt';

const json = (value: object) => JSON.stringify(value, null, 2);
const run = (over: Record<string, unknown> = {}) => ({
  owner: { ownerId: 'conv', projectId: 'proj', kind: 'chatSession' },
  agentId: 'agent-a',
  runId: 'run-a',
  mode: 'task',
  status: 'succeeded',
  createdAt: 1000,
  startedAt: 2000,
  finishedAt: 14000,
  ...over,
});

describe('parseSubagentReceipt', () => {
  it('report：回答单独拿出来，运行信息里不再重复回答', () => {
    const view = parseSubagentReceipt(
      'report',
      json({ run: run(), text: 'fake-ok', usage: { inputTokens: 10, outputTokens: 2 } })
    );
    expect(view).toMatchObject({
      kind: 'report',
      head: '',
      text: 'fake-ok',
      value: null,
      error: null,
      runs: [{ agentId: 'agent-a', runId: 'run-a', status: 'succeeded', durationMs: 12000 }],
    });
    expect(view?.info).toContain('"usage"');
    expect(view?.info).toContain('run-a');
    expect(view?.info).not.toContain('fake-ok');
  });

  it('report：结构化结果按 JSON 排版，失败原因单独给出，空白回答视为没有', () => {
    const view = parseSubagentReceipt(
      'report',
      json({ run: run({ status: 'failed' }), text: '  ', value: { ok: true }, error: 'boom' })
    );
    expect(view).toMatchObject({ text: null, value: '{\n  "ok": true\n}', error: 'boom' });
    expect(view?.info).not.toContain('boom');
  });

  it('wait：逐个 run 给出状态与用时，未结束的没有用时；保留超时 / 打断标记', () => {
    const view = parseSubagentReceipt(
      'wait',
      json({
        runs: [
          run({ startedAt: undefined }),
          run({ agentId: 'agent-b', runId: 'run-b', status: 'running', finishedAt: undefined }),
        ],
        timedOut: true,
        interrupted: false,
      })
    );
    expect(view).toMatchObject({
      kind: 'wait',
      timedOut: true,
      interrupted: false,
      runs: [
        { agentId: 'agent-a', status: 'succeeded', durationMs: 13000 },
        { agentId: 'agent-b', runId: 'run-b', status: 'running', durationMs: null },
      ],
    });
    expect(view?.info).toContain('run-b');
  });

  it('回执前捎带的系统提醒原样保留', () => {
    const reminder = '<system-reminder>\n后台任务已结束\n</system-reminder>';
    const view = parseSubagentReceipt('report', `${reminder}\n${json({ run: run(), text: 'ok' })}`);
    expect(view).toMatchObject({ head: reminder, text: 'ok' });
  });

  it('spawn / send 带 wait:true：取回执附带的等待结果，运行信息保留整段回执', () => {
    const report = { runs: [run()], timedOut: true, interrupted: false };
    const spawned = parseSubagentReceipt(
      undefined,
      json({ agentId: 'agent-a', runId: 'run-a', mode: 'task', status: 'running', report })
    );
    expect(spawned).toMatchObject({
      kind: 'wait',
      head: '',
      timedOut: true,
      interrupted: false,
      runs: [{ agentId: 'agent-a', runId: 'run-a', status: 'succeeded', durationMs: 12000 }],
    });
    expect(spawned?.info).toContain('"mode": "task"');
    const sent = parseSubagentReceipt(
      undefined,
      json({ agentId: 'agent-a', runId: 'run-a', delivery: 'next', status: 'queued', report })
    );
    expect(sent?.info).toContain('"delivery": "next"');
  });

  it('不带 wait 的 spawn 回执只收进运行信息，不列当时的状态', () => {
    const receipt = json({ agentId: 'agent-a', runId: 'run-a', mode: 'task', status: 'running' });
    expect(
      parseSubagentReceipt(undefined, `<system-reminder>x</system-reminder>\n${receipt}`)
    ).toEqual({
      kind: 'receipt',
      head: '<system-reminder>x</system-reminder>',
      runs: [],
      info: receipt,
    });
    expect(parseSubagentReceipt('resume', receipt)).toEqual({
      kind: 'receipt',
      head: '',
      runs: [],
      info: receipt,
    });
  });

  it('list：每个子代理一行，有 run 的给最近一次 run 的状态与用时，已关闭 / 没有 run 的给子代理状态', () => {
    const view = parseSubagentReceipt(
      'list',
      json({
        agents: [
          { agentId: 'agent-a', mode: 'coworker', status: 'ready', latestRun: run() },
          {
            agentId: 'agent-b',
            mode: 'coworker',
            status: 'active',
            activeRunId: 'run-b',
            latestRun: run({ agentId: 'agent-b', runId: 'run-b', status: 'running' }),
          },
          { agentId: 'agent-c', mode: 'coworker', status: 'ready' },
          {
            agentId: 'agent-d',
            mode: 'task',
            status: 'closed',
            latestRun: run({ agentId: 'agent-d', runId: 'run-d' }),
          },
        ],
        nextCursor: 'agent-d',
      })
    );
    expect(view).toMatchObject({
      kind: 'list',
      head: '',
      runs: [
        { agentId: 'agent-a', runId: 'run-a', status: 'succeeded', durationMs: 12000 },
        { agentId: 'agent-b', runId: 'run-b', status: 'running' },
        { agentId: 'agent-c', runId: '', status: 'ready', durationMs: null },
        { agentId: 'agent-d', runId: '', status: 'closed', durationMs: null },
      ],
    });
    expect(view?.info).toContain('"nextCursor"');
    expect(parseSubagentReceipt('list', json({ agents: [] }))).toMatchObject({
      kind: 'list',
      runs: [],
    });
  });

  it('等待结果不在回执上、以及停止 / 解雇的结果都不认', () => {
    expect(
      parseSubagentReceipt(undefined, json({ runs: [run()], timedOut: false, interrupted: false }))
    ).toBeNull();
    expect(
      parseSubagentReceipt(undefined, json({ agentId: 'agent-a', runId: 'run-a', report: {} }))
    ).toBeNull();
    expect(parseSubagentReceipt('stop', json(run()))).toBeNull();
    expect(parseSubagentReceipt('dismiss', json({ agentId: 'agent-a' }))).toBeNull();
  });

  it('对不上形状时返回 null，由调用方回退原文', () => {
    const waited = json({ runs: [run()], timedOut: false, interrupted: false });
    expect(parseSubagentReceipt('report', null)).toBeNull();
    expect(
      parseSubagentReceipt('report', '[Tool output externalized\nTool: subagent\nArtifact: x]')
    ).toBeNull();
    expect(parseSubagentReceipt('report', waited)).toBeNull();
    expect(parseSubagentReceipt('wait', json({ run: run(), text: 'ok' }))).toBeNull();
    expect(
      parseSubagentReceipt(
        'wait',
        json({ runs: [{ runId: 'x' }], timedOut: false, interrupted: false })
      )
    ).toBeNull();
    expect(parseSubagentReceipt('list', json({ agents: [{ mode: 'task' }] }))).toBeNull();
    expect(parseSubagentReceipt('list', json({ agentId: 'agent-a' }))).toBeNull();
  });
});

describe('subagentErrorReason', () => {
  it('找不到 Run / Agent 的报错按码给可读说明，不露裸码', () => {
    expect(subagentErrorReason('restart-lost: Run r was started before EnsoCode restarted.')).toBe(
      'This subagent was started before EnsoCode restarted, and its record was lost in the restart'
    );
    expect(subagentErrorReason('other-owner: Run r belongs to a different conversation')).toMatch(
      /another conversation/
    );
    expect(subagentErrorReason('not-found: No Run with id r exists')).toMatch(/no subagent/);
  });

  it('未登记的码与非错误文本返回 null，由调用方显示原文', () => {
    expect(subagentErrorReason('invalid subagent parameters: wait requires runId')).toBeNull();
    expect(subagentErrorReason('runtime-unavailable: boom')).toBeNull();
    expect(subagentErrorReason(undefined)).toBeNull();
  });
});
