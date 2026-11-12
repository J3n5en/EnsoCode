import type { EmbeddingModelDto } from '@shared/memory/dto';
import { REMOTE_EMBEDDING_SENTINEL_MODEL } from '@shared/memory/remoteEmbedding';

/** 第一列「远程」选项；具体模型写在 `remote:<model>` 里，这个 id 表示还没选。 */
export const REMOTE_EMBEDDING_BACKEND_ID = `remote:${REMOTE_EMBEDDING_SENTINEL_MODEL}`;
const REMOTE_PREFIX = 'remote:';

/** 下拉标签：注册表 id 去掉 local:/remote: 前缀；none 要说清是「只用全文检索」 */
export function embeddingModelLabel(model: EmbeddingModelDto): string {
  if (model.id === 'none') return 'None (full-text only)';
  return model.id.replace(/^(local|remote):/, '');
}

export function isRemoteEmbeddingId(id: string): boolean {
  return id.startsWith(REMOTE_PREFIX) && id.length > REMOTE_PREFIX.length;
}

/** 第一列只区分本地模型 vs 远程后端，具体 remote 模型不占额外选项。 */
export function embeddingBackendSelectValue(id: string): string {
  return isRemoteEmbeddingId(id) ? REMOTE_EMBEDDING_BACKEND_ID : id;
}

/** 发给 embeddings API 的 model；哨兵 id 表示尚未挑选。 */
export function remoteEmbeddingModelId(id: string): string | null {
  if (!isRemoteEmbeddingId(id) || id === REMOTE_EMBEDDING_BACKEND_ID) return null;
  return id.slice(REMOTE_PREFIX.length);
}

export function toRemoteEmbeddingId(modelId: string): string {
  return `${REMOTE_PREFIX}${modelId}`;
}

/** 第一列选「远程」时保留已选模型，避免被哨兵 id 冲掉。 */
export function nextEmbeddingBackend(current: string, selected: string): string {
  if (selected === REMOTE_EMBEDDING_BACKEND_ID) {
    return isRemoteEmbeddingId(current) ? current : REMOTE_EMBEDDING_BACKEND_ID;
  }
  return selected;
}
