import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 删除一个记忆空间；服务侧先等在途蒸馏 / KG 收尾，避免模型异步结果把已删的实体写回来。 */
export async function removeMemorySpace(userData: string, spaceId: string): Promise<void> {
  if (!existsSync(join(userData, 'memory', 'memory.db'))) return;
  const host = await import('./memoryHost');
  await host.memoryServiceOp('remove-space', { spaceId });
}
