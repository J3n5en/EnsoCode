import { type AgentTypeCandidate, parseAgentTypeRegistrySnapshot } from '@shared/builtinAgents';
import type {
  AgentTypeMentionCandidate,
  ChatMentionCandidate,
  FileMentionCandidate,
  MentionCandidate,
} from '@shared/types/mentions';
import { useEffect, useMemo, useState } from 'react';

export interface MentionSearchGroups {
  agents: AgentTypeMentionCandidate[];
  /** Bot 模式成员（source = bot），与 agent 类型分组展示 */
  members: AgentTypeMentionCandidate[];
  files: FileMentionCandidate[];
  chats: ChatMentionCandidate[];
}

export type MentionFolderId = 'agents' | 'members' | 'chats';

export interface MentionPickerItem {
  candidate: MentionCandidate;
  group: MentionFolderId | 'files';
}

export type MentionRootItem =
  | { type: 'folder'; id: MentionFolderId }
  | { type: 'item'; candidate: MentionCandidate; group: MentionFolderId | 'files' };

const FOLDER_IDS: readonly MentionFolderId[] = ['agents', 'members', 'chats'];

export function flattenMentionGroups(groups: MentionSearchGroups): MentionPickerItem[] {
  return [
    ...FOLDER_IDS.flatMap((group) => groups[group].map((candidate) => ({ candidate, group }))),
    ...groups.files.map((candidate) => ({ candidate, group: 'files' as const })),
  ];
}

/** 空查询把 Agents/成员/Chats 各收成一级文件夹；有关键词时摊平，保证 @enso 仍能直接命中。 */
export function flattenMentionRoot(groups: MentionSearchGroups, query: string): MentionRootItem[] {
  const folders = FOLDER_IDS.filter((id) => groups[id].length > 0);
  if (!query.trim() && folders.length > 0) {
    return [
      ...folders.map((id) => ({ type: 'folder' as const, id })),
      ...groups.files.map((candidate) => ({
        type: 'item' as const,
        candidate,
        group: 'files' as const,
      })),
    ];
  }
  return flattenMentionGroups(groups).map((item) => ({
    type: 'item' as const,
    candidate: item.candidate,
    group: item.group,
  }));
}

export interface FileHit {
  relativePath: string;
  name: string;
}

/** toChatMentionCandidates 只依赖这几个字段，避免耦合 sessions store 的完整 Conversation 形状。 */
interface ChatCandidateSource {
  id: string;
  title: string;
  projectId: string;
  parentId?: string;
  sessionFile?: string;
  createdAt: number;
}

const MAX_CHAT_CANDIDATES = 20;

/** root 会话且有 jsonl 可读才成候选（跨项目收录）；排除当前会话，
 * 同项目优先排前、组内 createdAt 倒序，取前 20。 */
export function toChatMentionCandidates(
  conversations: readonly ChatCandidateSource[],
  projectId: string,
  currentId: string | undefined
): ChatMentionCandidate[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.id !== currentId && !conversation.parentId && !!conversation.sessionFile
    )
    .sort((left, right) => {
      const sameLeft = left.projectId === projectId ? 0 : 1;
      const sameRight = right.projectId === projectId ? 0 : 1;
      if (sameLeft !== sameRight) return sameLeft - sameRight;
      return right.createdAt - left.createdAt;
    })
    .slice(0, MAX_CHAT_CANDIDATES)
    .map((conversation) => ({
      kind: 'chat' as const,
      id: conversation.id,
      // 旧数据的标题可能被追加引用块污染过（含换行）：取首行，
      // 否则拼进 chat 引用行会破坏单行格式、渲染侧解不回 chip
      label: conversation.title.split('\n')[0].trim() || 'Untitled chat',
      sessionFile: conversation.sessionFile as string,
    }));
}

export function toAgentMentionCandidates(
  candidates: readonly AgentTypeCandidate[]
): AgentTypeMentionCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    kind: 'agent-type',
    id: candidate.typeKey,
    label: candidate.displayName,
  }));
}

export function toFileMentionCandidates(hits: readonly FileHit[]): FileMentionCandidate[] {
  const seen = new Set<string>();
  const candidates: FileMentionCandidate[] = [];
  for (const hit of hits) {
    if (!hit.relativePath || seen.has(hit.relativePath)) continue;
    seen.add(hit.relativePath);
    candidates.push({
      kind: 'file',
      id: hit.relativePath,
      label: hit.name || hit.relativePath.split('/').at(-1) || hit.relativePath,
      relativePath: hit.relativePath,
    });
  }
  return candidates;
}

export function groupMentionCandidates(
  query: string,
  agents: readonly AgentTypeMentionCandidate[],
  files: readonly FileMentionCandidate[],
  chats: readonly ChatMentionCandidate[] = []
): MentionSearchGroups {
  const normalized = query.trim().toLocaleLowerCase();
  const matchingAgents = normalized
    ? agents.filter((candidate) =>
        `${candidate.label}\n${candidate.description}\n${candidate.source}\n${candidate.typeKey}`
          .toLocaleLowerCase()
          .includes(normalized)
      )
    : [...agents];
  const matchingFiles = normalized
    ? files.filter((candidate) =>
        `${candidate.label}\n${candidate.relativePath}`.toLocaleLowerCase().includes(normalized)
      )
    : [...files];
  const matchingChats = normalized
    ? chats.filter((candidate) => candidate.label.toLocaleLowerCase().includes(normalized))
    : [...chats];
  return {
    agents: matchingAgents.filter((candidate) => candidate.source !== 'bot'),
    members: matchingAgents.filter((candidate) => candidate.source === 'bot'),
    files: matchingFiles,
    chats: matchingChats,
  };
}

export interface MentionSearchOptions {
  /** 替代按 cwd 搜索（Bot 输入框：Main 按 chatId 推导根目录）；须是稳定引用 */
  searchFiles?: (query: string) => Promise<readonly FileHit[]>;
  /** false = 不拉 agent 类型候选 */
  agents?: boolean;
}

/** Agent candidates come from Main's registry snapshot; file search remains cwd-bound. */
export function useMentionSearch(
  cwd: string | undefined,
  query: string | null,
  chats: readonly ChatMentionCandidate[] = [],
  options: MentionSearchOptions = {}
): MentionSearchGroups {
  const [agents, setAgents] = useState<AgentTypeMentionCandidate[]>([]);
  const [files, setFiles] = useState<FileMentionCandidate[]>([]);
  const pickerOpen = query !== null;
  const { searchFiles, agents: withAgents = true } = options;

  useEffect(() => {
    if (!pickerOpen || !withAgents) return;
    setAgents([]);
    let cancelled = false;
    void window.electronAPI.agentRegistry
      .list()
      .then((value) => {
        const snapshot = parseAgentTypeRegistrySnapshot(value);
        if (!cancelled) {
          setAgents(snapshot ? toAgentMentionCandidates(snapshot.candidates) : []);
        }
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, withAgents]);

  useEffect(() => {
    if (query === null || (!cwd && !searchFiles)) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      (searchFiles ? searchFiles(query) : window.electronAPI.files.search(cwd as string, query))
        .then((hits) => {
          if (!cancelled) setFiles(toFileMentionCandidates(hits));
        })
        .catch(() => {
          if (!cancelled) setFiles([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cwd, query, searchFiles]);

  return useMemo(
    () =>
      query === null
        ? { agents: [], members: [], files: [], chats: [] }
        : groupMentionCandidates(query, agents, files, chats),
    [agents, files, chats, query]
  );
}
