import { rmSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import { projectNameFromPath } from '@shared/projectName';
import type { DispatchRecord, SecretaryDeletePreview } from '@shared/types/secretary';
import { appendAudit } from './audit';
import type { ContactService } from './contact/service';
import { managerOfSync } from './crossSecretary';
import { forgetSecretaryProfile } from './profile';
import { DEFAULT_SECRETARY_ID } from './registry';
import { dropRelaysFor } from './relay';
import { enqueueUpdate } from './results';
import {
  forgetSecretaryProject,
  type SecretaryContext,
  secretaryContext,
  secretaryRegistry,
} from './secretaries';
import { SecretaryStore } from './store';
import { forgetSecretaryHandlers } from './tools';

/** default 秘书的目录就是 userData/secretary 本身：删它只删属于它的文件，全局文件留着 */
const DEFAULT_OWNED_FILES = [
  'profile.json',
  'persona.md',
  'avatar.png',
  'dispatch.json',
  'todos.json',
  'schedules.json',
  'audit.jsonl',
  'audit.1.jsonl',
  'daily.jsonl',
  'following.json',
  'contact.json',
  'contact-token.bin',
  'workspace',
];

function titleOf(row: Record<string, unknown> | undefined, fallback: string): string {
  return typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : fallback;
}

async function memoryCount(projectId: string | null): Promise<number> {
  if (!projectId) return 0;
  const { listMemoriesForAdmin, openExistingMemoryDb } = await import('../memoryAdmin');
  const db = openExistingMemoryDb(path.join(app.getPath('userData'), 'memory', 'memory.db'));
  if (!db) return 0;
  try {
    return listMemoriesForAdmin(db, { spaceId: `proj:${projectId}`, limit: 1, offset: 0 }).total;
  } finally {
    db.close();
  }
}

/** 删除前的提醒：它正在管的会话、待办、定时、联系方式绑定与记忆条数 */
export async function deletePreview(
  ctx: SecretaryContext,
  contact: ContactService | undefined
): Promise<SecretaryDeletePreview> {
  const store = new SecretaryStore(ctx.dir);
  const { readPersistedConversations } = await import('../../ipc/settings');
  const { getSourceAuthorityRegistry } = await import('../../ipc/agent');
  const rows = readPersistedConversations();
  const projects = getSourceAuthorityRegistry()?.projection().projects ?? [];
  const sessions = Object.values(store.dispatch().dispatched)
    .filter((record) => rows[record.conversationId]?.archived !== true)
    .map((record) => {
      const project = projects.find((candidate) => candidate.projectId === record.projectId);
      return {
        conversationId: record.conversationId,
        title: titleOf(rows[record.conversationId], record.conversationId),
        projectName: project ? projectNameFromPath(project.canonicalPath) : '',
        takeover: record.takeover !== undefined,
      };
    });
  return {
    secretaryId: ctx.id,
    name: store.profile()?.name ?? null,
    sessions,
    todos: store
      .todos()
      .filter((todo) => todo.doneAt === undefined)
      .map((todo) => ({ id: todo.id, text: todo.text })),
    schedules: store.schedules().map((schedule) => ({ id: schedule.id, name: schedule.name })),
    contacts: contact?.bindings() ?? [],
    memories: await memoryCount(ctx.projectId),
  };
}

export interface DeleteSecretaryPorts {
  /** 撤掉派出会话的续跑与看门狗：无人管理后不再由 Main 驱动 */
  forget(conversationId: string): void;
}

/**
 * 删除秘书：它管理的会话变为无人管理（派发记录随秘书文件删除、会话行上的派出归属清掉，
 * 会话本身不删）；它自己的秘书会话与隐藏项目移除；私有记忆删除；目录删除。
 * 调用方先停掉它的回传宿主与联系方式。
 */
export async function deleteSecretary(
  ctx: SecretaryContext,
  ports: DeleteSecretaryPorts
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = new SecretaryStore(ctx.dir);
  const records = Object.values(store.dispatch().dispatched);
  const settings = await import('../../ipc/settings');
  const agent = await import('../../ipc/agent');
  const authority = agent.getSourceAuthorityRegistry();
  for (const record of records) {
    ports.forget(record.conversationId);
    // 提问不再转给一个已经不存在的秘书：恢复成直接问用户
    agent.setAskRelayFromMain(record.conversationId, undefined);
  }
  const managed = new Set(records.map((record) => record.conversationId));
  const own = new Set(
    (authority?.projection().conversations ?? [])
      .filter((conversation) => conversation.projectId === ctx.projectId)
      .map((conversation) => conversation.conversationId)
  );
  for (const conversationId of own) {
    if (agent.isRootSessionAlive(conversationId)) await agent.releaseRootFromMain(conversationId);
  }
  settings.patchConversationsState((state) => {
    for (const [id, row] of Object.entries(state.conversations)) {
      if (own.has(id)) {
        delete state.conversations[id];
        continue;
      }
      const origin = row.secretaryOrigin as { secretaryId?: unknown } | undefined;
      if (!origin) continue;
      const owner =
        typeof origin.secretaryId === 'string' ? origin.secretaryId : DEFAULT_SECRETARY_ID;
      if (owner !== ctx.id && !managed.has(id)) continue;
      const { secretaryOrigin: _origin, ...rest } = row;
      state.conversations[id] = rest;
    }
    state.order = state.order.filter((id) => !own.has(id));
  });
  if (ctx.projectId) {
    try {
      const { projectSpaceId } = await import('../memory/types');
      const { removeMemorySpace } = await import('../memoryCleanup');
      await removeMemorySpace(app.getPath('userData'), projectSpaceId(ctx.projectId));
    } catch (error) {
      console.warn('[secretary] removing private memory failed:', error);
    }
    authority?.removeSecretaryProject(ctx.projectId);
  }
  const targets =
    ctx.id === DEFAULT_SECRETARY_ID
      ? DEFAULT_OWNED_FILES.map((name) => path.join(ctx.dir, name))
      : [ctx.dir];
  for (const target of targets) rmSync(target, { recursive: true, force: true });
  secretaryRegistry().remove(ctx.id);
  forgetSecretaryProject(ctx.id);
  forgetSecretaryProfile(ctx.id);
  forgetSecretaryHandlers(ctx.id);
  appendAudit(secretaryRegistry().dir(DEFAULT_SECRETARY_ID), {
    at: Date.now(),
    secretaryConversationId: null,
    op: 'secretary_delete',
    targetId: ctx.id,
    ok: true,
    detail: `sessions=${records.length}`,
  });
  return { ok: true };
}

/** 秘书最近活跃的一条会话：转交过来的记录要挂到它上面 */
async function latestConversationOf(ctx: SecretaryContext): Promise<string | null> {
  const { getSourceAuthorityRegistry } = await import('../../ipc/agent');
  const { readPersistedConversations } = await import('../../ipc/settings');
  const rows = readPersistedConversations();
  let latest: { id: string; at: number } | null = null;
  for (const conversation of getSourceAuthorityRegistry()?.projection().conversations ?? []) {
    if (conversation.kind !== 'root' || conversation.projectId !== ctx.projectId) continue;
    const row = rows[conversation.conversationId];
    if (!row || row.archived === true) continue;
    const at = typeof row.lastActiveAt === 'number' ? row.lastActiveAt : 0;
    if (!latest || at > latest.at) latest = { id: conversation.conversationId, at };
  }
  return latest?.id ?? null;
}

export type TransferResult = { ok: true } | { ok: false; error: string };

/**
 * 把会话从管理它的秘书转交给另一个秘书：派发记录与挂起的转交提问搬过去，
 * 原秘书的点名与待投更新清掉，会话行上的归属改写，接收方收到一条说明。
 * 读改写都在同步段里完成，中间不留 await。
 */
export async function transferConversation(
  conversationId: string,
  toSecretaryId: string
): Promise<TransferResult> {
  const { readPersistedConversations, patchConversationsState } = await import(
    '../../ipc/settings'
  );
  const { getSourceAuthorityRegistry, setAskRelayFromMain } = await import('../../ipc/agent');
  const { visibleProjects } = await import('./readers');
  const target = secretaryContext(toSecretaryId);
  if (!target) return { ok: false, error: 'not-found' };
  const fromId = managerOfSync(conversationId, readPersistedConversations());
  const from = fromId ? secretaryContext(fromId) : null;
  if (!from) return { ok: false, error: 'not-managed' };
  if (from.id === target.id) return { ok: false, error: 'same-secretary' };
  const targetStore = new SecretaryStore(target.dir);
  const projects = getSourceAuthorityRegistry()?.projection().projects ?? [];
  const fromStore = new SecretaryStore(from.dir);
  const record = fromStore.dispatch().dispatched[conversationId];
  const projectId =
    record?.projectId ??
    getSourceAuthorityRegistry()?.conversation(conversationId)?.projectId ??
    '';
  const targetProfile = targetStore.profile();
  if (
    targetProfile &&
    !visibleProjects(projects, targetProfile).some((project) => project.projectId === projectId)
  ) {
    return { ok: false, error: 'not-visible' };
  }
  const owner = await latestConversationOf(target);
  if (!owner) return { ok: false, error: 'no-secretary-conversation' };
  const now = Date.now();

  const fromFile = fromStore.dispatch();
  const moved: DispatchRecord =
    fromFile.dispatched[conversationId] !== undefined
      ? { ...fromFile.dispatched[conversationId], secretaryConversationId: owner }
      : {
          conversationId,
          projectId,
          secretaryConversationId: owner,
          createdAt: now,
          turn: 0,
          lastState: 'idle',
          lastEventAt: now,
          takeover: { grantedAt: now, via: 'user' },
        };
  const relays = Object.entries(fromFile.relays ?? {}).filter(
    ([, relay]) => relay.conversationId === conversationId
  );
  delete fromFile.dispatched[conversationId];
  fromFile.named = fromFile.named.filter((id) => id !== conversationId);
  fromFile.outbox = fromFile.outbox.filter(
    (update) => !('conversationId' in update && update.conversationId === conversationId)
  );
  dropRelaysFor(fromFile, conversationId);
  fromStore.saveDispatch(fromFile);

  const targetFile = targetStore.dispatch();
  targetFile.dispatched[conversationId] = moved;
  if (relays.length > 0)
    targetFile.relays = { ...targetFile.relays, ...Object.fromEntries(relays) };
  targetFile.untracked = (targetFile.untracked ?? []).filter((id) => id !== conversationId);
  const fromName = fromStore.profile()?.name ?? from.id;
  const row = readPersistedConversations()[conversationId];
  const title = titleOf(row, conversationId);
  targetFile.outbox = enqueueUpdate(targetFile.outbox, {
    key: `transfer:${conversationId}:${now}`,
    at: now,
    text: `The user transferred session ${conversationId} ("${title}") from ${fromName} to you. You manage it from now on: its results and questions come to you.`,
    kind: 'peer-message',
    fromSecretaryId: from.id,
    fromName,
    chain: `transfer:${conversationId}`,
    hop: 0,
    origins: [from.id],
  });
  targetStore.saveDispatch(targetFile);

  patchConversationsState((state) => {
    const current = state.conversations[conversationId];
    if (!current?.secretaryOrigin || typeof current.secretaryOrigin !== 'object') return;
    state.conversations[conversationId] = {
      ...current,
      secretaryOrigin: {
        ...(current.secretaryOrigin as Record<string, unknown>),
        secretaryConversationId: owner,
        secretaryId: target.id,
      },
    };
  });
  const name = targetProfile?.name.trim();
  setAskRelayFromMain(conversationId, name ? { name } : undefined);
  const detail = `from=${from.id} to=${target.id}`;
  for (const ctx of [from, target]) {
    appendAudit(ctx.dir, {
      at: now,
      secretaryConversationId: null,
      op: 'session_transfer',
      targetId: conversationId,
      ok: true,
      detail,
    });
  }
  return { ok: true };
}
