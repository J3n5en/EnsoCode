import { DECAY_WEIGHT, RRF_K } from './constants';

// RRF(k=60) 为本项目工程决定。每个通道先按 id 去重保留首次名次，
// 缺失通道允许为空；同分时按首次出现顺序稳定。
export function rrf(
  rankLists: readonly (readonly string[])[],
  k = RRF_K,
  weights?: readonly number[]
): [string, number][] {
  const scores = new Map<string, number>();
  for (const [i, list] of rankLists.entries()) {
    const weight = weights?.[i] ?? 1;
    if (!(weight > 0)) continue;
    const seen = new Set<string>();
    let rank = 0;
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

// semantic*(1-w)+decay*w，w=0.15；年份加分只在同一公式上叠加，不改语义权重（#166）。
export function finalScore(semantic: number, decay: number, temporalBoost = 0): number {
  return semantic * (1 - DECAY_WEIGHT) + decay * DECAY_WEIGHT + temporalBoost;
}

// 页内归一化；全部相同时 semantic=1.0，否则裸 rrf≈0.016 会被 decay 主导。
export function minMaxNormalize(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}
