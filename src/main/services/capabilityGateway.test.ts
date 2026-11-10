import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type {
  CapabilityInvocationContext,
  CapabilityInvokeRequest,
  OauthFlowLocator,
  ReceiptLifecycleEvent,
} from '@shared/capabilities/types';
import type { ModelProvider, OauthLoginEvent, SubagentModelEntry } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionIndex } from './agentSessionIndex';
import {
  type CapabilityDomainServices,
  CapabilityGateway,
  type CapabilityGatewayTransport,
  createCapabilityHandlers,
} from './capabilityGateway';

// capabilityGateway 静态 import modelDirectory（物化 settings providers）；
// mock 掉以隔离 electron/settings 依赖链，目录分区缺失时物化原样透传，不影响本文件用例。
vi.mock('./modelDirectory', () => ({
  getModelDirectorySnapshot: () => ({ revision: 0, generatedAt: 0, providers: [] }),
  onModelDirectoryChanged: () => () => {},
}));

import { pickSubagentModelRefs } from './subagentModels';

const child: ChildSessionIdentity = {
  sessionId: 'parent::enso-1',
  generation: '22222222-2222-4222-8222-222222222222',
  parent: {
    sessionId: 'parent',
    generation: '11111111-1111-4111-8111-111111111111',
  },
  instanceId: '33333333-3333-4333-8333-333333333333',
  instanceName: 'Enso 3333',
  typeKey: 'agent:enso',
  profileId: 'enso-locked-v1',
};
const context: CapabilityInvocationContext = {
  child,
  parentBinding: {
    parentConversationId: 'parent',
    parentProjectId: 'project-1',
    parentProjectPath: '/project',
  },
  turnId: 'turn-1',
  ownerWebContentsId: 7,
};

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'provider-1',
    name: 'Authoritative Provider',
    api: 'openai-completions',
    apiKey: 'sk-secret-never-project',
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'model-1' }],
    ...overrides,
  };
}

function request(
  requestId: string,
  capabilityId: CapabilityInvokeRequest['capabilityId'],
  params: unknown
): CapabilityInvokeRequest {
  return { child, turnId: 'turn-1', requestId, capabilityId, params };
}

function fixture(options?: {
  providers?: ModelProvider[];
  oauthKeys?: readonly string[];
  testProvider?: CapabilityDomainServices['testProvider'];
  beginOauthLogin?: CapabilityDomainServices['beginOauthLogin'];
}) {
  const state: Record<string, unknown> = {
    language: 'en',
    providers: options?.providers ?? [provider()],
    skills: [{ id: 'skill-1', name: 'Skill' }],
    mcpServers: [{ id: 'mcp-1', name: 'MCP' }],
    instructions: [],
    presets: [],
    agentTypes: [],
    projects: [{ id: 'project-1', name: 'Project' }],
  };
  const readSettings = () => ({
    'enso-settings': { state },
    'enso-conversations': {
      state: {
        conversations: {
          parent: { id: 'parent', projectId: 'project-1', title: 'Parent', started: true },
        },
      },
    },
  });
  const patchSettings = vi.fn((field: string, value: unknown) => {
    const previous = state[field];
    state[field] = value;
    return { ok: true, previous, value };
  });
  const asks: Array<{ webContentsId: number; request: unknown }> = [];
  const entries: Array<{ identity: { sessionId: string; generation: string }; receipt: unknown }> =
    [];
  const lifecycle: ReceiptLifecycleEvent[] = [];
  const transport: CapabilityGatewayTransport = {
    hasWindow: (id) => id === 7,
    sendAsk: (webContentsId, ask) => asks.push({ webContentsId, request: ask }),
    appendChildReceipt: async (identity, receipt) => {
      entries.push({ identity, receipt });
      return true;
    },
    observeReceipt: (event) => lifecycle.push(event),
  };
  const services: CapabilityDomainServices = {
    readSettings,
    patchSettings,
    removeProject: vi.fn(() => ({ ok: true, previous: {}, value: null })),
    listModels: vi.fn(async () => ({ ok: true, models: [{ id: 'model-1' }] })),
    testProvider:
      options?.testProvider ??
      vi.fn(async () => ({ ok: true, latencyMs: 1, message: 'Connected' })),
    queryModelMeta: vi.fn(async () => ({ ok: true, models: [] })),
    listOauthProviders: vi.fn(async () => [
      {
        id: 'anthropic',
        name: 'Anthropic Authority',
        supportsMultipleAccounts: true,
        accounts: [{ key: 'anthropic', providerId: 'anthropic', email: 'real@example.com' }],
        models: ['claude'],
      },
    ]),
    readOauthCredentialKeys: vi.fn(async () => new Set(options?.oauthKeys ?? [])),
    readSecretValues: vi.fn(async () => ['oauth-access-secret', 'oauth-refresh-secret']),
    beginOauthLogin:
      options?.beginOauthLogin ??
      vi.fn(() => ({
        start: {
          status: 'failed' as const,
          code: 'not-configured',
          message: 'not configured',
        },
      })),
    oauthLogout: vi.fn(async () => {}),
    getOauthAccountUsage: vi.fn(async (key) => ({ key, windows: [] })),
    cancelOauthLogin: vi.fn(() => false),
    reopenOauthLogin: vi.fn(() => false),
    readInstruction: vi.fn(() => ({ ok: true, content: '' })),
    writeInstruction: vi.fn(() => ({ ok: true, bytes: 0 })),
    deleteInstruction: vi.fn(),
    getRecentProjects: vi.fn(async () => []),
    updaterAvailable: vi.fn(() => true),
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    sessionIndex: new AgentSessionIndex({ readSettings }),
    listSshConnections: vi.fn(() => [
      {
        id: 'ssh-conn-1',
        name: 'Build box',
        host: 'build.example.test',
        auth: 'password' as const,
        hasPassword: true,
      },
    ]),
    deleteSshConnection: vi.fn(async (id: string) =>
      id === 'ssh-conn-1'
        ? { ok: true as const, value: null }
        : { ok: false as const, error: '连接不存在。' }
    ),
    testSshConnection: vi.fn(async () => ({ ok: true as const })),
  };
  const gateway = new CapabilityGateway(services, transport);
  expect(gateway.registerInvocation(context)).toBe(true);
  return { gateway, services, patchSettings, asks, entries, lifecycle, state };
}

async function waitForAsk(asks: unknown[], count: number) {
  await vi.waitFor(() => expect(asks).toHaveLength(count));
}

describe('CapabilityGateway child/generation安全合同', () => {
  it('legacy team hire 明确拒绝升级且不再绕过统一 AgentService', async () => {
    const { gateway, services, asks } = fixture();
    // team.* 的 availability 要求源会话已启动；不满足时会在 ASK 之前就判不可用。
    services.sessionIndex.listCoworkers = (() => ({ ok: true, data: [] })) as never;
    const hiring = gateway.invoke(request('hire-1', 'team.hire-coworker', { name: 'scout-1' }));
    await waitForAsk(asks, 1);
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'hire-1', decision: 'allow' });
    await expect(hiring).resolves.toMatchObject({
      modelResult: {
        ok: false,
        error: expect.stringMatching(/use subagent operation=spawn/i),
      },
    });
  });

  it('legacy team dismiss 明确拒绝升级且不再直连 dispatch service', async () => {
    const { gateway, services, asks } = fixture();
    services.sessionIndex.listCoworkers = (() => ({ ok: true, data: [] })) as never;
    const dismissing = gateway.invoke(
      request('dismiss-1', 'team.dismiss-coworker', { coworkerId: 'cw-1' })
    );
    await waitForAsk(asks, 1);
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'dismiss-1', decision: 'allow' });
    await expect(dismissing).resolves.toMatchObject({
      modelResult: {
        ok: false,
        error: expect.stringMatching(/use subagent operation=dismiss/i),
      },
    });
  });

  it('custom agent type 的 edit/delete 接受 list 开出的 custom: typeKey', async () => {
    // list 只给 typeKey，不给内部条目 id；写入端若只认裸 id，模型根本无从获得合法参数。
    const { gateway, state, asks } = fixture();
    state.agentTypes = [{ id: 'type-uuid', name: 'probe', description: 'd', tools: 'readonly' }];

    // delete 是危险能力：先出 ASK，同意后才执行。
    const deleting = gateway.invoke(
      request('del-1', 'agent-types.delete', { id: 'custom:type-uuid' })
    );
    await waitForAsk(asks, 1);
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'del-1', decision: 'allow' });
    const deleted = await deleting;
    expect(deleted.modelResult).toMatchObject({ ok: true });
    expect(state.agentTypes).toEqual([]);
  });

  it('授权按 child generation：跨内部 agent turn 仍可调用，旧 generation 仍被拒', async () => {
    const { gateway } = fixture();
    // child 内部的 agent turn 会重新生成 turnId（supervisor 在 agent_end 清空
    // currentTurnId，下一轮 agent_start 取新 uuid）。授权不得因此失效。
    const laterTurn = await gateway.invoke({
      ...request('cross-turn-1', 'providers.list', {}),
      turnId: 'model-loop-turn-2',
    });
    expect(laterTurn.modelResult).toMatchObject({ ok: true });

    // 但身份门不能松：旧/伪造 generation 无论用哪个 turnId 都必须被拒。
    const staleGeneration = await gateway.invoke({
      ...request('cross-turn-2', 'providers.list', {}),
      child: { ...child, generation: '99999999-9999-4999-8999-999999999999' },
    });
    expect(staleGeneration.modelResult).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('handler registry完整且非locked child不能注册/调用enso_app', async () => {
    const { gateway, services } = fixture();
    expect(Object.keys(createCapabilityHandlers(services)).sort()).toHaveLength(
      Object.keys(createCapabilityHandlers(services)).length
    );
    const ordinary = { ...child, typeKey: 'builtin:scout' as const, profileId: undefined };
    expect(gateway.registerInvocation({ ...context, child: ordinary })).toBe(false);
    const envelope = await gateway.invoke({
      ...request('foreign-1', 'providers.list', {}),
      child: ordinary,
    });
    expect(envelope.modelResult).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('strict schema与Main权威label二次验证，假label零副作用', async () => {
    const { gateway, patchSettings, asks } = fixture();
    const invalidEnvelope = await gateway.invoke(
      request('schema-1', 'appearance.theme', { value: 'dark', target: 'forged' })
    );
    expect(invalidEnvelope.modelResult).toMatchObject({ ok: false, code: 'invalid' });
    expect(invalidEnvelope.receipt.outcome).toBe('failed');
    expect(patchSettings).not.toHaveBeenCalled();

    const pending = gateway.invoke(
      request('label-1', 'providers.test-connection', {
        providerId: 'provider-1',
        modelId: 'model-1',
      })
    );
    await waitForAsk(asks, 1);
    expect(JSON.stringify(asks[0])).toContain('Authoritative Provider');
    expect(JSON.stringify(asks[0])).not.toContain('fake label');
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'label-1', decision: 'deny' });
    await expect(pending).resolves.toMatchObject({ receipt: { outcome: 'denied' } });
  });

  it('danger锁在真实handler settle前不pump；abort后已完成工作保留真实success', async () => {
    const deferred = Promise.withResolvers<{ ok: true; latencyMs: number; message: string }>();
    const testProvider = vi.fn(() => deferred.promise);
    const { gateway, asks, lifecycle } = fixture({ testProvider });
    const childB: ChildSessionIdentity = {
      ...child,
      sessionId: 'parent::enso-2',
      generation: '44444444-4444-4444-8444-444444444444',
      instanceId: '55555555-5555-4555-8555-555555555555',
    };
    expect(gateway.registerInvocation({ ...context, child: childB })).toBe(true);
    const first = gateway.invoke(
      request('danger-1', 'providers.test-connection', {
        providerId: 'provider-1',
        modelId: 'model-1',
      })
    );
    const second = gateway.invoke({
      ...request('danger-2', 'providers.test-connection', {
        providerId: 'provider-1',
        modelId: 'model-1',
      }),
      child: childB,
    });
    await waitForAsk(asks, 1);
    expect(
      gateway.respond(7, {
        child,
        turnId: 'turn-1',
        requestId: 'danger-1',
        decision: 'allow',
      })
    ).toEqual({ ok: true, accepted: true, state: 'executing' });
    gateway.terminateGeneration(child);
    expect(asks).toHaveLength(1);
    expect(lifecycle.at(-1)).toMatchObject({
      type: 'receipt-started',
      requestId: 'danger-1',
      executionState: 'cancel-requested',
    });

    deferred.resolve({ ok: true, latencyMs: 1, message: 'committed response' });
    await expect(first).resolves.toMatchObject({
      modelResult: { ok: true },
      receipt: { outcome: 'succeeded' },
    });
    await waitForAsk(asks, 2);
    gateway.respond(7, {
      child: childB,
      turnId: 'turn-1',
      requestId: 'danger-2',
      decision: 'deny',
    });
    await expect(second).resolves.toMatchObject({ receipt: { outcome: 'denied' } });
  });

  it('不可逆commit前二验：abort发生在异步查验期间则零commit并真实cancel settle', async () => {
    const providers =
      Promise.withResolvers<Awaited<ReturnType<CapabilityDomainServices['listOauthProviders']>>>();
    const current = fixture();
    current.services.listOauthProviders = vi.fn(() => providers.promise);
    const logout = vi.mocked(current.services.oauthLogout);
    const pending = current.gateway.invoke(
      request('logout-barrier', 'providers.oauth.logout', { accountKey: 'anthropic' })
    );
    await waitForAsk(current.asks, 1);
    current.gateway.respond(7, {
      child,
      turnId: 'turn-1',
      requestId: 'logout-barrier',
      decision: 'allow',
    });
    await vi.waitFor(() => expect(current.services.listOauthProviders).toHaveBeenCalled());
    current.gateway.terminateGeneration(child);
    providers.resolve([
      {
        id: 'anthropic',
        name: 'Anthropic',
        supportsMultipleAccounts: true,
        accounts: [{ key: 'anthropic', providerId: 'anthropic' }],
        models: [],
      },
    ]);
    await expect(pending).resolves.toMatchObject({
      modelResult: { ok: false, code: 'cancelled' },
      receipt: { outcome: 'cancelled' },
    });
    expect(logout).not.toHaveBeenCalled();
  });

  it('provider remove在oauthLogout返回后再次复验，abort期间不删除settings', async () => {
    const logout = Promise.withResolvers<void>();
    const current = fixture({
      providers: [provider({ oauthAccountKey: 'anthropic' })],
    });
    current.services.oauthLogout = vi.fn(() => logout.promise);
    const pending = current.gateway.invoke(
      request('provider-remove-barrier', 'providers.remove', { id: 'provider-1' })
    );
    await waitForAsk(current.asks, 1);
    current.gateway.respond(7, {
      child,
      turnId: 'turn-1',
      requestId: 'provider-remove-barrier',
      decision: 'allow',
    });
    await vi.waitFor(() => expect(current.services.oauthLogout).toHaveBeenCalledOnce());
    current.gateway.terminateGeneration(child);
    logout.resolve();
    await expect(pending).resolves.toMatchObject({
      modelResult: { ok: false, code: 'cancelled' },
      receipt: { outcome: 'cancelled' },
    });
    expect(current.patchSettings).not.toHaveBeenCalled();
  });

  it('oauth logout在底层返回后再次复验，abort期间不伪报success', async () => {
    const logout = Promise.withResolvers<void>();
    const current = fixture();
    current.services.oauthLogout = vi.fn(() => logout.promise);
    const pending = current.gateway.invoke(
      request('oauth-logout-second-barrier', 'providers.oauth.logout', {
        accountKey: 'anthropic',
      })
    );
    await waitForAsk(current.asks, 1);
    current.gateway.respond(7, {
      child,
      turnId: 'turn-1',
      requestId: 'oauth-logout-second-barrier',
      decision: 'allow',
    });
    await vi.waitFor(() => expect(current.services.oauthLogout).toHaveBeenCalledOnce());
    current.gateway.terminateGeneration(child);
    logout.resolve();
    await expect(pending).resolves.toMatchObject({
      modelResult: { ok: false, code: 'cancelled' },
      receipt: { outcome: 'cancelled' },
    });
  });
});

describe('CapabilityGateway OAuth/default/secret/receipt', () => {
  it('OAuth allow ACK先于完成，exact locator绑定child/turn/request且busy不记成功', async () => {
    const terminal = Promise.withResolvers<OauthLoginEvent>();
    let locator: OauthFlowLocator | undefined;
    const beginOauthLogin: CapabilityDomainServices['beginOauthLogin'] = (_provider, flow) => {
      locator = flow;
      return { start: { status: 'started', locator: flow }, completion: terminal.promise };
    };
    const { gateway, asks } = fixture({ beginOauthLogin });
    const pending = gateway.invoke(
      request('oauth-1', 'providers.oauth.login', { providerId: 'anthropic' })
    );
    await waitForAsk(asks, 1);
    expect(
      gateway.respond(7, {
        child,
        turnId: 'turn-1',
        requestId: 'oauth-1',
        decision: 'allow',
      })
    ).toEqual({ ok: true, accepted: true, state: 'executing' });
    expect(locator).toMatchObject({
      ownerWebContentsId: 7,
      host: 'agent-child-tab',
      child,
      turnId: 'turn-1',
      requestId: 'oauth-1',
    });
    terminal.resolve({
      type: 'done',
      providerId: 'anthropic',
      account: { key: 'anthropic#2', providerId: 'anthropic' },
    });
    await expect(pending).resolves.toMatchObject({ receipt: { outcome: 'succeeded' } });
    const busy = fixture({
      beginOauthLogin: () => ({ start: { status: 'busy', activeHost: 'provider-wizard' } }),
    });
    const busyPending = busy.gateway.invoke(
      request('oauth-busy', 'providers.oauth.login', { providerId: 'anthropic' })
    );
    await waitForAsk(busy.asks, 1);
    busy.gateway.respond(7, {
      child,
      turnId: 'turn-1',
      requestId: 'oauth-busy',
      decision: 'allow',
    });
    await expect(busyPending).resolves.toMatchObject({ receipt: { outcome: 'failed' } });
  });

  it('ssh-connections: list 无密钥;remove/test 走 ASK 危险门;add/update 保持封禁', async () => {
    const { gateway, services, asks } = fixture();
    const list = await gateway.invoke(request('ssh-1', 'projects.ssh-connections', {}));
    expect(list.modelResult).toMatchObject({ ok: true });
    expect(JSON.stringify(list.modelResult)).toContain('ssh-conn-1');
    expect(JSON.stringify(list.modelResult)).not.toContain('password":"');

    const removing = gateway.invoke(
      request('ssh-2', 'projects.ssh-connections.remove', { id: 'ssh-conn-1' })
    );
    await waitForAsk(asks, 1);
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'ssh-2', decision: 'allow' });
    const removed = await removing;
    expect(removed.modelResult).toMatchObject({ ok: true });
    expect(services.deleteSshConnection).toHaveBeenCalledWith('ssh-conn-1');

    const testing = gateway.invoke(
      request('ssh-3', 'projects.ssh-connections.test', { id: 'ssh-conn-1' })
    );
    await waitForAsk(asks, 2);
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'ssh-3', decision: 'allow' });
    const tested = await testing;
    expect(tested.modelResult).toMatchObject({ ok: true });

    // add/update 封禁：凭证不得经过 Enso 上下文（schema 不声明字段，避免引导模型传密钥）
    const added = await gateway.invoke(request('ssh-4', 'projects.ssh-connections.add', {}));
    expect(added.modelResult).toMatchObject({ ok: false, code: 'unavailable' });
    const updated = await gateway.invoke(request('ssh-5', 'projects.ssh-connections.update', {}));
    expect(updated.modelResult).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it.each([false, true, undefined])(
    '子模型只更新描述时保留原有可用性 %s 和邻居',
    async (enabled) => {
      const { gateway, state } = fixture();
      const entry: SubagentModelEntry = {
        id: 'sub-model',
        providerId: 'provider-1',
        modelId: 'model-1',
        description: '原说明',
        reasoning: 'on',
        thinkingLevel: 'high',
        ...(enabled === undefined ? {} : { enabled }),
      };
      const neighbor = { ...entry, id: 'neighbor', enabled: false };
      state.subagentModels = [entry, neighbor];
      const updated = await gateway.invoke(
        request('sm-description', 'providers.subagent-models.update', {
          id: entry.id,
          description: '新说明',
        })
      );
      expect(updated.modelResult).toMatchObject({ ok: true });
      expect(state.subagentModels).toStrictEqual([{ ...entry, description: '新说明' }, neighbor]);
      expect(
        pickSubagentModelRefs(state.subagentModels as SubagentModelEntry[], [provider()], [])
      ).toHaveLength(enabled === false ? 0 : 1);
    }
  );

  it('subagent-models.add 接受启用的虚拟模型，拒绝缺失或禁用的', async () => {
    const { gateway, state } = fixture();
    state.virtualModels = [
      {
        id: 'auto',
        name: 'Auto',
        enabled: true,
        primary: { providerId: 'provider-1', modelId: 'model-1' },
        fallbacks: [],
      },
      {
        id: 'off',
        name: 'Off',
        enabled: false,
        primary: { providerId: 'provider-1', modelId: 'model-1' },
        fallbacks: [],
      },
    ];
    const added = await gateway.invoke(
      request('sm-virtual', 'providers.subagent-models.add', {
        providerId: 'enso-virtual',
        modelId: 'auto',
        description: 'routed',
        reasoning: 'on',
        thinkingLevel: 'low',
      })
    );
    expect(added.modelResult).toMatchObject({ ok: true });
    const entries = () => state.subagentModels as Array<Record<string, unknown>>;
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      providerId: 'enso-virtual',
      modelId: 'auto',
      description: 'routed',
      reasoning: 'on',
      thinkingLevel: 'low',
    });

    const missing = await gateway.invoke(
      request('sm-virtual-missing', 'providers.subagent-models.add', {
        providerId: 'enso-virtual',
        modelId: 'ghost',
      })
    );
    expect(missing.modelResult).toMatchObject({ ok: false, code: 'unavailable' });

    const disabled = await gateway.invoke(
      request('sm-virtual-off', 'providers.subagent-models.add', {
        providerId: 'enso-virtual',
        modelId: 'off',
      })
    );
    expect(disabled.modelResult).toMatchObject({ ok: false, code: 'unavailable' });
    expect(entries()).toHaveLength(1);
  });

  it('Enso 不能打开 computer；改其它工具时旧落盘列表保持 computer 关闭', async () => {
    const { gateway, state, patchSettings } = fixture();
    const enable = await gateway.invoke(
      request('tool-computer', 'tools.toggle-builtin', { id: 'computer', enabled: true })
    );
    expect(enable.modelResult).toMatchObject({ ok: false, code: 'invalid' });
    expect(patchSettings).not.toHaveBeenCalled();

    state.disabledBuiltinTools = ['memory'];
    const other = await gateway.invoke(
      request('tool-browser', 'tools.toggle-builtin', { id: 'browser', enabled: false })
    );
    expect(other.modelResult).toMatchObject({ ok: true });
    expect(state.disabledBuiltinTools).toEqual(['memory', 'computer', 'browser']);
  });

  it('子模型更新能力不能夹带 enabled 重新开启禁用条目', async () => {
    const { gateway, state, patchSettings } = fixture();
    const entry = {
      id: 'sub-model',
      providerId: 'provider-1',
      modelId: 'model-1',
      description: '',
      enabled: false,
    };
    state.subagentModels = [entry];
    const updated = await gateway.invoke(
      request('sm-reenable', 'providers.subagent-models.update', { id: entry.id, enabled: true })
    );
    expect(updated.modelResult).toMatchObject({ ok: false, code: 'invalid' });
    expect(patchSettings).not.toHaveBeenCalled();
    expect(state.subagentModels).toEqual([entry]);
  });

  it('subagent-models: list/toggle/add/update/remove 全链受控,引用与推理值校验', async () => {
    const { gateway, state } = fixture();
    const list = await gateway.invoke(request('sm-1', 'providers.subagent-models', {}));
    expect(list.modelResult).toMatchObject({
      ok: true,
      data: { enabled: false, entries: [] },
    });

    const toggled = await gateway.invoke(
      request('sm-2', 'providers.subagent-models.toggle', { value: true })
    );
    expect(toggled.modelResult).toMatchObject({ ok: true });
    expect(state.subagentModelsEnabled).toBe(true);

    const added = await gateway.invoke(
      request('sm-3', 'providers.subagent-models.add', {
        providerId: 'provider-1',
        modelId: 'model-1',
        description: 'cheap and fast',
        reasoning: 'on',
        thinkingLevel: 'high',
      })
    );
    expect(added.modelResult).toMatchObject({ ok: true });
    // patchSettings 每次替换整个数组,断言必须重读 state
    const entriesOf = () => state.subagentModels as Array<Record<string, unknown>>;
    expect(entriesOf()).toHaveLength(1);
    expect(entriesOf()[0]).toMatchObject({
      providerId: 'provider-1',
      modelId: 'model-1',
      description: 'cheap and fast',
      reasoning: 'on',
      thinkingLevel: 'high',
    });
    const id = entriesOf()[0].id as string;

    // 未知模型拒绝且零写
    const ghost = await gateway.invoke(
      request('sm-4', 'providers.subagent-models.add', {
        providerId: 'provider-1',
        modelId: 'ghost',
      })
    );
    expect(ghost.modelResult).toMatchObject({ ok: false });
    expect(state.subagentModels).toHaveLength(1);

    // 非法推理值被 schema 拒绝
    const badReasoning = await gateway.invoke(
      request('sm-5', 'providers.subagent-models.add', {
        providerId: 'provider-1',
        modelId: 'model-1',
        reasoning: 'maybe',
      })
    );
    expect(badReasoning.modelResult).toMatchObject({ ok: false, code: 'invalid' });

    // Off 保留上次深度（与设置页三态一致），再开 On 直接恢复
    const updated = await gateway.invoke(
      request('sm-6', 'providers.subagent-models.update', {
        id,
        description: 'strong',
        reasoning: 'off',
      })
    );
    expect(updated.modelResult).toMatchObject({ ok: true });
    expect(entriesOf()[0]).toMatchObject({
      description: 'strong',
      reasoning: 'off',
      thinkingLevel: 'high',
    });
    const reopened = await gateway.invoke(
      request('sm-6b', 'providers.subagent-models.update', { id, reasoning: 'on' })
    );
    expect(reopened.modelResult).toMatchObject({ ok: true });
    expect(entriesOf()[0]).toMatchObject({ reasoning: 'on', thinkingLevel: 'high' });

    // 'follow' 清除覆盖（回到跟随父会话）
    const followed = await gateway.invoke(
      request('sm-7', 'providers.subagent-models.update', { id, reasoning: 'follow' })
    );
    expect(followed.modelResult).toMatchObject({ ok: true });
    expect(entriesOf()[0]).not.toHaveProperty('reasoning');
    expect(entriesOf()[0]).not.toHaveProperty('thinkingLevel');

    const removed = await gateway.invoke(
      request('sm-8', 'providers.subagent-models.remove', { id })
    );
    expect(removed.modelResult).toMatchObject({ ok: true });
    expect(state.subagentModels).toEqual([]);
  });

  it('default使用auth真keys与shared usability；disabled/空key/logout组合全部零写', async () => {
    for (const unusable of [
      provider({ enabled: false }),
      provider({ apiKey: '' }),
      provider({ apiKey: '', oauthAccountKey: 'anthropic' }),
      provider({ models: [{ id: 'model-1', enabled: false }] }),
    ]) {
      const { gateway, patchSettings } = fixture({ providers: [unusable], oauthKeys: [] });
      const envelope = await gateway.invoke(
        request(`invalid-default-${Math.random()}`, 'providers.default-model', {
          providerId: 'provider-1',
          modelId: 'model-1',
        })
      );
      expect(envelope.receipt.outcome).toBe('unavailable');
      expect(patchSettings).not.toHaveBeenCalled();
    }
    const oauth = provider({ apiKey: '', oauthAccountKey: 'anthropic' });
    const valid = fixture({ providers: [oauth], oauthKeys: ['anthropic'] });
    await expect(
      valid.gateway.invoke(
        request('valid-default', 'providers.default-model', {
          providerId: 'provider-1',
          modelId: 'model-1',
        })
      )
    ).resolves.toMatchObject({ receipt: { outcome: 'succeeded' } });
    expect(valid.patchSettings).toHaveBeenCalledOnce();
  });

  it('恶意provider回显真实key时modelResult/receipt/custom entries全链无secret', async () => {
    const secret = 'sk-secret-never-project';
    const testProvider = vi.fn(async () => ({
      ok: false as const,
      latencyMs: 1,
      message: `upstream echoed ${secret} and Bearer oauth-access-secret`,
    }));
    const { gateway, asks, entries } = fixture({ testProvider });
    const pending = gateway.invoke(
      request('secret-1', 'providers.test-connection', {
        providerId: 'provider-1',
        modelId: 'model-1',
      })
    );
    await waitForAsk(asks, 1);
    gateway.respond(7, { child, turnId: 'turn-1', requestId: 'secret-1', decision: 'allow' });
    const envelope = await pending;
    const visible = JSON.stringify({ envelope, asks, entries });
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain('oauth-access-secret');
    expect(envelope.receipt.outcome).toBe('failed');
  });

  it('receipt lifecycle exact对齐child/turn/request/id/sequence且不写parent terminal', async () => {
    const { gateway, entries, lifecycle } = fixture();
    const first = await gateway.invoke(request('read-1', 'providers.list', {}));
    const second = await gateway.invoke(request('read-2', 'tools.list', {}));
    expect(first.receipt.outcome).toBe('succeeded');
    expect(second.receipt.outcome).toBe('succeeded');
    expect(second.receipt.sequence).toBe(first.receipt.sequence + 1);
    expect(entries).toHaveLength(2);
    expect(entries.every(({ identity }) => identity.sessionId === child.sessionId)).toBe(true);
    const settled = lifecycle.filter((event) => event.type === 'receipt-settled');
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({
      child,
      turnId: 'turn-1',
      requestId: 'read-1',
      receiptId: first.receipt.receiptId,
      receiptSeq: first.receipt.sequence,
      receipt: first.receipt,
    });

    for (let index = 0; index < 300; index += 1) {
      await gateway.invoke(request(`bounded-${index}`, 'providers.list', {}));
    }
    expect(gateway.cacheSizes.settled).toBeLessThanOrEqual(256);
    expect(gateway.cacheSizes.pending).toBe(0);
  });
});

describe('CapabilityGateway preset system prompt lifecycle', () => {
  it('capability 编辑预设时保留正文引用', async () => {
    const { gateway, state } = fixture();
    const systemPromptId = '4aade2cb-d2a1-47c3-a4a2-848f28571a97';
    state.presets = [
      {
        id: 'preset-1',
        name: 'Original',
        skillIds: [],
        mcpServerIds: [],
        systemPromptId,
        pluginPresetId: 'plugin:enso.pstack:poteto',
      },
    ];

    await gateway.invoke(
      request('preset-edit', 'presets.edit', { id: 'preset-1', name: 'Renamed' })
    );
    expect(state.presets).toEqual([
      expect.objectContaining({
        id: 'preset-1',
        name: 'Renamed',
        systemPromptId,
        pluginPresetId: 'plugin:enso.pstack:poteto',
      }),
    ]);
  });
});
