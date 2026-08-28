import { describe, expect, it } from 'vitest';
import { checkSpawn, parsePhoneCommand, type SpawnWhitelist, shouldForward } from './pairPolicy';

describe('手机命令白名单', () => {
  it('放行 prompt/steer/abort/审批/ask/snapshot/subscribe', () => {
    const ok = [
      { type: 'prompt', sessionId: 's', text: 'hi' },
      { type: 'steer', sessionId: 's', text: 'go' },
      { type: 'abort', sessionId: 's' },
      { type: 'approval-respond', sessionId: 's', requestId: 'r', decision: 'allow' },
      { type: 'ask-respond', sessionId: 's', requestId: 'r', answer: 'yes' },
      { type: 'snapshot' },
      { type: 'subscribe', sessionId: 's', sinceIndex: 3 },
      { type: 'subscribe', sessionId: null },
    ];
    for (const cmd of ok) expect(parsePhoneCommand(cmd).ok, JSON.stringify(cmd)).toBe(true);
  });

  it('拒绝白名单外命令（改审批模式 / 设置写入 / 任意命令）', () => {
    for (const cmd of [
      { type: 'set-approval-mode', sessionId: 's', mode: 'full' },
      { type: 'settings-write', key: 'providers' },
      { type: 'rewind', sessionId: 's' },
      { type: 'task-stop', sessionId: 's', taskId: 't' },
      {},
      null,
      'prompt',
    ]) {
      expect(parsePhoneCommand(cmd).ok, JSON.stringify(cmd)).toBe(false);
    }
  });

  it('结构不全被拒', () => {
    expect(parsePhoneCommand({ type: 'prompt', text: 'x' }).ok).toBe(false); // 缺 sessionId
    expect(parsePhoneCommand({ type: 'prompt', sessionId: 's', text: '' }).ok).toBe(false); // 空消息
    expect(
      parsePhoneCommand({ type: 'approval-respond', sessionId: 's', requestId: 'r', decision: 'x' })
        .ok
    ).toBe(false);
  });

  it('带图片的 prompt 通过，图片结构非法被拒', () => {
    expect(
      parsePhoneCommand({
        type: 'prompt',
        sessionId: 's',
        text: '',
        images: [{ data: 'base64', mimeType: 'image/png' }],
      }).ok
    ).toBe(true);
    expect(
      parsePhoneCommand({ type: 'prompt', sessionId: 's', text: 'x', images: [{ data: 1 }] }).ok
    ).toBe(false);
  });

  it('spawn 显式拒绝手机传 cwd / apiKey / baseUrl', () => {
    const base = { type: 'spawn', sessionId: 's', projectId: 'p', providerId: 'pr', modelId: 'm' };
    expect(parsePhoneCommand(base).ok).toBe(true);
    expect(parsePhoneCommand({ ...base, cwd: '/etc' }).ok).toBe(false);
    expect(parsePhoneCommand({ ...base, apiKey: 'sk-x' }).ok).toBe(false);
    expect(parsePhoneCommand({ ...base, baseUrl: 'http://evil' }).ok).toBe(false);
  });
});

describe('spawn 白名单校验（cwd 由 main 反查）', () => {
  const whitelist: SpawnWhitelist = {
    projects: [{ id: 'p1', path: '/Users/me/proj' }],
    providers: [{ id: 'pr1', models: [{ id: 'm1' }] }],
  };
  const cmd = {
    type: 'spawn' as const,
    sessionId: 's',
    projectId: 'p1',
    providerId: 'pr1',
    modelId: 'm1',
  };

  it('合法请求解析出项目路径作为 cwd', () => {
    const res = checkSpawn(cmd, whitelist);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.cwd).toBe('/Users/me/proj');
  });

  it('伪造 projectId 被拒（不能指定任意目录）', () => {
    expect(checkSpawn({ ...cmd, projectId: 'evil' }, whitelist).ok).toBe(false);
  });

  it('伪造 providerId / 未启用 model 被拒', () => {
    expect(checkSpawn({ ...cmd, providerId: 'evil' }, whitelist).ok).toBe(false);
    expect(checkSpawn({ ...cmd, modelId: 'gpt-not-enabled' }, whitelist).ok).toBe(false);
  });
});

describe('下行过滤', () => {
  it('审批/状态/结束/崩溃 始终转发，与订阅无关', () => {
    for (const type of ['status', 'approval-request', 'turn-completed', 'worker-exited']) {
      expect(shouldForward({ type, sessionId: 'other' }, null), type).toBe(true);
    }
  });

  it('message-upsert 只转发当前订阅会话', () => {
    expect(shouldForward({ type: 'message-upsert', sessionId: 'a', index: 1 }, 'a')).toBe(true);
    expect(shouldForward({ type: 'message-upsert', sessionId: 'b', index: 1 }, 'a')).toBe(false);
    expect(shouldForward({ type: 'message-upsert', sessionId: 'a', index: 1 }, null)).toBe(false);
  });

  it('增量续传：只补 index 大于游标的消息', () => {
    const ev = (index: number) => ({ type: 'message-upsert', sessionId: 'a', index });
    expect(shouldForward(ev(5), 'a', 3)).toBe(true);
    expect(shouldForward(ev(3), 'a', 3)).toBe(false);
    expect(shouldForward(ev(1), 'a', 3)).toBe(false);
  });
});
