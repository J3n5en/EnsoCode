import { describe, expect, it } from 'vitest';
import { classifyNatMapping, describeCandidates } from './nat';

const host4 = 'candidate:1 1 UDP 2122 192.168.1.10 51234 typ host';
const host6 = 'candidate:2 1 UDP 2122 2409:8a00:1:2::10 51234 typ host';
const srflxA = 'candidate:3 1 UDP 1686 203.0.113.9 61000 typ srflx raddr 192.168.1.10 rport 51234';
const srflxSameMapping =
  'candidate:4 1 UDP 1686 203.0.113.9 61000 typ srflx raddr 192.168.1.10 rport 51234';
const srflxOtherPort =
  'candidate:5 1 UDP 1686 203.0.113.9 61777 typ srflx raddr 192.168.1.10 rport 51234';
const srflxOtherBase =
  'candidate:6 1 UDP 1686 203.0.113.9 62000 typ srflx raddr 192.168.1.10 rport 51235';

describe('NAT 映射类型推断（同一本地端口经不同 STUN 的 srflx 映射）', () => {
  it('没有任何 srflx：无法判断（UDP 被封或 STUN 不可达）', () => {
    expect(classifyNatMapping([host4, host6])).toBe('none');
  });

  it('同一 raddr:rport 映射到不同公网端口 ⇒ 对称 NAT', () => {
    expect(classifyNatMapping([host4, srflxA, srflxOtherPort])).toBe('symmetric');
  });

  it('只有一种映射（含重复）⇒ 锥形 NAT', () => {
    expect(classifyNatMapping([host4, srflxA, srflxSameMapping])).toBe('cone');
  });

  it('不同本地端口的映射不同不算对称', () => {
    expect(classifyNatMapping([srflxA, srflxOtherBase])).toBe('cone');
  });

  it('容忍 a= 前缀与非法行', () => {
    expect(classifyNatMapping([`a=${srflxA}`, 'garbage', `a=${srflxOtherPort}`])).toBe('symmetric');
  });
});

describe('候选摘要文案', () => {
  it('统计类型、地址族与 NAT 类型', () => {
    expect(describeCandidates([host4, host6, srflxA])).toBe('host×2 srflx×1 v6 nat=cone');
  });

  it('无候选', () => {
    expect(describeCandidates([])).toBe('none');
  });
});
