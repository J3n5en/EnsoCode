import { describe, expect, it } from 'vitest';
import { claim, PAIR_TTL_MS, pairIdFromPublicKey, request, tokenValid } from './pairing';

describe('pairId 派生', () => {
  it('由公钥确定性派生，两端各算一致', async () => {
    expect(await pairIdFromPublicKey('abc123')).toBe(await pairIdFromPublicKey('abc123'));
  });
  it('不同公钥落不同房间', async () => {
    expect(await pairIdFromPublicKey('a')).not.toBe(await pairIdFromPublicKey('b'));
  });
});

describe('配对状态机', () => {
  it('request 新建 requested', () => {
    const s = request(undefined, 1000, 'pk');
    expect(s.phase).toBe('requested');
    expect(s.hostPublicKey).toBe('pk');
  });

  it('request 幂等：未过期返回同一状态', () => {
    const s = request(undefined, 1000, 'pk');
    expect(request(s, 6000, 'pk')).toBe(s);
  });

  it('requested 过期后 request 重建', () => {
    const s = request(undefined, 1000, 'pk');
    const s2 = request(s, 1000 + PAIR_TTL_MS + 1, 'pk');
    expect(s2).not.toBe(s);
    expect(s2.createdAt).toBeGreaterThan(s.createdAt);
  });

  it('claim 前必须存在 requested', () => {
    expect(claim(undefined, 1000, 'boxed', 'iphone').ok).toBe(false);
  });

  it('claim 成功迁移 authorized 并发两个不同 token', () => {
    const res = claim(request(undefined, 1000, 'pk'), 1000, 'boxed', 'iphone');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.next.phase).toBe('authorized');
      expect(res.next.boxedKey).toBe('boxed');
      expect(res.next.deviceName).toBe('iphone');
      expect(res.next.hostToken).toBeTruthy();
      expect(res.next.deviceToken).toBeTruthy();
      expect(res.next.hostToken).not.toBe(res.next.deviceToken);
    }
  });

  it('一次性：authorized 后再 claim 被拒（防抢扫）', () => {
    const first = claim(request(undefined, 1000, 'pk'), 1000, 'boxed', 'a');
    expect(first.ok).toBe(true);
    if (first.ok) expect(claim(first.next, 1000, 'boxed2', 'b').ok).toBe(false);
  });

  it('过期的 requested 不能被 claim', () => {
    const s = request(undefined, 1000, 'pk');
    expect(claim(s, 1000 + PAIR_TTL_MS + 1, 'boxed', 'a').ok).toBe(false);
  });
});

describe('token 校验', () => {
  it('正确 role+token 通过，错误一律拒绝', () => {
    const res = claim(request(undefined, 1000, 'pk'), 1000, 'boxed', 'a');
    if (!res.ok) throw new Error('claim failed');
    const st = res.next;
    expect(tokenValid(st, 'host', st.hostToken as string)).toBe(true);
    expect(tokenValid(st, 'guest', st.deviceToken as string)).toBe(true);
    expect(tokenValid(st, 'host', st.deviceToken as string)).toBe(false); // 角色错配
    expect(tokenValid(st, 'guest', 'wrong')).toBe(false);
    expect(tokenValid(st, 'host', '')).toBe(false);
  });

  it('requested 阶段任何 token 都拒绝', () => {
    expect(tokenValid(request(undefined, 1000, 'pk'), 'host', 'x')).toBe(false);
  });
});
