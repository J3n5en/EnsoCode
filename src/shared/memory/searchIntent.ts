/** 检索意图只做本地启发式，不调 LLM。供 deep 模式换通道权重。 */

export type SearchIntent = 'factual' | 'conceptual' | 'relationship';

const RELATIONSHIP_RE = /\b(relat(?:e|es|ed|ion|ionship)|between\b.+\band\b|\bversus\b|\bvs\.?)\b/i;
const RELATIONSHIP_CJK = /关系|相关|之间|和.+的关系/;
const CONCEPTUAL_RE = /\b(why|how|explain|what(?:'s| is| are)\b)/i;
const CONCEPTUAL_CJK = /为什么|如何|怎么|是什么|为何/;

export function detectSearchIntent(query: string): SearchIntent {
  if (RELATIONSHIP_RE.test(query) || RELATIONSHIP_CJK.test(query)) return 'relationship';
  if (CONCEPTUAL_RE.test(query) || CONCEPTUAL_CJK.test(query)) return 'conceptual';
  return 'factual';
}

/** 通道顺序与 searchMemories 一致：FTS / vector / entity */
export function channelWeights(intent: SearchIntent): [number, number, number] {
  if (intent === 'relationship') return [0.8, 1, 1.3];
  if (intent === 'conceptual') return [0.8, 1.2, 0.8];
  return [1.2, 1, 0.8];
}
