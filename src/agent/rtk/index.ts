import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RtkToolStats } from '@shared/rtk';
import { attachBackgroundCommandHooks, type PreparedBackgroundCommand } from '../backgroundTasks';

const DEFAULT_REWRITE_TIMEOUT_MS = 3_000;
const DEFAULT_GAIN_TIMEOUT_MS = 3_000;
const MAX_PROCESS_OUTPUT = 1_000_000;

const POWERSHELL_ALIASES = new Set([
  'cat',
  'cd',
  'clear',
  'cls',
  'copy',
  'cp',
  'curl',
  'del',
  'dir',
  'echo',
  'erase',
  'gc',
  'gci',
  'gps',
  'kill',
  'ls',
  'man',
  'md',
  'mkdir',
  'move',
  'mv',
  'pwd',
  'rd',
  'ren',
  'rename',
  'rm',
  'rmdir',
  'sleep',
  'sort',
  'type',
  'wget',
  'where',
]);

const POWERSHELL_EXTERNALS = new Set([
  'cargo',
  'clang',
  'cmake',
  'deno',
  'docker',
  'docker-compose',
  'dotnet',
  'eslint',
  'gh',
  'git',
  'go',
  'golangci-lint',
  'grep',
  'jest',
  'kubectl',
  'make',
  'mvn',
  'node',
  'npm',
  'npx',
  'pnpm',
  'poetry',
  'python',
  'python3',
  'pytest',
  'rg',
  'ruff',
  'rustc',
  'swift',
  'tsc',
  'uv',
  'vitest',
  'yarn',
]);

export interface RtkOptimizationOptions {
  binaryPath?: string;
  dataDir: string;
  cwd: string;
  remote?: boolean;
  enabled?: boolean;
  shell?: 'bash' | 'powershell';
  rewriteTimeoutMs?: number;
  gainTimeoutMs?: number;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RuntimePaths {
  callDir: string;
  historyDb: string;
  recallDb: string;
  teeDir: string;
}

function abortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function runProcess(
  binaryPath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(binaryPath, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-MAX_PROCESS_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const stop = () => {
      child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 250);
      force.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, options.timeoutMs)
    );
    timer.unref?.();
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(abortError());
      else resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function processEnv(paths: RuntimePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RTK_DB_PATH: paths.historyDb,
    RTK_RECALL_DB: paths.recallDb,
    RTK_TEE_DIR: paths.teeDir,
    RTK_TELEMETRY_DISABLED: '1',
    RTK_TRUST_PROJECT_FILTERS: '0',
  };
  delete env.RTK_DISABLED;
  delete env.RTK_NO_TOML;
  delete env.RTK_RECALL;
  delete env.RTK_TEE;
  return env;
}

const quoteBash = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export function toBashRuntimePath(value: string, platform: string = process.platform): string {
  if (platform !== 'win32') return value;
  const normalized = value.replaceAll('\\', '/');
  const drive = normalized.match(/^([a-z]):\/(.*)$/i);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function bashBinaryPaths(binaryPath: string): { binary: string; directory: string } {
  const directory =
    process.platform === 'win32' ? path.win32.dirname(binaryPath) : path.dirname(binaryPath);
  return {
    binary: toBashRuntimePath(binaryPath),
    directory: toBashRuntimePath(directory),
  };
}

function runtimeCommand(
  command: string,
  binaryPath: string,
  paths: RuntimePaths,
  shell: 'bash' | 'powershell'
): string {
  if (shell === 'powershell') {
    const assignments = [
      ['RTK_DB_PATH', paths.historyDb],
      ['RTK_RECALL_DB', paths.recallDb],
      ['RTK_TEE_DIR', paths.teeDir],
      ['RTK_TELEMETRY_DISABLED', '1'],
      ['RTK_TRUST_PROJECT_FILTERS', '0'],
    ]
      .map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`)
      .join('; ');
    const trimmed = command.trimStart();
    const invocation = /^rtk(?:\s|$)/i.test(trimmed)
      ? `& ${quotePowerShell(binaryPath)}${trimmed.slice(3)}`
      : command;
    return (
      `${assignments}; ` +
      'Remove-Item Env:RTK_DISABLED,Env:RTK_NO_TOML,Env:RTK_RECALL,Env:RTK_TEE -ErrorAction SilentlyContinue; ' +
      invocation
    );
  }
  const assignments = [
    ['RTK_DB_PATH', paths.historyDb],
    ['RTK_RECALL_DB', paths.recallDb],
    ['RTK_TEE_DIR', paths.teeDir],
    ['RTK_TELEMETRY_DISABLED', '1'],
    ['RTK_TRUST_PROJECT_FILTERS', '0'],
  ]
    .map(([key, value]) => `${key}=${quoteBash(value)}`)
    .join('; ');
  const bashBinary = bashBinaryPaths(binaryPath);
  const pathSetup =
    `if [ -n "\${PATH:-}" ]; then PATH=${quoteBash(bashBinary.directory)}:"$PATH"; ` +
    `else PATH=${quoteBash(bashBinary.directory)}; fi; export PATH; `;
  return (
    `${assignments}; export RTK_DB_PATH RTK_RECALL_DB RTK_TEE_DIR RTK_TELEMETRY_DISABLED RTK_TRUST_PROJECT_FILTERS; ` +
    `unset RTK_DISABLED RTK_NO_TOML RTK_RECALL RTK_TEE; ${pathSetup}` +
    `rtk() { ${quoteBash(bashBinary.binary)} "$@"; }; ${command}`
  );
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  const push = () => {
    if (!started) return;
    words.push(word);
    word = '';
    started = false;
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (';&|'.includes(character)) {
      push();
      words.push(character);
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped || quote) return undefined;
  push();
  return words;
}

function hasUnsafeBashWrapper(command: string): boolean {
  const words = shellWords(command);
  if (!words) return true;
  let segmentStart = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (';&|'.includes(words[index])) {
      segmentStart = index + 1;
      continue;
    }
    if (words[index] !== 'rtk') continue;
    const prefix = words.slice(segmentStart, index);
    if (prefix.some((word) => word.startsWith('PATH='))) return true;
    const lower = prefix.map((word) => word.toLowerCase().split('/').at(-1) ?? word);
    if (lower.some((word) => ['sudo', 'doas', 'su', 'ssh', 'chroot'].includes(word))) return true;
    if (
      lower.some(
        (word, cursor) =>
          ['docker', 'podman'].includes(word) && lower.slice(cursor + 1).includes('exec')
      )
    ) {
      return true;
    }
    for (let cursor = 0; cursor < lower.length; cursor += 1) {
      if (lower[cursor] !== 'env') continue;
      for (let arg = cursor + 1; arg < prefix.length; arg += 1) {
        const word = prefix[arg];
        const normalized = word.toLowerCase();
        if (
          normalized === '-' ||
          normalized === '--ignore-environment' ||
          /^-[^-]*i/.test(normalized) ||
          word.startsWith('PATH=') ||
          normalized === '--unset=path' ||
          normalized === '-upath'
        ) {
          return true;
        }
        if ((normalized === '-u' || normalized === '--unset') && prefix[arg + 1] === 'PATH') {
          return true;
        }
      }
    }
  }
  return false;
}

function hasPowerShellSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (const character of command) {
    if (character === '`') {
      if (quote !== "'") return true;
      continue;
    }
    if (quote) {
      if (quote === '"' && character === '$') return true;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if ('|;&$(){}<>\r\n'.includes(character)) return true;
  }
  return Boolean(quote);
}

export function isPowerShellRtkCandidate(command: string): boolean {
  if (!command.trim() || hasPowerShellSyntax(command)) return false;
  const first = command
    .trimStart()
    .match(/^([^\s]+)/)?.[1]
    ?.toLowerCase();
  if (!first || POWERSHELL_ALIASES.has(first)) return false;
  if (/\.(?:exe|cmd|bat|com)$/i.test(first)) return true;
  return POWERSHELL_EXTERNALS.has(first);
}

function isReadonlyRtkCommand(command: string): boolean {
  return (
    /^\s*rtk\s+recall(?:\s+(?:[a-f\d]{1,64}|--(?:full|list)|--(?:from|lines)\s+\d+))*\s*$/i.test(
      command
    ) || /^\s*rtk\s+git\s+diff\s+--no-compact\s*$/i.test(command)
  );
}

function isAlreadyRtk(command: string): boolean {
  return /^\s*rtk(?:\s|$)/i.test(command);
}

function details(rtk: RtkToolStats): { rtk: RtkToolStats } {
  return { rtk };
}

function mergeDetails(
  current: unknown,
  rtk: RtkToolStats
): { rtk: RtkToolStats } & Record<string, unknown> {
  const record =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...record, rtk };
}

function withReason(
  status: RtkToolStats['status'],
  originalCommand: string,
  reason: string
): RtkToolStats {
  return { status, originalCommand, reason };
}

async function runtimePaths(dataDir: string): Promise<RuntimePaths> {
  const callsDir = path.join(dataDir, 'calls');
  await mkdir(callsDir, { recursive: true, mode: 0o700 });
  const callDir = await mkdtemp(path.join(callsDir, 'call-'));
  return {
    callDir,
    historyDb: path.join(callDir, 'history.db'),
    recallDb: path.join(dataDir, 'recall.db'),
    teeDir: path.join(dataDir, 'tee'),
  };
}

function parseGain(stdout: string): { inputTokens: number; outputTokens: number } | undefined {
  try {
    const value = JSON.parse(stdout) as {
      summary?: { total_commands?: unknown; total_input?: unknown; total_output?: unknown };
    };
    const summary = value.summary;
    if (
      !summary ||
      typeof summary.total_commands !== 'number' ||
      summary.total_commands <= 0 ||
      typeof summary.total_input !== 'number' ||
      !Number.isSafeInteger(summary.total_input) ||
      summary.total_input < 0 ||
      typeof summary.total_output !== 'number' ||
      !Number.isSafeInteger(summary.total_output) ||
      summary.total_output < 0
    ) {
      return undefined;
    }
    return { inputTokens: summary.total_input, outputTokens: summary.total_output };
  } catch {
    return undefined;
  }
}

function immediate(command: string, rtk: RtkToolStats): PreparedBackgroundCommand {
  return { command, details: details(rtk) };
}

async function prepareCommand(
  command: string,
  signal: AbortSignal | undefined,
  options: RtkOptimizationOptions,
  shell: 'bash' | 'powershell'
): Promise<PreparedBackgroundCommand> {
  if (options.enabled === false)
    return immediate(command, withReason('bypassed', command, 'disabled'));
  if (options.remote) return immediate(command, withReason('bypassed', command, 'remote'));
  if (!command.trim()) return immediate(command, withReason('unchanged', command, 'empty'));
  if (!options.binaryPath || !path.isAbsolute(options.binaryPath)) {
    return immediate(command, withReason('unavailable', command, 'binary-unavailable'));
  }
  if (isAlreadyRtk(command) && !isReadonlyRtkCommand(command)) {
    return immediate(command, withReason('bypassed', command, 'already-rtk'));
  }
  if (
    shell === 'powershell' &&
    !isReadonlyRtkCommand(command) &&
    !isPowerShellRtkCandidate(command)
  ) {
    return immediate(command, withReason('bypassed', command, 'powershell-syntax'));
  }

  let paths: RuntimePaths;
  try {
    paths = await runtimePaths(options.dataDir);
  } catch {
    return immediate(command, withReason('unavailable', command, 'data-dir-unavailable'));
  }
  const cleanup = async () => {
    try {
      await rm(paths.callDir, { recursive: true, force: true });
    } catch {
      // 临时统计目录清理失败不能改变原命令结果。
    }
  };

  if (isReadonlyRtkCommand(command)) {
    const rtk = withReason('bypassed', command, 'readonly-rtk');
    return {
      command: runtimeCommand(command, options.binaryPath, paths, shell),
      details: details(rtk),
      finalize: async () => {
        await cleanup();
        return details(rtk);
      },
    };
  }

  let rewritten: ProcessResult;
  try {
    rewritten = await runProcess(options.binaryPath, ['rewrite', command], {
      cwd: options.cwd,
      env: processEnv(paths),
      timeoutMs: options.rewriteTimeoutMs ?? DEFAULT_REWRITE_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    await cleanup();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return immediate(command, withReason('unavailable', command, 'rewrite-error'));
  }
  if (rewritten.timedOut) {
    await cleanup();
    return immediate(command, withReason('unavailable', command, 'rewrite-timeout'));
  }
  if (rewritten.code === 1) {
    await cleanup();
    return immediate(command, withReason('unchanged', command, 'unsupported'));
  }
  if (rewritten.code !== 0 && rewritten.code !== 3) {
    await cleanup();
    return immediate(
      command,
      withReason(
        rewritten.code === 2 ? 'bypassed' : 'unavailable',
        command,
        `rewrite-exit-${rewritten.code}`
      )
    );
  }
  const rewrittenCommand = rewritten.stdout.trim();
  if (!rewrittenCommand) {
    await cleanup();
    return immediate(command, withReason('unavailable', command, 'empty-rewrite'));
  }
  if (rewrittenCommand === command) {
    await cleanup();
    return immediate(command, withReason('unchanged', command, 'same-command'));
  }
  if (shell === 'bash' && hasUnsafeBashWrapper(rewrittenCommand)) {
    await cleanup();
    return immediate(command, withReason('bypassed', command, 'unsafe-wrapper'));
  }

  const pending: RtkToolStats = {
    status: 'pending',
    originalCommand: command,
    rewrittenCommand,
  };
  let finalized: Promise<{ rtk: RtkToolStats }> | undefined;
  const finalize = () => {
    finalized ??= (async () => {
      const base = {
        originalCommand: command,
        rewrittenCommand,
      };
      let rtk: RtkToolStats = {
        ...base,
        status: 'unavailable',
        reason: 'statistics-unavailable',
      };
      try {
        const gain = await runProcess(options.binaryPath as string, ['gain', '--format', 'json'], {
          cwd: options.cwd,
          env: processEnv(paths),
          timeoutMs: options.gainTimeoutMs ?? DEFAULT_GAIN_TIMEOUT_MS,
        });
        const metrics = !gain.timedOut && gain.code === 0 ? parseGain(gain.stdout) : undefined;
        if (metrics) {
          rtk = {
            ...base,
            ...metrics,
            status: metrics.inputTokens > metrics.outputTokens ? 'compressed' : 'unchanged',
          };
        }
      } catch {
        // 统计是附加信息，不能改变命令结果或触发原命令重跑。
      } finally {
        await cleanup();
      }
      return details(rtk);
    })();
    return finalized;
  };
  return {
    command: runtimeCommand(rewrittenCommand, options.binaryPath, paths, shell),
    details: details(pending),
    finalize,
  };
}

export function withRtkOptimization(
  definition: ToolDefinition,
  options: RtkOptimizationOptions
): ToolDefinition {
  if (options.enabled === false) return definition;
  const shell = options.shell ?? (definition.name === 'powershell' ? 'powershell' : 'bash');
  const wrapped: ToolDefinition = {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const record = params as Record<string, unknown>;
      if (typeof record.command !== 'string') {
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      const prepared = await prepareCommand(record.command, signal, options, shell);
      try {
        const result = await definition.execute(
          toolCallId,
          { ...record, command: prepared.command },
          signal,
          onUpdate,
          ctx
        );
        const finalDetails = prepared.finalize ? await prepared.finalize() : prepared.details;
        const rtk = (finalDetails as { rtk: RtkToolStats }).rtk;
        return { ...result, details: mergeDetails(result.details, rtk) };
      } catch (error) {
        try {
          await prepared.finalize?.();
        } catch {
          // 清理或统计错误不能覆盖原始执行错误。
        }
        throw error;
      }
    },
  };
  return attachBackgroundCommandHooks(wrapped, {
    prepare: (_toolCallId, command, signal) => prepareCommand(command, signal, options, shell),
  });
}
