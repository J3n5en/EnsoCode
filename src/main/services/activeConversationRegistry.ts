import { randomUUID } from 'node:crypto';
import type { SessionIdentity } from '@shared/builtinAgents';
import type { ModelRef } from '@shared/types/agent';
import type {
  MainModelSelectionBinding,
  MainModelSelectionBindingResult,
  ModelSelectionSource,
  ParentModelSelectionRequest,
  ParentSourceBindingRequest,
  ParentSourceBindingResult,
} from '@shared/types/mentions';
import type { AgentSessionIndex } from './agentSessionIndex';
import type { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

export interface ResolvedParentSource {
  parentConversationId: string;
  parentProjectId: string;
  parentProjectPath: string;
  selectedModel: ModelRef;
}

export interface ParentSourceBinding {
  parentBindingId: string;
  ownerWebContentsId: number;
  parentConversationId: string;
  parentProjectId: string;
  parentProjectPath: string;
  conversationVersion: number;
  projectVersion: number;
  parentIdentity?: SessionIdentity;
  issuedAt: number;
  expiresAt: number;
}

interface StoredSelectionBinding extends MainModelSelectionBinding {
  ownerWebContentsId: number;
  conversationVersion: number;
  expiresAt: number;
}

export interface ActiveConversationRegistryOptions {
  authority: SourceAuthorityRegistry;
  sessionIndex: AgentSessionIndex;
  isMainWebContents: (webContentsId: number) => boolean;
  now?: () => number;
  resolveDefaultModel?: () => ModelRef | null;
  randomUuid?: () => string;
  bindingTtlMs?: number;
}

export class ActiveConversationRegistry {
  private readonly selectedByWebContents = new Map<number, string>();
  private readonly parentBindings = new Map<string, ParentSourceBinding>();
  private readonly selectionBindings = new Map<string, StoredSelectionBinding>();
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly bindingTtlMs: number;

  constructor(private readonly options: ActiveConversationRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.bindingTtlMs = options.bindingTtlMs ?? 30_000;
  }

  selectConversation(ownerWebContentsId: number, conversationId: string): boolean {
    if (!this.options.isMainWebContents(ownerWebContentsId)) return false;
    const source = this.resolveAuthority(conversationId);
    if (!source) return false;
    this.invalidateOwner(ownerWebContentsId);
    this.selectedByWebContents.set(ownerWebContentsId, conversationId);
    return true;
  }

  bindSource(
    ownerWebContentsId: number,
    request: ParentSourceBindingRequest
  ): ParentSourceBindingResult {
    if (!this.options.isMainWebContents(ownerWebContentsId)) {
      return {
        accepted: false,
        requestId: request.requestId,
        error: 'Only MainWindow can bind a dispatch source.',
      };
    }
    const conversationId = this.selectedByWebContents.get(ownerWebContentsId);
    const source = conversationId ? this.resolveAuthority(conversationId) : null;
    if (!source) {
      return {
        accepted: false,
        requestId: request.requestId,
        error: 'No active conversation source is selected.',
      };
    }
    const issuedAt = this.now();
    const currentIdentity = this.options.sessionIndex.currentIdentity(source.parentConversationId);
    const binding: ParentSourceBinding = {
      parentBindingId: this.randomUuid(),
      ownerWebContentsId,
      parentConversationId: source.parentConversationId,
      parentProjectId: source.parentProjectId,
      parentProjectPath: source.parentProjectPath,
      conversationVersion: source.conversationVersion,
      projectVersion: source.projectVersion,
      ...(currentIdentity ? { parentIdentity: currentIdentity } : {}),
      issuedAt,
      expiresAt: issuedAt + this.bindingTtlMs,
    };
    this.parentBindings.set(binding.parentBindingId, binding);
    return {
      accepted: true,
      requestId: request.requestId,
      parentBindingId: binding.parentBindingId,
      expiresAt: binding.expiresAt,
    };
  }

  registerModelSelection(
    ownerWebContentsId: number,
    request: ParentModelSelectionRequest,
    validated: boolean
  ): MainModelSelectionBindingResult {
    const parent = this.parentBindings.get(request.parentBindingId);
    const authority = parent
      ? this.options.authority.conversation(parent.parentConversationId)
      : undefined;
    const actualIdentity = parent
      ? this.options.sessionIndex.currentIdentity(parent.parentConversationId)
      : undefined;
    const actualModel = actualIdentity
      ? this.options.sessionIndex.model(actualIdentity)
      : undefined;
    if (
      !validated ||
      !parent ||
      parent.ownerWebContentsId !== ownerWebContentsId ||
      !authority ||
      authority.version !== parent.conversationVersion ||
      parent.expiresAt <= this.now()
    ) {
      return { accepted: false, error: 'Parent binding or model selection is unavailable.' };
    }
    let source: ModelSelectionSource;
    let mainRevision: number;
    if (actualModel) {
      if (
        actualModel.providerId !== request.selection.providerId ||
        actualModel.modelId !== request.selection.modelId
      ) {
        return {
          accepted: false,
          error: 'Started parent model does not match the current selection.',
        };
      }
      source = 'started-session';
      mainRevision = authority.selection?.revision ?? 1;
    } else if (authority.selection) {
      if (
        authority.selection.providerId !== request.selection.providerId ||
        authority.selection.modelId !== request.selection.modelId
      ) {
        return { accepted: false, error: 'Draft selection is stale.' };
      }
      source = authority.lifecycle === 'draft' ? 'draft-selection' : 'legacy';
      mainRevision = authority.selection.revision;
    } else {
      const defaultModel = this.options.resolveDefaultModel?.() ?? null;
      if (
        !defaultModel ||
        defaultModel.providerId !== request.selection.providerId ||
        defaultModel.modelId !== request.selection.modelId
      ) {
        return { accepted: false, error: 'Selection does not match the Main default model.' };
      }
      source = 'default';
      mainRevision = 1;
    }
    const issuedAt = this.now();
    const binding: StoredSelectionBinding = {
      selectionBindingId: this.randomUuid(),
      parentBindingId: parent.parentBindingId,
      providerId: request.selection.providerId,
      modelId: request.selection.modelId,
      mainRevision,
      source,
      issuedAt,
      ownerWebContentsId,
      conversationVersion: authority.version,
      expiresAt: parent.expiresAt,
    };
    this.selectionBindings.set(binding.selectionBindingId, binding);
    return { accepted: true, binding: this.publicSelection(binding) };
  }

  consumeSelection(
    selectionBindingId: string,
    ownerWebContentsId: number
  ): (ParentSourceBinding & { selectedModel: ModelRef; mainRevision: number }) | null {
    const selection = this.selectionBindings.get(selectionBindingId);
    this.selectionBindings.delete(selectionBindingId);
    if (
      !selection ||
      selection.ownerWebContentsId !== ownerWebContentsId ||
      selection.expiresAt <= this.now()
    )
      return null;
    const parent = this.parentBindings.get(selection.parentBindingId);
    this.parentBindings.delete(selection.parentBindingId);
    if (
      !parent ||
      parent.ownerWebContentsId !== ownerWebContentsId ||
      parent.expiresAt <= this.now()
    )
      return null;
    const current = this.resolveAuthority(parent.parentConversationId);
    if (
      !current ||
      current.conversationVersion !== parent.conversationVersion ||
      current.projectVersion !== parent.projectVersion
    )
      return null;
    const actualIdentity = this.options.sessionIndex.currentIdentity(parent.parentConversationId);
    if (
      parent.parentIdentity &&
      (!actualIdentity || actualIdentity.generation !== parent.parentIdentity.generation)
    )
      return null;
    const authority = this.options.authority.conversation(parent.parentConversationId);
    const revision = authority?.selection?.revision ?? selection.mainRevision;
    if (revision !== selection.mainRevision) return null;
    return {
      ...parent,
      selectedModel: { providerId: selection.providerId, modelId: selection.modelId },
      mainRevision: selection.mainRevision,
      ...(actualIdentity ? { parentIdentity: actualIdentity } : {}),
    };
  }

  invalidateOwner(ownerWebContentsId: number): void {
    this.selectedByWebContents.delete(ownerWebContentsId);
    for (const [id, value] of this.parentBindings)
      if (value.ownerWebContentsId === ownerWebContentsId) this.parentBindings.delete(id);
    for (const [id, value] of this.selectionBindings)
      if (value.ownerWebContentsId === ownerWebContentsId) this.selectionBindings.delete(id);
  }

  invalidateBindingsForConversation(conversationId: string): void {
    const parentBindingIds = new Set<string>();
    for (const [id, value] of this.parentBindings) {
      if (value.parentConversationId === conversationId) {
        parentBindingIds.add(id);
        this.parentBindings.delete(id);
      }
    }
    for (const [id, value] of this.selectionBindings) {
      if (parentBindingIds.has(value.parentBindingId)) this.selectionBindings.delete(id);
    }
  }

  invalidateConversation(conversationId: string): void {
    for (const [owner, selected] of this.selectedByWebContents)
      if (selected === conversationId) this.invalidateOwner(owner);
    for (const [id, value] of this.parentBindings)
      if (value.parentConversationId === conversationId) this.parentBindings.delete(id);
  }

  resolveParentSource(conversationId: string): ResolvedParentSource | null {
    const source = this.resolveAuthority(conversationId);
    if (!source) return null;
    const identity = this.options.sessionIndex.currentIdentity(conversationId);
    const model = identity ? this.options.sessionIndex.model(identity) : undefined;
    const authority = this.options.authority.conversation(conversationId);
    const selection = model ?? authority?.selection;
    return selection
      ? {
          parentConversationId: conversationId,
          parentProjectId: source.parentProjectId,
          parentProjectPath: source.parentProjectPath,
          selectedModel: { providerId: selection.providerId, modelId: selection.modelId },
        }
      : null;
  }

  private resolveAuthority(conversationId: string): {
    parentConversationId: string;
    parentProjectId: string;
    parentProjectPath: string;
    conversationVersion: number;
    projectVersion: number;
  } | null {
    const conversation = this.options.authority.conversation(conversationId);
    if (conversation?.kind !== 'root' || conversation.lifecycle === 'ended') return null;
    const project = this.options.authority.project(conversation.projectId);
    if (project?.state !== 'active') return null;
    return {
      parentConversationId: conversation.conversationId,
      parentProjectId: project.projectId,
      parentProjectPath: project.canonicalPath,
      conversationVersion: conversation.version,
      projectVersion: project.version,
    };
  }

  private publicSelection(binding: StoredSelectionBinding): MainModelSelectionBinding {
    return {
      selectionBindingId: binding.selectionBindingId,
      parentBindingId: binding.parentBindingId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      mainRevision: binding.mainRevision,
      source: binding.source,
      issuedAt: binding.issuedAt,
    };
  }
}
