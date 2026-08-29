import { type AgentTypeCandidate, parseAgentTypeRegistrySnapshot } from '@shared/builtinAgents';
import type {
  AgentTypeMentionCandidate,
  FileMentionCandidate,
  MentionCandidate,
} from '@shared/types/mentions';
import { useEffect, useMemo, useState } from 'react';

export interface MentionSearchGroups {
  agents: AgentTypeMentionCandidate[];
  files: FileMentionCandidate[];
}

export interface MentionPickerItem {
  candidate: MentionCandidate;
  group: 'agents' | 'files';
}

export function flattenMentionGroups(groups: MentionSearchGroups): MentionPickerItem[] {
  return [
    ...groups.agents.map((candidate) => ({ candidate, group: 'agents' as const })),
    ...groups.files.map((candidate) => ({ candidate, group: 'files' as const })),
  ];
}

interface FileHit {
  relativePath: string;
  name: string;
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
  files: readonly FileMentionCandidate[]
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
  return { agents: matchingAgents, files: matchingFiles };
}

/** Agent candidates come from Main's registry snapshot; file search remains cwd-bound. */
export function useMentionSearch(
  cwd: string | undefined,
  query: string | null
): MentionSearchGroups {
  const [agents, setAgents] = useState<AgentTypeMentionCandidate[]>([]);
  const [files, setFiles] = useState<FileMentionCandidate[]>([]);
  const pickerOpen = query !== null;

  useEffect(() => {
    if (!pickerOpen) return;
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
  }, [pickerOpen]);

  useEffect(() => {
    if (query === null || !cwd) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.electronAPI.files
        .search(cwd, query)
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
  }, [cwd, query]);

  return useMemo(
    () =>
      query === null ? { agents: [], files: [] } : groupMentionCandidates(query, agents, files),
    [agents, files, query]
  );
}
