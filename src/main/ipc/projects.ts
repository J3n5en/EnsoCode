import path from 'node:path';
import { resolveSshTarget } from '@shared/ssh';
import { IPC_CHANNELS } from '@shared/types';
import {
  parseCreateProjectAuthorityRequest,
  parseRemoveProjectAuthorityRequest,
  parseSelectProjectAuthorityRequest,
} from '@shared/types/agent';
import { app, ipcMain } from 'electron';
import { getRecentProjects } from '../services/recentProjects';
import { removeConversationSessionFiles } from '../services/sessionFileCleanup';
import { getSshConnectionStore } from '../services/sshConnectionStore';
import { sshProbeDirectory } from '../services/sshProbe';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry } from './agent';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECTS_GET_RECENT, async () => {
    try {
      return await getRecentProjects();
    } catch (error) {
      console.warn('[RecentProjects] Failed:', error);
      return [];
    }
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
      });
      if (failure) return { accepted: false, error: failure };
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
