import { spawn } from 'node:child_process';

export interface CommandGuardHit {
  ruleId: string;
  reason: string;
}

/** 命令守卫：命中返回规则与原因；出错 / 超时 / 不适用一律 null（fail-open，交回原审批逻辑） */
export type CommandGuard = (
  tool: string,
  command: string,
  signal?: AbortSignal
) => Promise<CommandGuardHit | null>;

export function dcgDialect(tool: string): 'posix' | 'ps' | null {
  if (tool === 'bash') return 'posix';
  if (tool === 'powershell') return 'ps';
  return null;
}

export function parseDcgVerdict(exitCode: number | null, stdout: string): CommandGuardHit | null {
  if (exitCode !== 1) return null;
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (value.decision !== 'deny') return null;
    const { rule_id: ruleId, reason } = value;
    if (typeof ruleId !== 'string' || !ruleId || typeof reason !== 'string' || !reason) return null;
    return { ruleId, reason };
  } catch {
    return null;
  }
}

const MAX_OUTPUT = 64 * 1024;

export function createDcgGuard(binaryPath: string, timeoutMs = 1500): CommandGuard {
  return (tool, command, signal) => {
    const dialect = dcgDialect(tool);
    if (!dialect || !command.trim() || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const child = spawn(binaryPath, ['--robot', 'test', '--dialect', dialect, command], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DCG_ROBOT: '1' },
      });
      const finish = (hit: CommandGuardHit | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(hit);
      };
      const onAbort = () => {
        child.kill('SIGKILL');
        finish(null);
      };
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(0, MAX_OUTPUT);
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(parseDcgVerdict(code, stdout)));
    });
  };
}
