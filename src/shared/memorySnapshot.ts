export type MemoryPhaseStatus = 'idle' | 'running' | 'done';

export type MemorySnapshot = {
  cwd: string;
  root: string;
  rootExists: boolean;
  summary: string;
  learned: string[];
  files: number;
  bytes: number;
  stage1Total: number;
  stage1Done: number;
  watermark: number;
  dirty: boolean;
  phase2Status: MemoryPhaseStatus;
  hasMemoryMd: boolean;
  notice?: string;
};

export function parseLearnedLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean);
}
