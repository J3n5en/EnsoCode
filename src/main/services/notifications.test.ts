import type { RendererAgentEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../../agent/approval';

const { notifications, windows, execFileCalls, appState, settingsState } = vi.hoisted(() => ({
  notifications: [] as { title: string; body: string }[],
  windows: [] as { isFocused: () => boolean }[],
  execFileCalls: [] as unknown[][],
  appState: { isPackaged: true },
  settingsState: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    execFileCalls.push(args);
  },
}));

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => true;
    constructor(options: { title: string; body: string }) {
      notifications.push({ title: options.title, body: options.body });
    }
    on() {}
    show() {}
  }
  return {
    Notification,
    BrowserWindow: { getAllWindows: () => windows },
    app: {
      getPath: () => '/tmp/enso-code-test',
      getName: () => 'enso-code',
      on: () => {},
      get isPackaged() {
        return appState.isPackaged;
      },
    },
    ipcMain: { handle: () => {}, on: () => {} },
  };
});

vi.mock('../ipc/settings', () => ({ readSettings: () => settingsState.current }));
vi.mock('../windows/MainWindow', () => ({
  getMainWindow: () => windows[0],
  focusMainWindow: vi.fn(),
}));

import type { HostToRemote } from '@enso/pair';
import {
  maybeNotify,
  maybeNotifyBot,
  notifyFromNode,
  setLocalLayerVisible,
  setViewedSession,
} from './notifications';
import { addRemoteSender, RemoteSender } from './remoteRenderer/senders';
import { resetSessionMuteOverrides, setSessionMuteOverride } from './sessionMuteGate';

const identity = { sessionId: 'conversation-1', generation: 'g' } as const;

const askEvent = (question: string): RendererAgentEvent =>
  ({
    type: 'ask-request',
    identity,
    seq: 1,
    ask: { requestId: 'r1', question },
  }) as unknown as RendererAgentEvent;

describe('maybeNotify', () => {
  beforeEach(() => {
    notifications.length = 0;
    windows.length = 0; // 缺省无聚焦窗口 = 用户不在
    execFileCalls.length = 0;
    appState.isPackaged = true;
    settingsState.current = undefined;
    setViewedSession(null);
    setLocalLayerVisible(true);
    resetSessionMuteOverrides();
    maybeNotify({ type: 'worker-exited' });
  });

  it('ask-request 在窗口未聚焦时弹通知,正文取问题前 100 字', () => {
    maybeNotify(askEvent(`为什么${'长'.repeat(200)}`));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toHaveLength(100);
    expect(notifications[0].body.startsWith('为什么')).toBe(true);
  });

  it('窗口聚焦且正在看该会话时不打扰', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-1');
    maybeNotify(askEvent('在吗'));
    maybeNotify({
      type: 'approval-request',
      identity,
      seq: 2,
      request: { requestId: 'r2', tool: 'bash', summary: 'rm -rf /tmp/x' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });

  it('窗口聚焦但正在看别的会话时照弹', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-2');
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
  });

  it('主窗口盖着远程节点界面时，本机正看着的会话也照弹', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-1');
    setLocalLayerVisible(false);
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
  });

  it('通知内容转给以远程节点方式连来的主界面（不转设置页），本机抑制不影响转发', () => {
    const delivered: Record<'main' | 'settings', HostToRemote[]> = { main: [], settings: [] };
    const senders = (['main', 'settings'] as const).map((kind) => {
      const sender = new RemoteSender('pair-1', `cid-${kind}`, kind, (frame) =>
        delivered[kind].push(frame)
      );
      addRemoteSender(sender);
      return sender;
    });
    try {
      windows.push({ isFocused: () => true });
      setViewedSession('conversation-1');
      maybeNotify(askEvent('在吗'));
      expect(notifications).toHaveLength(0);
      expect(delivered.main).toEqual([
        expect.objectContaining({
          type: 'rpc-event',
          ch: 'notification:show',
          args: [{ sessionId: 'conversation-1', title: '等你回答', body: '在吗' }],
        }),
      ]);
      expect(delivered.settings).toEqual([]);
      setSessionMuteOverride('conversation-1', true);
      maybeNotify(askEvent('静音了'));
      expect(delivered.main).toHaveLength(1);
    } finally {
      for (const sender of senders) sender.destroy();
    }
  });

  it('远程节点转来的通知标题带节点名，点击交给调用方', () => {
    notifyFromNode('B', { sessionId: 's1', title: '修登录 · 回复完成', body: 'done' }, () => {});
    expect(notifications).toEqual([{ title: 'B · 修登录 · 回复完成', body: 'done' }]);
  });

  it('窗口聚焦但没在看任何会话(如设置页)时照弹', () => {
    windows.push({ isFocused: () => true });
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
  });

  it('窗口聚焦且正看着 coworker tab 时,该 coworker 的 ask 不弹', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-1::cw-bob');
    maybeNotify({
      type: 'ask-request',
      identity: { sessionId: 'conversation-1::cw-bob', generation: 'g' },
      seq: 9,
      ask: { requestId: 'r9', question: '选哪个?' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });

  it('静默回传的轮次完成不弹通知', () => {
    maybeNotify({
      type: 'turn-completed',
      identity: { sessionId: 'sec1', generation: 'g' },
      seq: 1,
      digest: {
        firstUserText: '',
        userText: '<session-updates>\n- [turn-ended session:c1] 结束了\n</session-updates>',
        assistantText: '<secretary-silent/>',
      },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });

  it('coworker 的 turn-completed 不弹,但 ask-request 照弹(阻塞必须提醒)', () => {
    const coworker = { sessionId: 'conversation-1::cw-bob', generation: 'g' } as const;
    maybeNotify({
      type: 'turn-completed',
      identity: coworker,
      seq: 3,
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
    maybeNotify({
      type: 'status',
      identity: coworker,
      seq: 3,
      status: 'failed',
      error: 'coworker crashed',
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
    maybeNotify({
      type: 'ask-request',
      identity: coworker,
      seq: 4,
      ask: { requestId: 'r3', question: '选哪个方案?' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(1);
  });

  it('关闭「仅主 agent」后 coworker 完成和失败会弹', () => {
    settingsState.current = {
      'enso-settings': { state: { notifyMainAgentOnly: false } },
    };
    const coworker = { sessionId: 'conversation-1::cw-bob', generation: 'g' } as const;
    maybeNotify({
      type: 'turn-completed',
      identity: coworker,
      seq: 6,
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(1);
    maybeNotify({
      type: 'status',
      identity: coworker,
      seq: 7,
      status: 'failed',
      error: 'coworker crashed',
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(2);
  });

  it('macOS 未打包(未签名)时直接走 osascript,不碰原生 Notification', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    appState.isPackaged = false;
    try {
      maybeNotify(askEvent('在吗'));
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    expect(notifications).toHaveLength(0);
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0][0]).toBe('osascript');
    expect(String((execFileCalls[0][1] as string[])[1])).toContain('在吗');
  });

  it('打包后走原生 Notification,不走 osascript', () => {
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
    expect(execFileCalls).toHaveLength(0);
  });

  it('验收实例（ENSO_VERIFY=1、未打包）既不走 osascript 也不弹原生通知', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const verify = process.env.ENSO_VERIFY;
    appState.isPackaged = false;
    process.env.ENSO_VERIFY = '1';
    try {
      for (const value of ['darwin', 'linux']) {
        Object.defineProperty(process, 'platform', { value });
        maybeNotify(askEvent(`在吗 ${value}`));
      }
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
      if (verify === undefined) delete process.env.ENSO_VERIFY;
      else process.env.ENSO_VERIFY = verify;
      globalThis.__ensoVerifyNotifications = undefined;
    }
    expect(execFileCalls).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('无关事件不弹', () => {
    maybeNotify({
      type: 'status',
      identity,
      seq: 5,
      status: 'running',
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });

  it('通知标题带上会话名，没有标题时保持原样', () => {
    settingsState.current = {
      'enso-conversations': {
        state: { conversations: { 'conversation-1': { title: '修登录' } } },
      },
    };
    maybeNotify(askEvent('在吗'));
    expect(notifications[0]?.title).toBe('修登录 · 等你回答');

    notifications.length = 0;
    settingsState.current = {
      'enso-conversations': {
        state: { conversations: { 'conversation-1': { title: '修登录' } } },
      },
    };
    maybeNotify({
      type: 'ask-request',
      identity: { sessionId: 'conversation-1::cw-bob', generation: 'g' },
      seq: 1,
      ask: { requestId: 'r1', question: '在吗' },
    } as unknown as RendererAgentEvent);
    expect(notifications[0]?.title).toBe('修登录 · 等你回答');

    notifications.length = 0;
    settingsState.current = undefined;
    maybeNotify(askEvent('在吗'));
    expect(notifications[0]?.title).toBe('等你回答');
  });

  it('静音会话不发完成、失败、提问和审批通知，子会话一起静音', () => {
    settingsState.current = {
      'enso-conversations': {
        state: { conversations: { 'conversation-1': { title: '修登录', muted: true } } },
      },
    };
    maybeNotify(askEvent('在吗'));
    maybeNotify({
      type: 'approval-request',
      identity,
      seq: 2,
      request: { requestId: 'apr', tool: 'bash', kind: 'command', summary: 'ls' },
    } as unknown as RendererAgentEvent);
    maybeNotify({
      type: 'turn-completed',
      identity,
      seq: 3,
    } as unknown as RendererAgentEvent);
    maybeNotify({
      type: 'status',
      identity,
      seq: 4,
      status: 'failed',
      error: 'boom',
    } as unknown as RendererAgentEvent);
    maybeNotify({
      type: 'ask-request',
      identity: { sessionId: 'conversation-1::cw-bob', generation: 'g' },
      seq: 5,
      ask: { requestId: 'r3', question: '选哪个方案?' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
    expect(execFileCalls).toHaveLength(0);
  });

  it('取消静音后恢复通知，别的会话不受影响', () => {
    settingsState.current = {
      'enso-conversations': {
        state: { conversations: { 'conversation-1': { muted: true } } },
      },
    };
    setSessionMuteOverride('conversation-1', false);
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
    notifications.length = 0;
    setSessionMuteOverride('conversation-1', true);
    maybeNotify(askEvent('在吗'));
    maybeNotify({
      type: 'ask-request',
      identity: { sessionId: 'conversation-2', generation: 'g' },
      seq: 1,
      ask: { requestId: 'r2', question: '另一条' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.body).toBe('另一条');
  });
});

describe.each(['session', 'bot'] as const)('%s approval notifications', (surface) => {
  const bot = { enabled: true, chatId: 'chat', name: 'Alice', conversationId: 'conversation-1' };
  const emit = (event: RendererAgentEvent) =>
    surface === 'bot' ? maybeNotifyBot(event, bot) : Promise.resolve(maybeNotify(event));
  const request = (phase?: 'reviewing', seq = 1): RendererAgentEvent => ({
    type: 'approval-request',
    identity,
    seq,
    request: {
      requestId: 'apr',
      tool: 'bash',
      kind: 'command',
      summary: 'ls',
      ...(phase ? { phase } : {}),
    },
  });

  beforeEach(async () => {
    notifications.length = 0;
    windows.length = 0;
    appState.isPackaged = true;
    setViewedSession(null);
    resetSessionMuteOverrides();
    settingsState.current = undefined;
    await emit({ type: 'worker-exited' });
  });

  it('代审请求和重复事件不通知，同 ID 转人工只通知一次', async () => {
    await emit(request('reviewing'));
    await emit(request('reviewing', 2));
    expect(notifications).toHaveLength(0);
    await emit(request(undefined, 3));
    await emit(request(undefined, 4));
    expect(notifications).toHaveLength(1);
  });

  it.each(['auto_allow', 'block'] as const)(
    '真实 gate %s 自动结束不发人工通知',
    async (decision) => {
      let seq = 0;
      const pending: Promise<void>[] = [];
      const gate = new ApprovalGate(
        'assistant',
        (info) =>
          pending.push(emit({ type: 'approval-request', identity, seq: ++seq, request: info })),
        (requestId) =>
          pending.push(emit({ type: 'approval-resolved', identity, seq: ++seq, requestId })),
        { review: async () => ({ decision }) }
      );
      await gate.ask('bash', 'command', 'ls', undefined);
      await Promise.all(pending);
      expect(notifications).toHaveLength(0);
    }
  );

  it('普通人工审批与提问仍各通知一次', async () => {
    await emit(request());
    await emit(askEvent('选择哪个？'));
    expect(notifications).toHaveLength(2);
  });

  it('转给秘书的提问不通知，之后的普通提问照常通知', async () => {
    await emit({
      type: 'ask-request',
      identity,
      seq: 1,
      ask: { requestId: 'relayed', question: '用哪个？', relay: { name: '小秘' } },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
    await emit(askEvent('选择哪个？'));
    expect(notifications).toHaveLength(1);
  });

  it('重复人工状态事件只提醒一次', async () => {
    await emit(request());
    await emit(request(undefined, 2));
    expect(notifications).toHaveLength(1);
  });

  it('已解决后乱序到达的旧审批事件不补发通知', async () => {
    await emit(request('reviewing'));
    await emit({ type: 'approval-resolved', identity, seq: 3, requestId: 'apr' });
    await emit(request(undefined, 2));
    expect(notifications).toHaveLength(0);
  });

  it('不同会话或 generation 的相同审批 ID 不互相吞通知', async () => {
    await emit(request());
    await emit({
      ...request(),
      identity: { ...identity, sessionId: 'another-session' },
    } as RendererAgentEvent);
    await emit({
      ...request(),
      identity: { ...identity, generation: 'next' },
    } as RendererAgentEvent);
    expect(notifications).toHaveLength(3);
  });

  if (surface === 'bot') {
    it.each(['parent-ended', 'child-ended', 'worker-exited'] as const)(
      '%s 取消尚未发出的审批通知',
      async (type) => {
        const notification = emit(request());
        await emit({
          type,
          identity: {
            ...identity,
            parent: identity,
            instanceId: 'child',
            instanceName: 'child',
            typeKey: 'agent:enso',
          },
          seq: 2,
          reason: 'ended',
        } as RendererAgentEvent);
        await notification;
        expect(notifications).toHaveLength(0);
      }
    );

    it('等待加载窗口模块时审批已解决，不迟发人工提醒', async () => {
      const notification = emit(request());
      await emit({ type: 'approval-resolved', identity, seq: 2, requestId: 'apr' });
      await notification;
      expect(notifications).toHaveLength(0);
    });
  }
});
