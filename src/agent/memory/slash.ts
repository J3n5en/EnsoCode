import { existsSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryCommandAction } from '@shared/memoryCommand';
import { getMemoryRoot } from '../localMemory';
import { enqueuePhase2, loadJobs, saveJobs } from './jobs';
import { loadSessionMemoryInjection } from './startup';

export type MemorySlashResult = { ok: true; text: string } | { ok: false; error: string };

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

export async function runMemorySlash(opts: {
  action: MemoryCommandAction;
  agentDir: string;
  cwd: string;
  localMemoryEnabled: boolean;
  remote?: boolean;
}): Promise<MemorySlashResult> {
  if (!opts.localMemoryEnabled) {
    return { ok: false, error: 'Project memory is disabled in Settings.' };
  }
  if (opts.remote) {
    return { ok: false, error: 'Project memory slash commands are local-only.' };
  }
  const root = getMemoryRoot(opts.agentDir, opts.cwd);
  if (opts.action === 'view') {
    const injection = await loadSessionMemoryInjection(opts.agentDir, opts.cwd);
    return { ok: true, text: injection.content };
  }
  if (opts.action === 'stats') {
    const jobs = await loadJobs(root);
    const size = await dirSize(root);
    const stage1 = Object.values(jobs.stage1);
    const text = [
      `Memory root: ${root}`,
      `Files: ${size.files} (${size.bytes} bytes)`,
      `Stage 1 jobs: ${stage1.length} (${stage1.filter((j) => j.status === 'done').length} done)`,
      `Phase 2 watermark: ${jobs.global.watermark}${jobs.global.dirty ? ' (enqueue pending)' : ''}`,
      `MEMORY.md: ${existsSync(path.join(root, 'MEMORY.md')) ? 'present' : 'missing'}`,
      `learned.md: ${existsSync(path.join(root, 'learned.md')) ? 'present' : 'missing'}`,
    ].join('\n');
    return { ok: true, text };
  }
  if (opts.action === 'diagnose') {
    const jobs = await loadJobs(root);
    const text = [
      `enabled: true`,
      `cwd: ${opts.cwd}`,
      `root exists: ${existsSync(root)}`,
      `global.status: ${jobs.global.status ?? 'idle'}`,
      `global.dirty: ${jobs.global.dirty === true}`,
    ].join('\n');
    return { ok: true, text };
  }
  if (opts.action === 'clear') {
    rmSync(root, { recursive: true, force: true });
    return { ok: true, text: 'Memory data cleared. Next spawn will start with an empty payload.' };
  }
  const jobs = await loadJobs(root);
  await saveJobs(root, enqueuePhase2(jobs));
  return { ok: true, text: 'Memory consolidation enqueued for the next parent spawn.' };
}
