import { randomUUID } from 'node:crypto';
import { app } from '@platform';
import { parseProfile, parseProfileDraft } from '@shared/secretary/parse';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretarySchedule,
  SecretaryTodo,
} from '@shared/types/secretary';
import { appendAudit } from './audit';
import { notifySecretaryChanged } from './dispatch';
import { saveProposalRecord } from './proposals';
import type { SecretarySessionStatus } from './readers';
import { syncSystemSchedules } from './schedules';
import { type SecretaryContext, secretaryContexts } from './secretaries';
import { SecretaryStore } from './store';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

type MaybePromise<T> = T | Promise<T>;

/** Main 侧的档案写入数据源；测试注入假实现，生产走文件末尾的 secretaryProfilePorts */
export interface SecretaryProfilePorts {
  /** null = 还没完成初次设置 */
  profile(): SecretaryProfile | null;
  saveProfile(profile: SecretaryProfile): SecretaryProfile;
  persona(): string;
  writePersona(persona: string): void;
  /** 清掉 profile.json / persona.md / avatar.png */
  clearFiles(): void;
  /** 只清秘书私有记忆空间 */
  clearPrivateMemory(): Promise<void>;
  todos(): MaybePromise<SecretaryTodo[]>;
  schedules(): SecretarySchedule[];
  saveSchedules(schedules: SecretarySchedule[]): void;
  publish(): void;
  /** 秘书项目里的根会话：档案改了身份或技能后要逐个处理 */
  conversations(): MaybePromise<{ conversationId: string }[]>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
  alive(conversationId: string): MaybePromise<boolean>;
  release(conversationId: string): Promise<{ ok: boolean; error?: string }>;
  /** 活着的会话就地换成按盘上档案现拼的系统提示词，下一条消息生效 */
  refreshPrompt(conversationId: string): MaybePromise<unknown>;
  dispatchFile(): SecretaryDispatchFile;
  saveDispatch(file: SecretaryDispatchFile): void;
  audit(entry: SecretaryAuditEntry): void;
  notify(): void;
  now(): number;
  newId(): string;
  /** 别的秘书已经用了这个名字（大小写不敏感）；缺省表示只有这一个秘书 */
  nameTaken?(name: string): boolean;
}

export type ProfileSaveResult =
  | { ok: true; profile: SecretaryProfile }
  | { ok: false; error: string };

export type ProfileResetResult = { ok: true } | { ok: false; error: string };

export interface SecretaryProfileService {
  /** 表单与提案确认共用的唯一写入口；入参按 unknown 收窄 */
  save(draft: unknown, secretaryConversationId: string | null): Promise<ProfileSaveResult>;
  reset(request: unknown, secretaryConversationId: string | null): Promise<ProfileResetResult>;
  /** 本轮结束：运行中改了名字或人设的会话在这里释放 worker */
  onTurnEnded(conversationId: string): Promise<void>;
  /** 技能或插件变了：释放全部空闲秘书会话，忙的等本轮结束 */
  releaseSessions(): Promise<void>;
  propose(params: Record<string, unknown>, ctx: SecretaryOpContext): Promise<SecretaryOpResult>;
}

function defaultProfile(): SecretaryProfile {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
}

/** 草案覆盖到当前档案上：没提到的字段保持原值，null 表示清掉 */
function mergeProfile(
  current: SecretaryProfile | null,
  draft: SecretaryProfileDraft,
  now: number
): SecretaryProfile {
  const { persona: _persona, avatar, addressAs, dailyBriefAt, ...rest } = draft;
  const base = current ?? defaultProfile();
  const merged: SecretaryProfile = {
    ...base,
    ...rest,
    avatar: mergeAvatar(base.avatar, avatar),
    version: 1,
    updatedAt: now,
  };
  if (addressAs === null) delete merged.addressAs;
  else if (addressAs) merged.addressAs = addressAs;
  if (dailyBriefAt === null) delete merged.dailyBriefAt;
  else if (dailyBriefAt) merged.dailyBriefAt = dailyBriefAt;
  return merged;
}

function sameIds(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** 草案只能改颜色。图片版本留在磁盘上的那一份，上传和移除走 setAvatar。 */
function mergeAvatar(
  base: SecretaryProfile['avatar'],
  patch: SecretaryProfileDraft['avatar']
): SecretaryProfile['avatar'] {
  const color = patch?.color ?? base.color;
  return base.imageVersion
    ? {
        color,
        imageVersion: base.imageVersion,
        ...(base.imageHash ? { imageHash: base.imageHash } : {}),
      }
    : { color };
}

/** 提案参数是扁平的（avatarColor / persona），这里转成档案草案 */
function draftFromParams(params: Record<string, unknown>): SecretaryProfileDraft {
  const dropped = new Set(['avatar', 'image', 'imageVersion', 'avatarPath', 'path', 'avatarColor']);
  const draft: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!dropped.has(key)) draft[key] = value;
  }
  if (typeof params.avatarColor === 'string') draft.avatar = { color: params.avatarColor };
  return draft as SecretaryProfileDraft;
}

export function createSecretaryProfile(ports: SecretaryProfilePorts): SecretaryProfileService {
  /** 运行中改了名字或人设的会话：本轮结束再释放，免得把正在跑的一轮打断 */
  const pendingReleases = new Set<string>();

  async function releaseIfIdle(conversationId: string): Promise<void> {
    if (!(await ports.alive(conversationId))) return;
    const status = await ports.status(conversationId);
    if (status.state === 'idle' && status.pendingAsks + status.pendingApprovals === 0) {
      await ports.release(conversationId);
    } else {
      pendingReleases.add(conversationId);
    }
  }

  async function applyEffects(
    before: SecretaryProfile | null,
    profile: SecretaryProfile,
    identityChanged: boolean
  ): Promise<void> {
    syncSystemSchedules(ports, profile, await ports.todos());
    // 插件与技能在 spawn 时定死：勾选变了，活着的会话还挂着旧工具集与旧 skill 表
    const kitChanged =
      identityChanged ||
      !sameIds(before?.pluginIds, profile.pluginIds) ||
      !sameIds(before?.skillIds, profile.skillIds) ||
      !sameIds(before?.disabledSkillNames, profile.disabledSkillNames);
    const conversations = await ports.conversations();
    // 称呼、语言、风格等只进提示词：活着的会话就地换，不释放、不丢历史
    for (const { conversationId } of conversations) {
      if (await ports.alive(conversationId)) await ports.refreshPrompt(conversationId);
    }
    if (!kitChanged) return;
    for (const { conversationId } of conversations) await releaseIfIdle(conversationId);
  }

  return {
    async save(draft, secretaryConversationId) {
      const parsed = parseProfileDraft(draft);
      if (!parsed.ok) return parsed;
      // 手机命令、秘书间消息都靠名字认人：同一台机器上不许重名
      if (parsed.draft.name !== undefined && ports.nameTaken?.(parsed.draft.name)) {
        return { ok: false, error: 'name-taken' };
      }
      const before = ports.profile();
      const personaBefore = ports.persona();
      const profile = ports.saveProfile(mergeProfile(before, parsed.draft, ports.now()));
      const persona = parsed.draft.persona;
      if (persona !== undefined) ports.writePersona(persona);
      ports.audit({
        at: ports.now(),
        secretaryConversationId,
        op: 'profile_save',
        ok: true,
      });
      try {
        await applyEffects(
          before,
          profile,
          before?.name !== profile.name || (persona !== undefined && persona !== personaBefore)
        );
      } catch (error) {
        // 档案已经落盘：副作用失败不回滚，也不让表单以为没保存
        console.warn('[secretary] profile effects failed:', error);
      }
      ports.notify();
      return { ok: true, profile };
    },

    async reset(request, secretaryConversationId) {
      const clearMemory =
        request && typeof request === 'object' && !Array.isArray(request)
          ? (request as { clearMemory?: unknown }).clearMemory
          : undefined;
      if (typeof clearMemory !== 'boolean') return { ok: false, error: 'invalid request' };
      ports.clearFiles();
      if (clearMemory) {
        try {
          await ports.clearPrivateMemory();
        } catch (error) {
          console.warn('[secretary] clearing private memory failed:', error);
        }
      }
      syncSystemSchedules(ports, null, await ports.todos());
      ports.audit({
        at: ports.now(),
        secretaryConversationId,
        op: 'profile_reset',
        ok: true,
        ...(clearMemory ? { detail: 'clear-memory' } : {}),
      });
      ports.notify();
      return { ok: true };
    },

    async onTurnEnded(conversationId) {
      if (!pendingReleases.delete(conversationId)) return;
      await ports.release(conversationId);
    },

    async releaseSessions() {
      for (const { conversationId } of await ports.conversations()) {
        await releaseIfIdle(conversationId);
      }
    },

    async propose(params, ctx) {
      if (!ctx.secretaryConversationId) return { ok: false, error: 'invalid arguments' };
      const parsed = parseProfileDraft(draftFromParams(params));
      if (!parsed.ok) return parsed;
      if (Object.keys(parsed.draft).length === 0) return { ok: false, error: 'invalid arguments' };
      const now = ports.now();
      const file = ports.dispatchFile();
      const { saved, changed } = saveProposalRecord(file, {
        id: ports.newId(),
        secretaryConversationId: ctx.secretaryConversationId,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        kind: 'profile',
        draft: parsed.draft,
      });
      if (changed) {
        ports.saveDispatch(file);
        ports.notify();
      }
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'secretary_profile_propose',
        targetId: saved.proposalId,
        ok: true,
        detail: saved.reused ? 'awaiting_confirmation (existing)' : 'awaiting_confirmation',
      });
      return {
        ok: true,
        result: {
          status: 'awaiting_confirmation',
          proposalId: saved.proposalId,
          changes: profileChanges(ports.profile(), ports.persona(), parsed.draft),
          ...(saved.reused ? { reused: true } : {}),
          ...(saved.note ? { note: saved.note } : {}),
        },
      };
    },
  };
}

function stable(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

/** 提案当时的旧值。确认之后档案会变，卡片不能再去读当前档案。 */
function profileChanges(
  before: SecretaryProfile | null,
  persona: string,
  draft: SecretaryProfileDraft
): { field: string; before: unknown; after: unknown }[] {
  const rows: { field: string; before: unknown; after: unknown }[] = [];
  const put = (field: string, prev: unknown, next: unknown) => {
    if (stable(prev) === stable(next)) return;
    rows.push({ field, before: prev ?? null, after: next ?? null });
  };
  if (draft.name !== undefined) put('name', before?.name ?? null, draft.name);
  if (draft.avatar?.color) put('avatarColor', before?.avatar.color ?? null, draft.avatar.color);
  if (draft.visibleProjectIds)
    put('visibleProjectIds', before?.visibleProjectIds ?? null, draft.visibleProjectIds);
  if (draft.maxRunningDispatches !== undefined) {
    put('maxRunningDispatches', before?.maxRunningDispatches ?? null, draft.maxRunningDispatches);
  }
  if (draft.patrolEnabled !== undefined) {
    put('patrolEnabled', before?.patrolEnabled ?? null, draft.patrolEnabled);
  }
  if (draft.cleanupSkipConfirm !== undefined) {
    put('cleanupSkipConfirm', before?.cleanupSkipConfirm ?? null, draft.cleanupSkipConfirm);
  }
  if ('addressAs' in draft) put('addressAs', before?.addressAs ?? null, draft.addressAs ?? null);
  if (draft.replyLanguage) put('replyLanguage', before?.replyLanguage ?? null, draft.replyLanguage);
  if (draft.style) put('style', before?.style ?? null, draft.style);
  if (draft.notify) put('notify', before?.notify ?? null, draft.notify);
  if ('dailyBriefAt' in draft)
    put('dailyBriefAt', before?.dailyBriefAt ?? null, draft.dailyBriefAt ?? null);
  if (draft.persona !== undefined) put('persona', persona || null, draft.persona);
  return rows;
}

/**
 * 一个秘书的生产端口：档案、人设、审计都在它自己的目录里。
 * Main 的既有函数全部经动态 import 取：本模块被 tools.ts 静态依赖，静态反向依赖 ipc/agent 会成环。
 */
export function profilePortsFor(ctx: SecretaryContext): SecretaryProfilePorts {
  const store = () => new SecretaryStore(ctx.dir);
  return {
    profile: () => store().profile(),
    saveProfile: (profile) => store().saveProfile(profile),
    persona: () => store().readPersona(),
    writePersona: (persona) => store().writePersona(persona),
    clearFiles: () => store().clearProfile(),
    clearPrivateMemory: async () => {
      if (!ctx.projectId) return;
      const { projectSpaceId } = await import('../memory/types');
      const { removeMemorySpace } = await import('../memoryCleanup');
      await removeMemorySpace(app.getPath('userData'), projectSpaceId(ctx.projectId));
    },
    todos: () => store().todos(),
    schedules: () => store().schedules(),
    saveSchedules: (schedules) => {
      store().saveSchedules(schedules);
    },
    publish: () => notifySecretaryChanged(),
    conversations: async () => {
      if (!ctx.projectId) return [];
      const { getSourceAuthorityRegistry } = await import('../../ipc/agent');
      return (getSourceAuthorityRegistry()?.projection().conversations ?? [])
        .filter(
          (conversation) =>
            conversation.projectId === ctx.projectId &&
            conversation.kind === 'root' &&
            !conversation.bot
        )
        .map((conversation) => ({ conversationId: conversation.conversationId }));
    },
    status: async (conversationId) =>
      (await import('../../ipc/agent')).observedSessionStatus(conversationId),
    alive: async (conversationId) =>
      (await import('../../ipc/agent')).isRootSessionAlive(conversationId),
    release: async (conversationId) =>
      (await import('../../ipc/agent')).releaseRootFromMain(conversationId),
    refreshPrompt: async (conversationId) =>
      (await import('../../ipc/agent')).refreshSecretaryPromptFromMain(conversationId),
    dispatchFile: () => store().dispatch(),
    saveDispatch: (file) => {
      store().saveDispatch(file);
    },
    audit: (entry) => appendAudit(ctx.dir, entry),
    notify: () => {
      notifySecretaryChanged();
    },
    now: () => Date.now(),
    newId: () => randomUUID(),
    nameTaken: (name) => secretaryNameTaken(ctx.id, name),
  };
}

/** 档案服务带着「改名等本轮结束再释放」的状态：每个秘书一份，按 id 复用 */
const profileServices = new Map<string, SecretaryProfileService>();

export function secretaryProfileFor(ctx: SecretaryContext): SecretaryProfileService {
  let service = profileServices.get(ctx.id);
  if (!service) {
    service = createSecretaryProfile(profilePortsFor(ctx));
    profileServices.set(ctx.id, service);
  }
  return service;
}

export function forgetSecretaryProfile(id: string): void {
  profileServices.delete(id);
}

/** 名字唯一：别的秘书档案里有同名（大小写不敏感、去首尾空白）就算占用 */
export function secretaryNameTaken(selfId: string, name: string): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return false;
  return secretaryContexts().some(
    (other) =>
      other.id !== selfId &&
      new SecretaryStore(other.dir).profile()?.name.trim().toLocaleLowerCase() === wanted
  );
}

export function profileHandlersFor(ctx: SecretaryContext): {
  secretary_profile_propose: SecretaryOpHandler;
} {
  return {
    secretary_profile_propose: (params, op) => secretaryProfileFor(ctx).propose(params, op),
  };
}
