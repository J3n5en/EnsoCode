/**
 * 派发注入的记忆检索命中投影：穿过 utilityProcess 边界的纯 JSON 形状。
 * relevance 是查询与记忆向量的余弦；命中不是由向量通道来的时为 null。
 */
export interface MemoryRecallHit {
  id: string;
  title: string;
  content: string;
  spaceId: string;
  relevance: number | null;
  /** 有矛盾证据（challenges 未被拒绝）时列出发起方 id；矛盾记忆不注入但可被新记忆顶替 */
  challengedBy?: string[];
}
