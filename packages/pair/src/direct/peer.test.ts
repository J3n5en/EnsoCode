import { describe, expect, it } from 'vitest';
import { isAllowedCandidate, normalizeCandidate } from './peer';

describe('ICE 候选过滤（host + srflx，拒 relay）', () => {
  it('放行 host（含 mDNS .local 与 IPv6）与 srflx', () => {
    const ok = [
      'candidate:1 1 UDP 2122260223 192.168.1.10 51234 typ host',
      'candidate:2 1 UDP 2122260223 3f9a1c2e-1b2d-4c3e.local 51234 typ host generation 0',
      'candidate:3 1 UDP 2122197247 fe80::1c2d:3e4f:5a6b:7c8d 51234 typ host',
      'candidate:4 1 UDP 1686052607 203.0.113.9 61000 typ srflx raddr 192.168.1.10 rport 51234',
      'a=candidate:5 1 UDP 2114977791 10.0.0.2 57690 typ host',
    ];
    for (const c of ok) expect(isAllowedCandidate(c), c).toBe(true);
  });

  it('拒绝 relay 与无法识别的候选', () => {
    const bad = [
      'candidate:6 1 UDP 41885439 198.51.100.7 3478 typ relay raddr 203.0.113.9 rport 61000',
      'candidate:7 1 TCP 1 1.2.3.4 9 typ prflx',
      'garbage',
      '',
    ];
    for (const c of bad) expect(isAllowedCandidate(c), c).toBe(false);
  });
});

describe('候选字符串归一化', () => {
  it('去掉 libdatachannel 风格的 a= 前缀，浏览器风格原样', () => {
    expect(normalizeCandidate('a=candidate:1 1 UDP 1 10.0.0.2 1 typ host')).toBe(
      'candidate:1 1 UDP 1 10.0.0.2 1 typ host'
    );
    expect(normalizeCandidate('candidate:1 1 UDP 1 10.0.0.2 1 typ host')).toBe(
      'candidate:1 1 UDP 1 10.0.0.2 1 typ host'
    );
  });
});
