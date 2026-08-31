import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  AuthorityMutationResult,
  ConversationAuthority,
  ConversationAuthorityProjection,
  ConversationAuthorityRequest,
  CreateConversationAuthorityRequest,
  CreateProjectAuthorityRequest,
  ModelRef,
  ProjectAuthority,
  ProjectAuthorityProjection,
  RemoveProjectAuthorityRequest,
  SelectProjectAuthorityRequest,
  SourceAuthorityProjection,
  UpdateConversationSelectionRequest,
} from '@shared/types/agent';

interface PersistedAuthority {
  migrationVersion: 1;
  projects: ProjectAuthority[];
  conversations: ConversationAuthority[];
}

export interface SourceAuthorityRegistryOptions {
  registryFile: string;
  legacySettings?: () => Record<string, unknown> | null;
  safeSessionRoot?: string;
  randomUuid?: () => string;
  onChanged?: (projection: SourceAuthorityProjection) => void;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * 规范化远端项目绝对路径：去重复/尾斜杠。本机无法 realpath 远端路径，
 * 所以拒绝一切需要解析的形态（相对路径、~、. / ..分量），只收字面绝对路径。
 */
export function normalizeRemoteProjectPath(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const segments = value.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export class SourceAuthorityRegistry {
  private readonly projects = new Map<string, ProjectAuthority>();
  private readonly conversations = new Map<string, ConversationAuthority>();
  private readonly randomUuid: () => string;

  constructor(private readonly options: SourceAuthorityRegistryOptions) {
    this.randomUuid = options.randomUuid ?? randomUUID;
    if (!this.load()) this.migrateLegacy(options.legacySettings?.());
  }

  projection(): SourceAuthorityProjection {
    return {
      projects: [...this.projects.values()].map((value) => ({ ...value })),
      conversations: [...this.conversations.values()].map((value) => ({
        ...value,
        ...(value.selection ? { selection: { ...value.selection } } : {}),
      })),
    };
  }

  project(projectId: string): ProjectAuthority | undefined {
    const value = this.projects.get(projectId);
    return value ? { ...value } : undefined;
  }

  conversation(conversationId: string): ConversationAuthority | undefined {
    const value = this.conversations.get(conversationId);
    return value
      ? { ...value, ...(value.selection ? { selection: { ...value.selection } } : {}) }
      : undefined;
  }

  createProject(
    request: CreateProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    try {
      return request.kind === 'ssh'
        ? this.createSshProject(request)
        : this.createLocalProject(request);
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private createLocalProject(
    request: CreateProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    const canonicalPath = realpathSync(request.path);
    if (!statSync(canonicalPath).isDirectory()) throw new Error('Project path is not a directory.');
    const existing = [...this.projects.values()].find(
      (project) =>
        project.kind !== 'ssh' && project.canonicalPath === canonicalPath && project.state === 'active'
    );
    if (existing) return { accepted: true, value: { ...existing } };
    return this.insertProject({ projectId: this.randomUuid(), canonicalPath, state: 'active', version: 1 });
  }

  /** 远端目录存在性由 IPC handler 先行 ssh 校验（registry 保持同步契约），这里只做路径规范化与去重 */
  private createSshProject(
    request: CreateProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    const sshHost = request.sshHost;
    if (typeof sshHost !== 'string' || sshHost.length === 0)
      throw new Error('Remote project requires an SSH host.');
    const canonicalPath = normalizeRemoteProjectPath(request.path);
    if (!canonicalPath) throw new Error('Remote project path must be absolute.');
    const existing = [...this.projects.values()].find(
      (project) =>
        project.kind === 'ssh' &&
        project.sshHost === sshHost &&
        project.canonicalPath === canonicalPath &&
        project.state === 'active'
    );
    if (existing) return { accepted: true, value: { ...existing } };
    return this.insertProject({
      projectId: this.randomUuid(),
      canonicalPath,
      kind: 'ssh',
      sshHost,
      state: 'active',
      version: 1,
    });
  }

  private insertProject(
    value: ProjectAuthority
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    this.projects.set(value.projectId, value);
    this.commit();
    return { accepted: true, value: { ...value } };
  }

  selectProject(
    request: SelectProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    const project = this.projects.get(request.projectId);
    return project && project.state === 'active' && project.version === request.version
      ? { accepted: true, value: { ...project } }
      : { accepted: false, error: 'Project authority is stale or unavailable.' };
  }

  removeProject(
    request: RemoveProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    const project = this.projects.get(request.projectId);
    if (project?.state !== 'active' || project.version !== request.version) {
      return { accepted: false, error: 'Project authority is stale or unavailable.' };
    }
    project.state = 'removed';
    project.version += 1;
    for (const conversation of this.conversations.values()) {
      if (conversation.projectId === project.projectId && conversation.lifecycle !== 'ended') {
        conversation.lifecycle = 'ended';
        conversation.version += 1;
      }
    }
    this.commit();
    return { accepted: true, value: { ...project } };
  }

  createConversation(
    request: CreateConversationAuthorityRequest
  ): AuthorityMutationResult<ConversationAuthorityProjection> {
    const project = this.projects.get(request.projectId);
    if (project?.state !== 'active' || project.version !== request.projectVersion) {
      return { accepted: false, error: 'Project authority is stale or unavailable.' };
    }
    if (request.conversationId) {
      if (!validId(request.conversationId)) {
        return { accepted: false, error: 'Conversation authority is stale or unavailable.' };
      }
      const existing = this.conversations.get(request.conversationId);
      if (existing) {
        return existing.projectId === project.projectId &&
          existing.kind === 'root' &&
          existing.lifecycle !== 'ended'
          ? { accepted: true, value: this.copyConversation(existing) }
          : { accepted: false, error: 'Conversation authority is stale or unavailable.' };
      }
    }
    const value: ConversationAuthority = {
      conversationId: request.conversationId ?? this.randomUuid(),
      projectId: project.projectId,
      kind: 'root',
      lifecycle: 'draft',
      version: 1,
    };
    this.conversations.set(value.conversationId, value);
    this.commit();
    return { accepted: true, value: this.copyConversation(value) };
  }

  selectConversation(
    request: ConversationAuthorityRequest
  ): AuthorityMutationResult<ConversationAuthorityProjection> {
    const conversation = this.currentConversation(request);
    return conversation
      ? { accepted: true, value: this.copyConversation(conversation) }
      : { accepted: false, error: 'Conversation authority is stale or unavailable.' };
  }

  endConversation(
    request: ConversationAuthorityRequest
  ): AuthorityMutationResult<ConversationAuthorityProjection> {
    const conversation = this.currentConversation(request);
    if (!conversation)
      return { accepted: false, error: 'Conversation authority is stale or unavailable.' };
    conversation.lifecycle = 'ended';
    conversation.version += 1;
    this.commit();
    return { accepted: true, value: this.copyConversation(conversation) };
  }

  removeConversation(
    request: ConversationAuthorityRequest
  ): AuthorityMutationResult<ConversationAuthorityProjection> {
    const conversation = this.conversations.get(request.conversationId);
    if (!conversation || conversation.version !== request.version) {
      return { accepted: false, error: 'Conversation authority is stale or unavailable.' };
    }
    this.conversations.delete(conversation.conversationId);
    this.commit();
    return { accepted: true, value: this.copyConversation(conversation) };
  }

  updateSelection(
    request: UpdateConversationSelectionRequest
  ): AuthorityMutationResult<ConversationAuthorityProjection> {
    const conversation = this.currentConversation(request);
    if (!conversation)
      return { accepted: false, error: 'Conversation authority is stale or unavailable.' };
    const revision = (conversation.selection?.revision ?? 0) + 1;
    conversation.selection = { ...request.selection, revision };
    conversation.version += 1;
    this.commit();
    return { accepted: true, value: this.copyConversation(conversation) };
  }

  markReady(conversationId: string, sessionFile: string, model: ModelRef): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.lifecycle === 'ended') return;
    conversation.lifecycle = 'ready';
    conversation.sessionFile = sessionFile;
    if (
      !conversation.selection ||
      conversation.selection.providerId !== model.providerId ||
      conversation.selection.modelId !== model.modelId
    ) {
      conversation.selection = { ...model, revision: (conversation.selection?.revision ?? 0) + 1 };
    }
    conversation.version += 1;
    this.commit();
  }

  private currentConversation(request: ConversationAuthorityRequest): ConversationAuthority | null {
    const conversation = this.conversations.get(request.conversationId);
    const project = conversation ? this.projects.get(conversation.projectId) : undefined;
    return conversation &&
      conversation.lifecycle !== 'ended' &&
      conversation.version === request.version &&
      project?.state === 'active'
      ? conversation
      : null;
  }

  private copyConversation(value: ConversationAuthority): ConversationAuthorityProjection {
    return { ...value, ...(value.selection ? { selection: { ...value.selection } } : {}) };
  }

  private commit(): void {
    mkdirSync(path.dirname(this.options.registryFile), { recursive: true });
    const temporary = `${this.options.registryFile}.tmp`;
    const state: PersistedAuthority = {
      migrationVersion: 1,
      projects: [...this.projects.values()],
      conversations: [...this.conversations.values()],
    };
    writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.options.registryFile);
    this.options.onChanged?.(this.projection());
  }

  private load(): boolean {
    if (!existsSync(this.options.registryFile)) return false;
    try {
      const parsed = JSON.parse(
        readFileSync(this.options.registryFile, 'utf8')
      ) as PersistedAuthority;
      if (
        parsed.migrationVersion !== 1 ||
        !Array.isArray(parsed.projects) ||
        !Array.isArray(parsed.conversations)
      )
        return false;
      for (const project of parsed.projects) {
        if (validId(project.projectId) && typeof project.canonicalPath === 'string')
          this.projects.set(project.projectId, project);
      }
      for (const conversation of parsed.conversations) {
        if (
          validId(conversation.conversationId) &&
          this.projects.has(conversation.projectId) &&
          conversation.kind === 'root'
        ) {
          this.conversations.set(conversation.conversationId, conversation);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private migrateLegacy(settings: Record<string, unknown> | null | undefined): void {
    const state = record(record(settings?.['enso-settings'])?.state);
    const projects = Array.isArray(state?.projects) ? state.projects : [];
    for (const raw of projects) {
      const project = record(raw);
      if (!validId(project?.id) || typeof project?.path !== 'string') continue;
      try {
        const canonicalPath = realpathSync(project.path);
        if (!statSync(canonicalPath).isDirectory()) continue;
        this.projects.set(project.id, {
          projectId: project.id,
          canonicalPath,
          state: 'active',
          version: 1,
        });
      } catch {}
    }
    const conversationState = record(record(settings?.['enso-conversations'])?.state);
    const conversations = record(conversationState?.conversations);
    if (conversations) {
      for (const [conversationId, raw] of Object.entries(conversations)) {
        const conversation = record(raw);
        if (
          !validId(conversationId) ||
          conversation?.parentId ||
          !validId(conversation?.projectId) ||
          !this.projects.has(conversation.projectId)
        )
          continue;
        const sessionFile = this.validLegacySessionFile(conversation.sessionFile);
        const providerId =
          typeof conversation.lastProviderId === 'string' ? conversation.lastProviderId : undefined;
        const modelId =
          typeof conversation.lastModelId === 'string' ? conversation.lastModelId : undefined;
        this.conversations.set(conversationId, {
          conversationId,
          projectId: conversation.projectId,
          kind: 'root',
          lifecycle: sessionFile ? 'ready' : 'draft',
          version: 1,
          ...(sessionFile ? { sessionFile } : {}),
          ...(providerId && modelId ? { selection: { providerId, modelId, revision: 1 } } : {}),
        });
      }
    }
    this.commit();
  }

  private validLegacySessionFile(value: unknown): string | undefined {
    if (typeof value !== 'string' || !this.options.safeSessionRoot) return undefined;
    try {
      const root = realpathSync(this.options.safeSessionRoot);
      const file = realpathSync(value);
      return file.startsWith(`${root}${path.sep}`) && statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  }
}
