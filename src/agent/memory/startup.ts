import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getMemoryRoot, readLearnedLessons } from '../localMemory';
import { buildMemoryGuidance } from './guidance';

export function shouldRunMemoryStartup(opts: {
  localMemoryEnabled: boolean;
  remote?: boolean;
  coworker?: boolean;
  child?: boolean;
}): boolean {
  return Boolean(opts.localMemoryEnabled && !opts.remote && !opts.coworker && !opts.child);
}

export async function loadSessionMemoryInjection(
  agentDir: string,
  cwd: string
): Promise<{ path: string; content: string }> {
  const root = getMemoryRoot(agentDir, cwd);
  let summary = '';
  try {
    summary = (await readFile(path.join(root, 'memory_summary.md'), 'utf8')).trim();
  } catch {
    summary = '';
  }
  const learned = await readLearnedLessons(root);
  return {
    path: path.join(root, 'GUIDANCE.md'),
    content: buildMemoryGuidance({
      ...(summary ? { summary } : {}),
      ...(learned ? { learned } : {}),
    }),
  };
}
