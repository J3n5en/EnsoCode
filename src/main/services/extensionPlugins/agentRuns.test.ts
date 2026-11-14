import type { PluginAgentRunEvent } from '@shared/extensionPlugins/protocol';
import { parseAgentCommand, parseAgentWorkerEvent } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { PluginAgentRuns } from './agentRuns';

const identity = { sessionId: 's1', generation: '00000000-0000-4000-8000-000000000001' };
const input = { prompt: '改写', context: 'none' as const, timeoutMs: 60_000 };

describe('PluginAgentRuns', () => {
  it('发出可被 worker 解析的命令，按 requestId 回调直到终态', () => {
    const sent: unknown[] = [];
    const runs = new PluginAgentRuns((command) => {
      sent.push(command);
      return true;
    });
    const seen: PluginAgentRunEvent[] = [];
    const started = runs.start(identity, input, (event) => seen.push(event));
    expect(started.ok).toBe(true);
    expect(parseAgentCommand(sent[0])).toEqual(sent[0]);
    const requestId = (sent[0] as { requestId: string }).requestId;
    const event = (e: PluginAgentRunEvent) => ({ type: 'plugin-agent-event', requestId, event: e });
    expect(runs.settle(event({ type: 'text', text: 'a' }) as never)).toBe(true);
    expect(runs.settle(event({ type: 'end', ok: true, text: 'b' }) as never)).toBe(true);
    expect(runs.settle(event({ type: 'text', text: 'late' }) as never)).toBe(true);
    expect(seen).toEqual([
      { type: 'text', text: 'a' },
      { type: 'end', ok: true, text: 'b' },
    ]);
    if (started.ok) started.cancel();
    expect(sent).toHaveLength(1);
  });

  it('带上插件设置的模型；坏模型配置不能下发', () => {
    const sent: unknown[] = [];
    const runs = new PluginAgentRuns((command) => {
      sent.push(command);
      return true;
    });
    const model = {
      api: 'openai-completions' as const,
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      modelId: 'm1',
      settingsProviderId: 'p1',
    };
    runs.start(identity, { ...input, model }, () => {});
    expect(parseAgentCommand(sent[0])).toEqual(sent[0]);
    expect((sent[0] as { model: unknown }).model).toEqual(model);
    expect(parseAgentCommand({ ...(sent[0] as object), model: { modelId: 'm1' } })).toBeNull();
  });

  it('取消发 cancel 命令；worker 不可用时启动失败；退出时全部以失败收尾', () => {
    const sent: { type: string }[] = [];
    let up = true;
    const runs = new PluginAgentRuns((command) => {
      sent.push(command);
      return up;
    });
    const seen: PluginAgentRunEvent[] = [];
    const started = runs.start(identity, input, (event) => seen.push(event));
    if (started.ok) started.cancel();
    expect(sent.at(-1)).toMatchObject({ type: 'plugin-agent-cancel' });
    expect(parseAgentCommand(sent.at(-1))).toEqual(sent.at(-1));
    runs.failAll('agent worker exited');
    expect(seen).toEqual([{ type: 'end', ok: false, error: 'agent worker exited' }]);
    up = false;
    expect(runs.start(identity, input, () => {})).toEqual({ ok: false, error: '无法启动代理' });
  });

  it('worker 事件按协议校验', () => {
    const ok = {
      type: 'plugin-agent-event',
      requestId: 'r',
      event: { type: 'tool-start', id: 't', name: 'read', args: '{}' },
    };
    expect(parseAgentWorkerEvent(ok)).toEqual(ok);
    const nested = { ...ok, event: { ...ok.event, parentId: 'c1' } };
    expect(parseAgentWorkerEvent(nested)).toEqual(nested);
    const end = { ...ok, event: { type: 'tool-end', id: 't', isError: false, output: 'a.ts' } };
    expect(parseAgentWorkerEvent(end)).toEqual(end);
    expect(
      parseAgentWorkerEvent({ ...end, event: { ...end.event, output: 'x'.repeat(5000) } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...ok, event: { ...ok.event, parentId: '' } })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...ok, event: { type: 'end', ok: false, error: '' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...ok, event: { type: 'text', text: 1 } })).toBeNull();
    const done = { ...ok, event: { type: 'end', ok: true, text: 'p', model: 'm1' } };
    expect(parseAgentWorkerEvent(done)).toEqual(done);
    expect(parseAgentWorkerEvent({ ...done, event: { ...done.event, model: '' } })).toBeNull();
    expect(parseAgentWorkerEvent({ ...ok, extra: 1 })).toBeNull();
    expect(
      parseAgentCommand({
        type: 'plugin-agent-run',
        requestId: 'r',
        identity,
        ...input,
        timeoutMs: 30 * 60_000,
      })
    ).toBeNull();
  });
});
