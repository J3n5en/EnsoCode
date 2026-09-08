import { normalizeCandidate } from './peer';

/**
 * none = 一条 srflx 都没有（UDP 被封 / STUN 不可达 / 纯 v6）；
 * symmetric = 同一本地端口经不同 STUN 映射到不同公网端口（端点相关映射），两侧都这样时纯 STUN 打洞基本无望；
 * cone = 只见到一种映射。
 */
export type NatMapping = 'none' | 'cone' | 'symmetric';

interface Parsed {
  typ: string;
  address: string;
  port: string;
  base: string | null;
}

function parse(candidate: string): Parsed | null {
  const parts = normalizeCandidate(candidate).split(/\s+/);
  const typIdx = parts.indexOf('typ');
  if (typIdx < 5 || !parts[typIdx + 1]) return null;
  const raddr = parts.indexOf('raddr');
  const rport = parts.indexOf('rport');
  return {
    typ: parts[typIdx + 1],
    address: parts[4],
    port: parts[5],
    base: raddr > 0 && rport > 0 ? `${parts[raddr + 1]}:${parts[rport + 1]}` : null,
  };
}

export function classifyNatMapping(candidates: string[]): NatMapping {
  const mappings = new Map<string, Set<string>>();
  for (const c of candidates) {
    const p = parse(c);
    if (p?.typ !== 'srflx' || !p.base) continue;
    const set = mappings.get(p.base) ?? new Set<string>();
    set.add(`${p.address}:${p.port}`);
    mappings.set(p.base, set);
  }
  if (mappings.size === 0) return 'none';
  for (const set of mappings.values()) if (set.size > 1) return 'symmetric';
  return 'cone';
}

/** 一行摘要供日志：`host×2 srflx×1 v6 nat=cone`；无候选为 `none` */
export function describeCandidates(candidates: string[]): string {
  const counts = new Map<string, number>();
  let v6 = false;
  for (const c of candidates) {
    const p = parse(c);
    if (!p) continue;
    counts.set(p.typ, (counts.get(p.typ) ?? 0) + 1);
    if (p.address.includes(':')) v6 = true;
  }
  if (counts.size === 0) return 'none';
  const parts = [...counts].map(([typ, n]) => `${typ}×${n}`);
  if (v6) parts.push('v6');
  parts.push(`nat=${classifyNatMapping(candidates)}`);
  return parts.join(' ');
}
