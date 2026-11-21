import { rmSync } from 'node:fs';
import path from 'node:path';

/** 旧版更新重启留下的续跑名单：会话恢复只走 restart-manifest，遗留文件启动时删掉、不再据此重试 */
export function discardLegacyInterruptedSessions(dir: string): void {
  rmSync(path.join(dir, 'interrupted-by-update.json'), { force: true });
}
