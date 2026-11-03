import { describe, expect, it, vi } from 'vitest';
import { handleSessionRequest, type SessionBridgeDeps } from './sessionBridge';

function deps(patch: Partial<SessionBridgeDeps> = {}): SessionBridgeDeps {
  return {
    conversation: (id) =>
      ({ a: { projectId: 'p1' }, 'a::c1': { projectId: 'p1', parentId: 'a' } })[id] ?? null,
    focus: vi.fn(),
    create: vi.fn(async () => 'n1'),
    prefill: vi.fn(),
    ensure: vi.fn(async () => null),
    ...patch,
  };
}

describe('handleSessionRequest', () => {
  it('切换到已知会话；子会话切到所属主会话的标签', async () => {
    const d = deps();
    await expect(
      handleSessionRequest(
        { sessionId: 'a', op: 'focusSession', payload: { sessionId: 'a::c1' } },
        d
      )
    ).resolves.toEqual({ ok: true, value: null });
    expect(d.focus).toHaveBeenCalledWith('a', 'a::c1');
    await expect(
      handleSessionRequest({ sessionId: 'a', op: 'focusSession', payload: { sessionId: 'zz' } }, d)
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('在发起会话的项目里新建，带文本时只预填输入框', async () => {
    const d = deps();
    await expect(
      handleSessionRequest(
        { sessionId: 'a::c1', op: 'createSession', payload: { text: '整理' } },
        d
      )
    ).resolves.toEqual({ ok: true, value: { sessionId: 'n1' } });
    expect(d.create).toHaveBeenCalledWith('p1');
    expect(d.prefill).toHaveBeenCalledWith('n1', '整理');

    const failed = deps({ create: vi.fn(async () => null) });
    await expect(
      handleSessionRequest({ sessionId: 'a', op: 'createSession', payload: {} }, failed)
    ).resolves.toMatchObject({ ok: false, code: 'CREATE_FAILED' });
    expect(failed.prefill).not.toHaveBeenCalled();
    await expect(
      handleSessionRequest({ sessionId: 'nope', op: 'createSession', payload: {} }, d)
    ).resolves.toMatchObject({ ok: false, code: 'NO_SESSION' });
  });

  it('按会话 id 启动会话：子会话和未知会话拒绝，启动失败带回原因', async () => {
    const d = deps();
    await expect(
      handleSessionRequest({ sessionId: 'a', op: 'ensureSession', payload: {} }, d)
    ).resolves.toEqual({ ok: true, value: null });
    expect(d.ensure).toHaveBeenCalledWith('a');
    await expect(
      handleSessionRequest({ sessionId: 'a::c1', op: 'ensureSession', payload: {} }, d)
    ).resolves.toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    await expect(
      handleSessionRequest({ sessionId: 'zz', op: 'ensureSession', payload: {} }, d)
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const failed = deps({ ensure: vi.fn(async () => '没有可用的模型') });
    await expect(
      handleSessionRequest({ sessionId: 'a', op: 'ensureSession', payload: {} }, failed)
    ).resolves.toEqual({ ok: false, code: 'SESSION_FAILED', error: '没有可用的模型' });
  });
});
