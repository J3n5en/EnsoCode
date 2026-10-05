import { statSync } from 'node:fs';
import path from 'node:path';
import { resolveSshTarget } from '@shared/ssh';
import { IPC_CHANNELS } from '@shared/types';
import {
  parseCreateProjectAuthorityRequest,
  parseRemoveProjectAuthorityRequest,
  parseSelectProjectAuthorityRequest,
} from '@shared/types/agent';
import { app, ipcMain, shell } from 'electron';
import { listProjectCodeSources } from '../../agent/projectCode';
import { openInApps } from '../services/openInApps';
import { getRecentProjects } from '../services/recentProjects';
import { removeConversationSessionFiles } from '../services/sessionFileCleanup';
import { getSshConnectionStore } from '../services/sshConnectionStore';
import { sshProbeDirectory } from '../services/sshProbe';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry } from './agent';
import { sessionWorktree } from './worktree';

function parseRevealRequest(
  request: unknown
): { projectId: string; conversationId?: string; appId?: string } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const projectId = (request as { projectId?: unknown }).projectId;
  const conversationId = (request as { conversationId?: unknown }).conversationId;
  const appId = (request as { appId?: unknown }).appId;
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  if (
    conversationId !== undefined &&
    (typeof conversationId !== 'string' || conversationId.length === 0)
  )
    return null;
  if (appId !== undefined && (typeof appId !== 'string' || appId.length === 0)) return null;
  return {
    projectId,
    ...(typeof conversationId === 'string' ? { conversationId } : {}),
    ...(typeof appId === 'string' ? { appId } : {}),
  };
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/** 由权威记录推导项目或会话（含 worktree）在本机的工作目录 */
function resolveLocalCwd(parsed: {
  projectId: string;
  conversationId?: string;
}): { cwd: string } | { error: string } {
  const registry = getSourceAuthorityRegistry();
  const project = registry?.project(parsed.projectId);
  if (project?.state !== 'active') return { error: 'unavailable' };
  // ssh 项目的路径在远端，本机打不开；bot-home 只走 Bot 通道
  if (project.kind === 'ssh' || project.kind === 'bot-home') return { error: 'unsupported' };
  let cwd = project.canonicalPath;
  if (parsed.conversationId) {
    const conversation = registry?.conversation(parsed.conversationId);
    if (
      conversation?.kind !== 'root' ||
      conversation.lifecycle === 'ended' ||
      conversation.projectId !== parsed.projectId
    ) {
      return { error: 'unavailable' };
    }
    const worktree = sessionWorktree(parsed.conversationId);
    if (worktree) {
      if (
        worktree.conversationId !== parsed.conversationId ||
        worktree.projectId !== parsed.projectId ||
        worktree.repoPath !== project.canonicalPath ||
        typeof worktree.path !== 'string' ||
        worktree.path.length === 0
      ) {
        return { error: 'unavailable' };
      }
      cwd = worktree.path;
    }
  }
  return isDirectory(cwd) ? { cwd } : { error: 'unavailable' };
}

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECTS_GET_RECENT, async () => {
    try {
      return await getRecentProjects();
    } catch (error) {
      console.warn('[RecentProjects] Failed:', error);
      return [];
    }
  });

  // 渲染层只传标识符，磁盘路径由 Main 从权威记录推导，不接受任意路径
  ipcMain.handle(
    IPC_CHANNELS.PROJECTS_REVEAL,
    async (event, request: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (!isMainWebContents(event.sender.id)) return { ok: false, error: 'unavailable' };
      const parsed = parseRevealRequest(request);
      if (!parsed) return { ok: false, error: 'invalid' };
      const resolved = resolveLocalCwd(parsed);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      const { cwd } = resolved;
      if (parsed.appId) return openInApps.open(parsed.appId, cwd);
      try {
        const failure = await shell.openPath(cwd);
        return failure ? { ok: false, error: failure } : { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'unavailable',
        };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.PROJECTS_OPEN_IN_APPS, async (event) =>
    isMainWebContents(event.sender.id) ? openInApps.list() : []
  );

  // 项目内会被 pi 当代码加载的来源；只读，信任记录由渲染层写入项目设置
  ipcMain.handle(IPC_CHANNELS.PROJECTS_CODE_SOURCES, (event, request: unknown): string[] => {
    if (!isMainWebContents(event.sender.id)) return [];
    const parsed = parseRevealRequest(request);
    if (!parsed || parsed.appId) return [];
    const resolved = resolveLocalCwd(parsed);
    return 'cwd' in resolved ? listProjectCodeSources(resolved.cwd) : [];
  });

  ipcMain.handle(IPC_CHANNELS.SOURCE_PROJECT_CREATE, async (event, request: unknown) => {
    const parsed = parseCreateProjectAuthorityRequest(request);
    const registry = getSourceAuthorityRegistry();
    if (!parsed || !registry || !isMainWebContents(event.sender.id)) {
      return { accepted: false, error: 'Invalid project request.' };
    }
    // ssh 项目：registry 是同步契约，远端目录存在性在这里异步预校验
    if (parsed.kind === 'ssh' && parsed.sshConnectionId) {
      const secret = getSshConnectionStore().getSecret(parsed.sshConnectionId);
      if (!secret) return { accepted: false, error: 'SSH 连接不存在。' };
      const failure = await sshProbeDirectory(resolveSshTarget(secret), parsed.path, {
        auth: secret.auth,
        port: secret.port,
        password: secret.password,
        keyscanHost: secret.host,
      });
      if (failure) return { accepted: false, error: failure.error };
    }
    return registry.createProject(parsed);
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_PROJECT_SELECT, (event, request: unknown) => {
    const parsed = parseSelectProjectAuthorityRequest(request);
    const registry = getSourceAuthorityRegistry();
    return parsed && registry && isMainWebContents(event.sender.id)
      ? registry.selectProject(parsed)
      : { accepted: false, error: 'Invalid project request.' };
  });
  ipcMain.handle(IPC_CHANNELS.SOURCE_PROJECT_REMOVE, (event, request: unknown) => {
    const parsed = parseRemoveProjectAuthorityRequest(request);
    const registry = getSourceAuthorityRegistry();
    if (!parsed || !registry || !isMainWebContents(event.sender.id)) {
      return { accepted: false, error: 'Invalid project request.' };
    }
    // 删除前先快照该项目的会话：渲染层逐会话的 removeConversation 与 removeProject
    // 存在竞态（项目先置 removed 会让 endConversation 失败），Main 侧在这里兑底清理 jsonl。
    const conversations = registry
      .projection()
      .conversations.filter((conversation) => conversation.projectId === parsed.projectId);
    const result = registry.removeProject(parsed);
    if (result.accepted) {
      const sessionDir = path.join(app.getPath('userData'), 'agent', 'sessions');
      for (const conversation of conversations) {
        removeConversationSessionFiles({
          sessionDir,
          conversationId: conversation.conversationId,
          ...(conversation.sessionFile ? { sessionFile: conversation.sessionFile } : {}),
        });
      }
    }
    return result;
  });
}
