import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  applyOwnerAskResolution,
  classifyOwnerGatedCommand,
  classifyOwnerGatedTool,
  isOwnerConfirmationAnswer,
  OwnerGate,
  withOwnerGate,
} from './ownerGate';

const PLUGIN = 'enso-plugin-message';

function pluginMessage(details: Record<string, unknown>) {
  return { role: 'custom', customType: PLUGIN, details };
}

function tool(name: string) {
  const execute = vi.fn(async () => 'ran');
  const wrapped = withOwnerGate(
    {
      name,
      label: name,
      description: name,
      parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
      execute: execute as unknown as ToolDefinition['execute'],
    },
    gateHolder.current
  );
  return { execute, wrapped };
}

const gateHolder: { current: OwnerGate } = { current: new OwnerGate() };

async function call(gate: OwnerGate, name: string, params: unknown = {}) {
  gateHolder.current = gate;
  const { execute, wrapped } = tool(name);
  const result = await wrapped.execute('call-1', params, undefined, undefined, undefined as never);
  return { result, execute };
}

describe('isOwnerConfirmationAnswer', () => {
  it('明确同意才算确认，否定优先，空回答不算', () => {
    expect(isOwnerConfirmationAnswer('  ')).toBe(false);
    for (const answer of ['同意', '确认', 'yes', 'approve', 'go ahead', 'LGTM']) {
      expect(isOwnerConfirmationAnswer(answer)).toBe(true);
    }
    for (const answer of ['不同意', '拒绝', 'no', '取消', "don't", 'not approved', 'not ok']) {
      expect(isOwnerConfirmationAnswer(answer)).toBe(false);
    }
    for (const answer of ['不执行', '别执行', '未同意', '没批准', '暂不继续执行', '先不推']) {
      expect(isOwnerConfirmationAnswer(answer), answer).toBe(false);
    }
  });
});

describe('classifyOwnerGatedCommand', () => {
  it('拦截发布、合并、推送和部署，放行只读与本地检查', () => {
    for (const command of [
      'git push',
      'git push origin main',
      'git -C repo push',
      'FOO=1 git push',
      'sh -c "git push"',
      'gh pr create',
      'gh pr merge',
      'npm publish',
      'pnpm run deploy',
      'docker push app',
      'kubectl apply -f app.yaml',
      'terraform apply',
    ]) {
      expect(classifyOwnerGatedCommand(command), command).not.toBeNull();
    }
    for (const command of ['git status', 'git diff', 'gh pr view', 'pnpm test', 'ls', 'rg foo']) {
      expect(classifyOwnerGatedCommand(command), command).toBeNull();
    }
  });
});

describe('OwnerGate', () => {
  const blocked = [
    ['bash', { command: 'git push' }],
    ['bash', { command: 'git push origin main' }],
    ['bash', { command: 'gh pr create' }],
    ['bash', { command: 'gh pr merge' }],
    ['bash', { command: 'npm publish' }],
    ['bash', { command: 'pnpm run deploy' }],
    ['bash', { command: 'docker push app' }],
    ['bash', { command: 'kubectl apply -f app.yaml' }],
    ['bash', { command: 'terraform apply' }],
    ['bash', { command: 'sh -c "git push"' }],
    ['bash', { command: 'FOO=1 git push' }],
    ['session_create', {}],
    ['session_send', {}],
    ['todo_item_dispatch', {}],
    ['delegate', {}],
    ['plugin_enso-bridge__bridge_ask', {}],
    ['subagent', { operation: 'spawn' }],
    ['subagent', { operation: 'send' }],
    ['subagent', { operation: 'resume' }],
    ['workflow', { preset: 'feature' }],
    ['workflow', { resume: 'run-1' }],
  ] as const;

  const allowed = [
    ['bash', { command: 'git status' }],
    ['bash', { command: 'git diff' }],
    ['bash', { command: 'gh pr view' }],
    ['bash', { command: 'pnpm test' }],
    ['subagent', { operation: 'list' }],
    ['subagent', { operation: 'report' }],
    ['subagent', { operation: 'wait' }],
    ['workflow', { stop: true }],
    ['read', { path: 'a.ts' }],
    ['grep', { pattern: 'x' }],
  ] as const;

  function externalGate() {
    const gate = new OwnerGate();
    gate.observeMessage(
      pluginMessage({
        pluginId: 'enso.tgclient',
        pluginName: 'Telegram',
        origin: 'external',
        sender: { channel: 'telegram', userId: '9', displayName: '群友' },
      })
    );
    return gate;
  }

  function confirmingGate() {
    const gate = new OwnerGate();
    gate.observeMessage(
      pluginMessage({
        pluginId: 'enso.tgclient',
        pluginName: 'Telegram',
        origin: 'external',
        ownerConfirm: true,
        sender: { channel: 'telegram', userId: '9', displayName: '群友' },
      })
    );
    return gate;
  }

  it('非 owner 插件投递拦截开工动作，只读照常执行', async () => {
    const gate = confirmingGate();
    for (const [name, params] of blocked) {
      await expect(call(gate, name, params)).rejects.toThrow(/需要 owner 确认/);
      await expect(call(gate, name, params)).rejects.toThrow(/Owner confirmation required/);
      await expect(call(gate, name, params)).rejects.toThrow(/ask_user/);
    }
    for (const [name, params] of allowed) {
      const { result, execute } = await call(gate, name, params);
      expect(result).toBe('ran');
      expect(execute).toHaveBeenCalledOnce();
    }
    expect(classifyOwnerGatedTool('read', {})).toBeNull();
  });

  it('用户消息、owner 投递和可信插件投递全部放行', async () => {
    for (const message of [
      { role: 'user', content: '继续' },
      pluginMessage({
        pluginId: 'enso.tgclient',
        origin: 'owner',
        sender: { channel: 'telegram', userId: '1' },
      }),
      pluginMessage({ pluginId: 'enso.scheduler', origin: 'owner' }),
    ]) {
      const gate = externalGate();
      gate.observeMessage(message);
      expect(gate.isOwner()).toBe(true);
      const { result } = await call(gate, 'bash', { command: 'git push' });
      expect(result).toBe('ran');
    }
  });

  it('没有 origin 的旧插件投递按非 owner 拦截', async () => {
    const gate = new OwnerGate();
    gate.observeMessage(
      pluginMessage({ pluginId: 'enso.github', pluginName: 'GitHub', ownerConfirm: true })
    );
    expect(gate.isOwner()).toBe(false);
    expect(gate.origin()).toMatchObject({ kind: 'external', pluginId: 'enso.github' });
    await expect(call(gate, 'bash', { command: 'git push' })).rejects.toThrow(/需要 owner 确认/);
  });

  it('真人同意后放行，拒绝、超时和代答不放行', async () => {
    const gate = confirmingGate();
    expect(applyOwnerAskResolution(gate, { by: 'timeout', answer: '同意' })).toBe(false);
    expect(applyOwnerAskResolution(gate, { by: 'relay', answer: 'yes' })).toBe(false);
    expect(gate.isOwner()).toBe(false);
    expect(applyOwnerAskResolution(gate, { by: 'user', answer: '拒绝' })).toBe(false);
    await expect(call(gate, 'session_create', {})).rejects.toThrow(/需要 owner 确认/);
    expect(applyOwnerAskResolution(gate, { by: 'user', answer: '同意' })).toBe(true);
    expect(gate.origin()).toEqual({ kind: 'owner', source: 'user-confirmed' });
    const { result } = await call(gate, 'session_create', {});
    expect(result).toBe('ran');
  });

  it('syncFromMessages 按最近一条触发消息恢复拦截或放行', () => {
    const blockedGate = new OwnerGate();
    blockedGate.syncFromMessages([
      { role: 'user', content: '早先的话' },
      pluginMessage({ pluginId: 'enso.tgclient', origin: 'external' }),
      { role: 'assistant', content: '收到' },
    ]);
    expect(blockedGate.isOwner()).toBe(false);

    const userGate = new OwnerGate();
    userGate.observeMessage(pluginMessage({ pluginId: 'enso.tgclient', origin: 'external' }));
    userGate.syncFromMessages([
      pluginMessage({ pluginId: 'enso.tgclient', origin: 'external' }),
      { role: 'user', content: '我确认' },
    ]);
    expect(userGate.origin()).toEqual({ kind: 'owner', source: 'user' });

    const ownerPlugin = new OwnerGate();
    ownerPlugin.syncFromMessages([
      pluginMessage({
        pluginId: 'enso.tgclient',
        origin: 'owner',
        sender: { channel: 'telegram', userId: '1' },
      }),
    ]);
    expect(ownerPlugin.origin()).toEqual({ kind: 'owner', source: 'plugin-owner' });
  });

  async function callAudited(
    gate: OwnerGate,
    name: string,
    params: unknown,
    audit: (entry: {
      at: number;
      action: string;
      category: string;
      pluginId: string;
      ok: boolean;
    }) => void,
    execute: ToolDefinition['execute'] = (async () => 'ran') as unknown as ToolDefinition['execute']
  ) {
    const wrapped = withOwnerGate(
      {
        name,
        label: name,
        description: name,
        parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
        execute,
      },
      gate,
      audit
    );
    return wrapped.execute('call-1', params, undefined, undefined, undefined as never);
  }

  it('非主人且不要求确认时，push、派发和子代理都执行并记审计', async () => {
    const gate = externalGate();
    const audit = vi.fn();
    for (const [name, params, action, category] of [
      ['bash', { command: 'git push' }, 'git push', 'command'],
      ['session_send', {}, 'session_send', 'dispatch'],
      ['subagent', { operation: 'spawn' }, 'subagent spawn', 'subagent'],
    ] as const) {
      audit.mockClear();
      await expect(callAudited(gate, name, params, audit)).resolves.toBe('ran');
      expect(audit).toHaveBeenCalledOnce();
      expect(audit.mock.calls[0]?.[0]).toMatchObject({
        action,
        category,
        pluginId: 'enso.tgclient',
        ok: true,
        sender: { channel: 'telegram', userId: '9', displayName: '群友' },
      });
      expect(audit.mock.calls[0]?.[0].at).toEqual(expect.any(Number));
    }
  });

  it('放行后的动作失败也记审计', async () => {
    const audit = vi.fn();
    const execute = (async () => {
      throw new Error('push rejected');
    }) as ToolDefinition['execute'];
    await expect(
      callAudited(externalGate(), 'bash', { command: 'git push' }, audit, execute)
    ).rejects.toThrow('push rejected');
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ action: 'git push', ok: false });
  });

  it('要求确认时恢复拦截，并说明可以绑定 GitHub 或改回交给 agent', async () => {
    await expect(call(confirmingGate(), 'bash', { command: 'git push' })).rejects.toThrow(
      /交给 agent 判断/
    );
  });

  it('主人投递不审计', async () => {
    const gate = new OwnerGate();
    gate.observeMessage(
      pluginMessage({
        pluginId: 'enso.tgclient',
        origin: 'owner',
        sender: { channel: 'telegram', userId: '1' },
      })
    );
    const audit = vi.fn();
    await expect(callAudited(gate, 'bash', { command: 'git push' }, audit)).resolves.toBe('ran');
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('OwnerGate.isOwnerInputTurn', () => {
  it('只有 Main 标记过的 user 消息算 owner 亲手触发；缺省、未标记、恢复的历史都不算', () => {
    const gate = new OwnerGate();
    expect(gate.isOwnerInputTurn()).toBe(false);
    gate.observeMessage({ role: 'user', content: 'report from a session' });
    expect(gate.isOwner()).toBe(true);
    expect(gate.isOwnerInputTurn()).toBe(false);
    gate.observeMessage({ role: 'user', content: 'hi' }, true);
    expect(gate.isOwnerInputTurn()).toBe(true);
    const resumed = new OwnerGate();
    resumed.syncFromMessages([{ role: 'user', content: 'hi' }]);
    expect(resumed.isOwnerInputTurn()).toBe(false);
  });

  it('没被信任的插件投递一进来就清掉，自称 owner 也一样；之后 owner 在 ask_user 里确认也不恢复', () => {
    for (const details of [
      { pluginId: 'enso.tgclient', sender: { channel: 'telegram', userId: '9' } },
      { pluginId: 'enso.tgclient', origin: 'owner' },
      { pluginId: 'enso.tgclient', origin: 'owner', sender: { channel: 'telegram', userId: '1' } },
    ]) {
      const gate = new OwnerGate({ trustedPlugins: new Set(['enso.telegram']) });
      gate.observeMessage({ role: 'user', content: 'hi' }, true);
      gate.observeMessage(pluginMessage(details));
      expect(gate.isOwnerInputTurn()).toBe(false);
      gate.handleAskUserAnswer('同意');
      expect(gate.isOwnerInputTurn()).toBe(false);
    }
  });

  it('被信任的插件以 owner 身份投递（Main 判定 origin=owner）才算；外部来源照样不算', () => {
    const trusted = new Set(['enso.telegram']);
    for (const details of [
      { pluginId: 'enso.telegram', origin: 'owner' },
      { pluginId: 'enso.telegram', origin: 'owner', sender: { channel: 'telegram', userId: '1' } },
    ]) {
      const gate = new OwnerGate({ trustedPlugins: trusted });
      gate.observeMessage({ role: 'user', content: 'report' });
      gate.observeMessage(pluginMessage(details));
      expect(gate.isOwnerInputTurn(), JSON.stringify(details)).toBe(true);
    }
    const gate = new OwnerGate({ trustedPlugins: trusted });
    gate.observeMessage(
      pluginMessage({ pluginId: 'enso.telegram', sender: { channel: 'telegram', userId: '9' } })
    );
    expect(gate.origin().kind).toBe('external');
    expect(gate.isOwnerInputTurn()).toBe(false);
  });

  it('非插件的 custom 消息不影响', () => {
    const gate = new OwnerGate();
    gate.observeMessage({ role: 'user', content: 'hi' }, true);
    gate.observeMessage({ role: 'custom', customType: 'system-reminder', details: {} });
    expect(gate.isOwnerInputTurn()).toBe(true);
  });
});
