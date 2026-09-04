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
import { resolveSshTarget } from '@shared/ssh';
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
  resolveSshConnection?: (id: string) => { host: string; user?: string; name?: string } | null;
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

function projectIdentity(
  project: Pick<ProjectAuthority, 'kind' | 'canonicalPath' | 'sshConnectionId'>
): string {
  return project.kind === 'ssh'
    ? `ssh:${project.sshConnectionId}:${project.canonicalPath}`
    : `local:${project.canonicalPath}`;
}

function normalizeStoredProject(project: ProjectAuthority): { canonicalPath: string } {
  if (project.kind === 'ssh') {
    const canonicalPath = normalizeRemoteProjectPath(project.canonicalPath);
    return { canonicalPath: canonicalPath ?? project.canonicalPath };
  }
  try {
    const canonicalPath = realpathSync(project.canonicalPath);
    if (!statSync(canonicalPath).isDirectory()) return { canonicalPath: project.canonicalPath };
    return { canonicalPath };
  } catch {
    return { canonicalPath: project.canonicalPath };
  }
}

export class SourceAuthorityRegistry {
  private readonly projects = new Map<string, ProjectAuthority>();
  private readonly conversations = new Map<string, ConversationAuthority>();
  private readonly randomUuid: () => string;

  constructor(private readonly options: SourceAuthorityRegistryOptions) {
    this.randomUuid = options.randomUuid ?? randomUUID;
    if (!this.load()) this.migrateLegacy(options.legacySettings?.());
    if (this.normalizeLoadedProjects()) this.commit();
  }

  private hydrateProject(value: ProjectAuthority): ProjectAuthority {
    if (value.kind !== 'ssh' || !value.sshConnectionId) return { ...value };
    const connection = this.options.resolveSshConnection?.(value.sshConnectionId);
    if (!connection) return { ...value };
    return {
      ...value,
      sshHost: resolveSshTarget(connection),
      ...(connection.name ? { sshConnectionName: connection.name } : {}),
    };
  }

  projection(): SourceAuthorityProjection {
    return {
      projects: [...this.projects.values()].map((value) => this.hydrateProject(value)),
      conversations: [...this.conversations.values()].map((value) => ({
        ...value,
        ...(value.selection ? { selection: { ...value.selection } } : {}),
      })),
    };
  }

  project(projectId: string): ProjectAuthority | undefined {
    const value = this.projects.get(projectId);
    return value ? this.hydrateProject(value) : undefined;
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
    const existing = this.findActiveByIdentity(`local:${canonicalPath}`);
    if (existing) return { accepted: true, value: { ...existing } };
    return this.insertProject({
      projectId: this.randomUuid(),
      canonicalPath,
      state: 'active',
      version: 1,
    });
  }

  /** 远端目录存在性由 IPC handler 先行 ssh 校验（registry 保持同步契约），这里只做路径规范化与去重 */
  private createSshProject(
    request: CreateProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    const connectionId = request.sshConnectionId;
    if (typeof connectionId !== 'string' || connectionId.length === 0) {
      return { accepted: false, error: 'Remote project requires an SSH connection.' };
    }
    const connection = this.options.resolveSshConnection?.(connectionId);
    if (!connection) return { accepted: false, error: 'SSH 连接不存在。' };
    const sshHost = resolveSshTarget(connection);
    const canonicalPath = normalizeRemoteProjectPath(request.path);
    if (!canonicalPath) return { accepted: false, error: 'Remote project path must be absolute.' };
    const existing = this.findActiveByIdentity(`ssh:${connectionId}:${canonicalPath}`);
    if (existing) return { accepted: true, value: this.hydrateProject(existing) };
    return this.insertProject({
      projectId: this.randomUuid(),
      canonicalPath,
      kind: 'ssh',
      sshHost,
      sshConnectionId: connectionId,
      state: 'active',
      version: 1,
    });
  }

  notifyProjection(): void {
    this.options.onChanged?.(this.projection());
  }

  sshConnectionInUse(connectionId: string): boolean {
    return [...this.projects.values()].some(
      (project) =>
        project.state === 'active' &&
        project.kind === 'ssh' &&
        project.sshConnectionId === connectionId
    );
  }

  private insertProject(
    value: ProjectAuthority
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    this.projects.set(value.projectId, value);
    this.commit();
    return { accepted: true, value: this.hydrateProject(value) };
  }

  selectProject(
    request: SelectProjectAuthorityRequest
  ): AuthorityMutationResult<ProjectAuthorityProjection> {
    const project = this.projects.get(request.projectId);
    return project && project.state === 'active' && project.version === request.version
      ? { accepted: true, value: this.hydrateProject(project) }
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
      ...(request.forkedFrom ? { forkedFrom: { ...request.forkedFrom } } : {}),
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

  markReady(
    conversationId: string,
    sessionFile: string,
    model: ModelRef,
    forkedFrom?: ConversationAuthority['forkedFrom']
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.lifecycle === 'ended') return;
    conversation.lifecycle = 'ready';
    conversation.sessionFile = sessionFile;
    if (forkedFrom) conversation.forkedFrom = { ...forkedFrom };
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
    return {
      ...value,
      ...(value.selection ? { selection: { ...value.selection } } : {}),
      ...(value.forkedFrom ? { forkedFrom: { ...value.forkedFrom } } : {}),
    };
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

  private findActiveByIdentity(identity: string): ProjectAuthority | undefined {
    return [...this.projects.values()].find(
      (project) => project.state === 'active' && projectIdentity(project) === identity
    );
  }

  /** 把磁盘/遗留数据折成当前身份：规范化路径，同身份只留最早一条，会话并过去。 */
  private normalizeLoadedProjects(): boolean {
    let changed = false;
    const keepers = new Map<string, ProjectAuthority>();
    const remap = new Map<string, string>();
    for (const project of this.projects.values()) {
      const normalized = normalizeStoredProject(project);
      if (normalized.canonicalPath !== project.canonicalPath) {
        project.canonicalPath = normalized.canonicalPath;
        changed = true;
      }
      if (project.state !== 'active') continue;
      const identity = projectIdentity(project);
      const keeper = keepers.get(identity);
      if (!keeper) {
        keepers.set(identity, project);
        continue;
      }
      project.state = 'removed';
      project.version += 1;
      remap.set(project.projectId, keeper.projectId);
      changed = true;
    }
    for (const conversation of this.conversations.values()) {
      const nextProjectId = remap.get(conversation.projectId);
      if (!nextProjectId) continue;
      conversation.projectId = nextProjectId;
      conversation.version += 1;
      changed = true;
    }
    return changed;
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
    const remap = new Map<string, string>();
    for (const raw of projects) {
      const project = record(raw);
      if (!validId(project?.id) || typeof project?.path !== 'string') continue;
      try {
        const canonicalPath = realpathSync(project.path);
        if (!statSync(canonicalPath).isDirectory()) continue;
        const existing = [...this.projects.values()].find(
          (candidate) =>
            candidate.state === 'active' &&
            candidate.kind !== 'ssh' &&
            candidate.canonicalPath === canonicalPath
        );
        if (existing) {
          if (existing.projectId !== project.id) remap.set(project.id, existing.projectId);
          continue;
        }
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
        const projectId =
          typeof conversation?.projectId === 'string'
            ? (remap.get(conversation.projectId) ?? conversation.projectId)
            : undefined;
        if (
          !conversation ||
          !validId(conversationId) ||
          conversation.parentId ||
          !validId(projectId) ||
          !this.projects.has(projectId)
        )
          continue;
        const sessionFile = this.validLegacySessionFile(conversation.sessionFile);
        const providerId =
          typeof conversation.lastProviderId === 'string' ? conversation.lastProviderId : undefined;
        const modelId =
          typeof conversation.lastModelId === 'string' ? conversation.lastModelId : undefined;
        this.conversations.set(conversationId, {
          conversationId,
          projectId,
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
