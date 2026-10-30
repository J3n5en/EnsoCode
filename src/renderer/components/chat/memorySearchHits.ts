export interface MemorySearchHit {
  id: string;
  title: string;
  content: string;
  unitType: string | null;
  space: 'global' | 'project' | null;
  /** 原始相关度（向量余弦）；没有时为 null */
  relevance: number | null;
}

/** memory_capture：写入的那条，或未写入时挡住它的相似记忆 */
export type MemoryCaptureView =
  | { written: true; deduplicated: boolean; memory: MemorySearchHit }
  | { written: false; candidates: MemorySearchHit[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRecord(output: string | null): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseHits(
  list: unknown,
  relevanceKey: 'relevance' | 'similarity'
): MemorySearchHit[] | null {
  if (!Array.isArray(list)) return null;
  const hits: MemorySearchHit[] = [];
  for (const raw of list) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      typeof raw.title !== 'string' ||
      typeof raw.content !== 'string'
    ) {
      return null;
    }
    const { spaceId, [relevanceKey]: relevance } = raw;
    hits.push({
      id: raw.id,
      title: raw.title,
      content: raw.content,
      unitType: typeof raw.unitType === 'string' && raw.unitType ? raw.unitType : null,
      space:
        spaceId === 'global'
          ? 'global'
          : typeof spaceId === 'string' && spaceId.startsWith('proj:')
            ? 'project'
            : null,
      relevance: typeof relevance === 'number' && Number.isFinite(relevance) ? relevance : null,
    });
  }
  return hits;
}

/** memory_search 输出（Main bridge 投影的 JSON）→ 命中列表；形状不符返回 null，由调用方回退原文 */
export function parseMemorySearchHits(output: string | null): MemorySearchHit[] | null {
  const parsed = parseRecord(output);
  return parsed ? parseHits(parsed.results, 'relevance') : null;
}

/** memory_capture 输出 → 展示模型；写入回执不带正文，正文取自调用参数 */
export function parseMemoryCapture(
  output: string | null,
  content: string | undefined
): MemoryCaptureView | null {
  const parsed = parseRecord(output);
  if (parsed?.status === 'candidates_found') {
    const candidates = parseHits(parsed.candidates, 'similarity');
    return candidates ? { written: false, candidates } : null;
  }
  if (parsed?.status !== 'inserted' || !isRecord(parsed.memory) || !content) return null;
  const memory = parseHits([{ ...parsed.memory, content }], 'relevance')?.[0];
  return memory ? { written: true, deduplicated: parsed.deduplicated === true, memory } : null;
}
