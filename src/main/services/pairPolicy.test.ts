import { describe, expect, it } from 'vitest';
import {
  checkSetModel,
  checkSpawn,
  narrowSnapshot,
  parsePhoneCommand,
  SNAPSHOT_TAIL_MESSAGES,
  type SpawnWhitelist,
  shouldForward,
  sliceHistory,
} from './pairPolicy';

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

  it('set-model 结构校验：三个 id 必填', () => {
    expect(
      parsePhoneCommand({ type: 'set-model', sessionId: 's', providerId: 'pr', modelId: 'm' }).ok
    ).toBe(true);
    expect(parsePhoneCommand({ type: 'set-model', sessionId: 's', providerId: 'pr' }).ok).toBe(
      false
    );
    expect(parsePhoneCommand({ type: 'set-model', providerId: 'pr', modelId: 'm' }).ok).toBe(false);
  });

  it('history 结构校验：beforeIndex 必须是非负数字', () => {
    expect(parsePhoneCommand({ type: 'history', sessionId: 's', beforeIndex: 40 }).ok).toBe(true);
    expect(parsePhoneCommand({ type: 'history', sessionId: 's', beforeIndex: -1 }).ok).toBe(false);
    expect(parsePhoneCommand({ type: 'history', sessionId: 's' }).ok).toBe(false);
    expect(parsePhoneCommand({ type: 'history', beforeIndex: 40 }).ok).toBe(false);
  });

  it('set-reasoning / set-thinking 结构校验', () => {
    expect(parsePhoneCommand({ type: 'set-reasoning', sessionId: 's', enabled: true }).ok).toBe(
      true
    );
    expect(parsePhoneCommand({ type: 'set-reasoning', sessionId: 's', enabled: 'yes' }).ok).toBe(
      false
    );
    expect(parsePhoneCommand({ type: 'set-reasoning', enabled: true }).ok).toBe(false);
    for (const level of ['low', 'medium', 'high', 'max']) {
      expect(parsePhoneCommand({ type: 'set-thinking', sessionId: 's', level }).ok).toBe(true);
    }
    expect(parsePhoneCommand({ type: 'set-thinking', sessionId: 's', level: 'ultra' }).ok).toBe(
      false
    );
    expect(parsePhoneCommand({ type: 'set-thinking', sessionId: 's' }).ok).toBe(false);
  });
});

describe('set-model 白名单校验', () => {
  const whitelist: SpawnWhitelist = {
    projects: [],
    providers: [{ id: 'pr1', models: [{ id: 'm1' }] }],
  };
  const cmd = { type: 'set-model' as const, sessionId: 's', providerId: 'pr1', modelId: 'm1' };

  it('provider/model 在下发集合内才放行', () => {
    expect(checkSetModel(cmd, whitelist).ok).toBe(true);
  });

  it('伪造 providerId / 未启用 model 被拒', () => {
    expect(checkSetModel({ ...cmd, providerId: 'evil' }, whitelist).ok).toBe(false);
    expect(checkSetModel({ ...cmd, modelId: 'not-enabled' }, whitelist).ok).toBe(false);
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

  it('identity 形状事件（worker 新格式）按 identity.sessionId 过滤', () => {
    const id = (sessionId: string) => ({ sessionId, generation: 'g1' });
    expect(shouldForward({ type: 'message-upsert', identity: id('a'), index: 1 }, 'a')).toBe(true);
    expect(shouldForward({ type: 'message-upsert', identity: id('b'), index: 1 }, 'a')).toBe(false);
    expect(shouldForward({ type: 'subagent-update', identity: id('b') }, 'a')).toBe(false);
    expect(shouldForward({ type: 'subagent-update', identity: id('a') }, 'a')).toBe(true);
  });

  it('增量续传：只补 index 大于游标的消息', () => {
    const ev = (index: number) => ({ type: 'message-upsert', sessionId: 'a', index });
    expect(shouldForward(ev(5), 'a', 3)).toBe(true);
    expect(shouldForward(ev(3), 'a', 3)).toBe(false);
    expect(shouldForward(ev(1), 'a', 3)).toBe(false);
  });
});

describe('snapshot 裁剪（批事件，本身无 sessionId）', () => {
  const event = {
    type: 'snapshot',
    sessions: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
  };

  it('只保留订阅会话，不把全部会话正文推给手机', () => {
    const out = narrowSnapshot(event, 'b');
    expect(out?.sessions.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('未订阅任何会话时不转发', () => {
    expect(narrowSnapshot(event, null)).toBeNull();
  });

  it('订阅会话不在快照里时不转发', () => {
    expect(narrowSnapshot(event, 'zzz')).toBeNull();
  });

  it('identity 形状快照（worker 新格式）按 identity.sessionId 匹配并补扁平 sessionId', () => {
    const out = narrowSnapshot(
      {
        type: 'snapshot',
        sessions: [
          { identity: { sessionId: 'a', generation: 'g1' }, messages: [{ text: 'hi' }] },
          { identity: { sessionId: 'b', generation: 'g1' } },
        ],
      },
      'a'
    );
    const session = out?.sessions[0] as { sessionId?: string; messages?: unknown[] };
    // 手机端按扁平 sessionId 消费，归一化必须补上
    expect(session?.sessionId).toBe('a');
    expect(session?.messages).toEqual([{ text: 'hi' }]);
  });

  it('snapshot 不走通用过滤（避免整包漏出）', () => {
    expect(shouldForward({ type: 'snapshot' }, 'a')).toBe(false);
  });

  it('长对话只发尾窗并标 baseIndex，避免超中继单帧上限被丢', () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    const out = narrowSnapshot({ type: 'snapshot', sessions: [{ sessionId: 'a', messages }] }, 'a');
    const session = out?.sessions[0] as { messages: unknown[]; baseIndex?: number };
    expect(session.messages.length).toBeLessThanOrEqual(SNAPSHOT_TAIL_MESSAGES);
    expect(session.baseIndex).toBe(200 - session.messages.length);
    // 尾窗必须是最新的消息
    expect(session.messages.at(-1)).toEqual({ role: 'user', text: 'm199' });
  });

  it('短对话不裁剪，baseIndex 为 0', () => {
    const messages = [{ text: 'a' }, { text: 'b' }];
    const out = narrowSnapshot({ type: 'snapshot', sessions: [{ sessionId: 'a', messages }] }, 'a');
    const session = out?.sessions[0] as { messages: unknown[]; baseIndex?: number };
    expect(session.messages).toHaveLength(2);
    expect(session.baseIndex).toBe(0);
  });

  it('单条超大消息也受字节预算约束（宁可少发不可超帧）', () => {
    const big = 'x'.repeat(300_000);
    const messages = Array.from({ length: 10 }, () => ({ text: big }));
    const out = narrowSnapshot({ type: 'snapshot', sessions: [{ sessionId: 'a', messages }] }, 'a');
    const session = out?.sessions[0] as { messages: unknown[]; baseIndex?: number };
    // 600KB 预算下 300KB 的消息最多装 2 条
    expect(session.messages.length).toBeLessThanOrEqual(2);
    expect(session.baseIndex).toBe(10 - session.messages.length);
  });
});

describe('history 分页切片', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ text: `m${i}` }));

  it('取 beforeIndex 之前的一页，附 baseIndex', () => {
    const page = sliceHistory(messages, 80);
    expect(page.messages.at(-1)).toEqual({ text: 'm79' });
    expect(page.baseIndex).toBe(80 - page.messages.length);
    expect(page.messages.length).toBeLessThanOrEqual(SNAPSHOT_TAIL_MESSAGES);
  });

  it('beforeIndex 越界或到头时返回空页', () => {
    expect(sliceHistory(messages, 0).messages).toHaveLength(0);
    expect(sliceHistory([], 10).messages).toHaveLength(0);
  });
});
