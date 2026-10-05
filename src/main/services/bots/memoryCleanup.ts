import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 删除后等待在途蒸馏 / KG 收尾，避免模型异步结果重新生成已删除成员的记忆。 */
export async function removeBotMemorySpace(userData: string, spaceId: string): Promise<void> {
  if (!existsSync(join(userData, 'memory', 'memory.db'))) return;
  const host = await import('../memoryHost');
  const db = host.memoryDatabase();
  await host.awaitMemoryDistill();
  await host.awaitMemoryKg();
  const { deleteMemorySpace } = await import('../memoryAdmin');
  deleteMemorySpace(db, spaceId);
  host.notifyMemoryChanged();
}
