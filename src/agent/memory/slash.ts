import { existsSync, rmSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryCommandAction, MemorySavePatch } from '@shared/memoryCommand';
import { type MemorySnapshot, parseLearnedLines } from '@shared/memorySnapshot';
import { getMemoryRoot, readLearnedLessons } from '../localMemory';
import { enqueuePhase2, loadJobs, saveJobs } from './jobs';
import { neutralizeInjection, redactSecrets } from './sanitize';

export type MemorySlashResult =
  | { ok: true; snapshot: MemorySnapshot }
  | { ok: false; error: string };

async function dirSize(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  if (existsSync(root)) await walk(root);
  return { files, bytes };
}

async function readSummary(root: string): Promise<string> {
  try {
    return (await readFile(path.join(root, 'memory_summary.md'), 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function loadMemorySnapshot(
  agentDir: string,
  cwd: string,
  notice?: string
): Promise<MemorySnapshot> {
  const root = getMemoryRoot(agentDir, cwd);
  const [jobs, size, summary, learnedRaw] = await Promise.all([
    loadJobs(root),
    dirSize(root),
    readSummary(root),
    readLearnedLessons(root),
  ]);
  const stage1 = Object.values(jobs.stage1);
  return {
    cwd,
    root,
    rootExists: existsSync(root),
    summary,
    learned: parseLearnedLines(learnedRaw),
    files: size.files,
    bytes: size.bytes,
    stage1Total: stage1.length,
    stage1Done: stage1.filter((job) => job.status === 'done').length,
    watermark: jobs.global.watermark,
    dirty: jobs.global.dirty === true,
    phase2Status: jobs.global.status ?? 'idle',
    hasMemoryMd: existsSync(path.join(root, 'MEMORY.md')),
    ...(notice ? { notice } : {}),
  };
}

async function saveMemoryPatch(root: string, patch: MemorySavePatch): Promise<void> {
  await mkdir(root, { recursive: true });
  const summary = redactSecrets(patch.summary).trim();
  await writeFile(path.join(root, 'memory_summary.md'), summary ? `${summary}\n` : '', 'utf8');
  const lessons = patch.learned
    .map((line) => neutralizeInjection(redactSecrets(line)))
    .filter(Boolean)
    .slice(0, 100);
  const body = lessons.map((line) => `- ${line}`).join('\n');
  await writeFile(path.join(root, 'learned.md'), body ? `${body}\n` : '', 'utf8');
}

export async function runMemorySlash(opts: {
  action: MemoryCommandAction;
  agentDir: string;
  cwd: string;
  localMemoryEnabled: boolean;
  remote?: boolean;
  patch?: MemorySavePatch;
}): Promise<MemorySlashResult> {
  if (!opts.localMemoryEnabled) {
    return { ok: false, error: 'Project memory is disabled in Settings.' };
  }
  if (opts.remote) {
    return { ok: false, error: 'Project memory is local-only.' };
  }
  const root = getMemoryRoot(opts.agentDir, opts.cwd);
  if (opts.action === 'clear') {
    rmSync(root, { recursive: true, force: true });
    return {
      ok: true,
      snapshot: await loadMemorySnapshot(opts.agentDir, opts.cwd, 'Memory data cleared.'),
    };
  }
  if (opts.action === 'save') {
    if (!opts.patch) return { ok: false, error: 'memory save needs a patch' };
    await saveMemoryPatch(root, opts.patch);
    return {
      ok: true,
      snapshot: await loadMemorySnapshot(opts.agentDir, opts.cwd, 'Memory updated.'),
    };
  }
  if (opts.action === 'enqueue') {
    await saveJobs(root, enqueuePhase2(await loadJobs(root)));
    return {
      ok: true,
      snapshot: await loadMemorySnapshot(
        opts.agentDir,
        opts.cwd,
        'Queued for the next parent spawn.'
      ),
    };
  }
  return { ok: true, snapshot: await loadMemorySnapshot(opts.agentDir, opts.cwd) };
}
