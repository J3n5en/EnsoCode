/**
 * 会话 ↔ worktree 绑定的持久化注册表（main 权威）。
 * spawn cwd 授权（ipc/agent.ts persistedRootSpawn）依赖此表判断 worktree 路径合法性。
 * 单文件 JSON（userData/worktrees.json），量小，同步读写 + 内存缓存。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionWorktree } from '../../../shared/types/worktree';

export class WorktreeRegistry {
  private records = new Map<string, SessionWorktree>();

  constructor(private readonly filePath: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
          const r = value as SessionWorktree;
          if (r && typeof r.path === 'string' && typeof r.branch === 'string') {
            this.records.set(id, r);
          }
        }
      }
    } catch {
      // 文件不存在或损坏：当空库
    }
  }

  get(conversationId: string): SessionWorktree | undefined {
    return this.records.get(conversationId);
  }

  set(record: SessionWorktree): void {
    this.records.set(record.conversationId, record);
    this.flush();
  }

  share(fromConversationId: string, toConversationId: string): void {
    const source = this.records.get(fromConversationId);
    if (!source) return;
    this.records.set(toConversationId, { ...source, conversationId: toConversationId });
    this.flush();
  }

  delete(conversationId: string): void {
    if (this.records.delete(conversationId)) this.flush();
  }

  list(projectId?: string): SessionWorktree[] {
    const all = [...this.records.values()];
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.records), null, 2));
  }
}
