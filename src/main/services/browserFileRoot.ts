import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowedUrl } from '@shared/browser/urlPolicy';

export function pickBrowserFileRoot(input: {
  conversation?: { projectId: string; lifecycle: string };
  project?: { projectId: string; state: string; kind?: string; canonicalPath: string };
  worktree?: { projectId: string; path: string };
}): string | null {
  const { conversation, project, worktree } = input;
  if (
    !conversation ||
    conversation.lifecycle === 'ended' ||
    project?.state !== 'active' ||
    (project.kind !== undefined && project.kind !== 'local') ||
    conversation.projectId !== project.projectId
  )
    return null;
  if (worktree && worktree.projectId !== project.projectId) return null;
  return worktree?.path ?? project.canonicalPath;
}

let resolveRoot: (conversationId: string) => string | null = () => null;

export function setBrowserFileRootResolver(resolver: typeof resolveRoot): void {
  resolveRoot = resolver;
}

export function resolveLocalCwdForBrowser(conversationId: string): string | null {
  return resolveRoot(conversationId);
}

/** Shared policy is lexical only; every privileged file request must pass realpath too. */
export function assertBrowserUrl(raw: string, fileRoot?: string): URL {
  const url = assertAllowedUrl(raw, { fileRoot });
  if (url.protocol !== 'file:') return url;
  try {
    const root = realpathSync(fileRoot as string);
    const target = realpathSync(fileURLToPath(url));
    const rel = relative(root, target);
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !statSync(target).isFile()
    ) {
      throw new Error('Outside workspace');
    }
  } catch {
    throw new Error('Security restriction: file URL is not an existing workspace file.');
  }
  return url;
}
