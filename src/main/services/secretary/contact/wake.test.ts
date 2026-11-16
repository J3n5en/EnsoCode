import { describe, expect, it } from 'vitest';
import { deliverToSecretary, type SecretaryWakePorts } from './wake';

function fake(alive: boolean, resumeOk = true) {
  const calls: string[] = [];
  const ports: SecretaryWakePorts = {
    alive: () => alive,
    resume: async (id) => {
      calls.push(`resume:${id}`);
      if (resumeOk) alive = true;
      return resumeOk ? { ok: true } : { ok: false, error: 'no remembered model' };
    },
    prompt: (id, text) => {
      calls.push(`prompt:${id}:${text}`);
      return { ok: true };
    },
  };
  return { ports, calls };
}

describe('deliverToSecretary', () => {
  it('秘书会话没在跑：先拉起再送入这句话', async () => {
    const { ports, calls } = fake(false);
    expect(await deliverToSecretary(ports, 'sec-1', 'hi')).toEqual({ ok: true });
    expect(calls).toEqual(['resume:sec-1', 'prompt:sec-1:hi']);
  });

  it('拉起失败：不投递，带回失败原因', async () => {
    const { ports, calls } = fake(false, false);
    expect(await deliverToSecretary(ports, 'sec-1', 'hi')).toEqual({
      ok: false,
      error: 'no remembered model',
    });
    expect(calls).toEqual(['resume:sec-1']);
  });

  it('会话已在跑：直接投，不重复拉起', async () => {
    const { ports, calls } = fake(true);
    expect(await deliverToSecretary(ports, 'sec-1', 'hi')).toEqual({ ok: true });
    expect(calls).toEqual(['prompt:sec-1:hi']);
  });

  it('投递被拒：带回错误', async () => {
    const { ports } = fake(true);
    ports.prompt = () => ({ ok: false, error: 'stale generation' });
    expect(await deliverToSecretary(ports, 'sec-1', 'hi')).toEqual({
      ok: false,
      error: 'stale generation',
    });
  });
});
