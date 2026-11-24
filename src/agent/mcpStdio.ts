import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { listProcesses, signalProcessTree } from './killTree';

/** 登记目录名（在 agent 数据目录下）：worker 写，Main 在 worker 退出与启动时清扫 */
export const MCP_SERVER_REGISTRY_DIR = 'mcp-servers';

/** 关 stdin 后等 server 自己退出，再给整棵树 SIGTERM、SIGKILL；要赶在 Main 停 worker 的 3 秒内收完 */
const EOF_GRACE_MS = 500;
const TERM_GRACE_MS = 1_000;

export interface StdioServerParams {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** pid 加启动时间才认定是同一个进程：pid 被复用、用户自己起的同名 server 都对不上 */
export interface McpServerRecord {
  pid: number;
  started: string;
  /** 拉起它的 worker；还活着就不清扫 */
  owner: { pid: number; started: string };
  command: string;
}

/** 进程启动时间（ps lstart，C locale 下格式固定）；不给 pids 时列全机。ps 不可用为空 */
export function startTimes(pids?: readonly number[]): Map<number, string> {
  const args = pids ? ['-o', 'pid=,lstart=', '-p', pids.join(',')] : ['-axo', 'pid=,lstart='];
  let out: string;
  try {
    out = execFileSync('ps', args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch (error) {
    // ps -p 里有已退出的 pid 时退出码非 0，活着的那些照样在 stdout 里
    out = String((error as { stdout?: unknown }).stdout ?? '');
  }
  const times = new Map<number, string>();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match) times.set(Number(match[1]), match[2]);
  }
  return times;
}

export function recordMcpServer(dir: string, record: McpServerRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${record.pid}.json`), JSON.stringify(record));
}

function forget(dir: string, pid: number): void {
  rmSync(path.join(dir, `${pid}.json`), { force: true });
}

function parseRecord(raw: unknown): McpServerRecord | null {
  const value = raw as Partial<McpServerRecord> | null;
  const owner = value?.owner as Partial<McpServerRecord['owner']> | undefined;
  return Number.isInteger(value?.pid) &&
    typeof value?.started === 'string' &&
    Number.isInteger(owner?.pid) &&
    typeof owner?.started === 'string'
    ? (value as McpServerRecord)
    : null;
}

function readRecords(dir: string): McpServerRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    const full = path.join(dir, file);
    try {
      const record = parseRecord(JSON.parse(readFileSync(full, 'utf8')));
      if (record) return [record];
    } catch {}
    rmSync(full, { force: true });
    return [];
  });
}

const ignore = () => {};

/** 组长还在，或组里还有成员（组号在用时 pid 不会被复用） */
function groupAlive(record: McpServerRecord, starts: Map<number, string>): boolean {
  return (
    starts.get(record.pid) === record.started ||
    listProcesses().some((entry) => entry.pgid === record.pid)
  );
}

/**
 * 清扫登记者（worker）已经不在的 stdio MCP server：worker 被强杀、随应用被直接结束时没机会收尾，
 * 不理 stdin EOF 的 server（HopperMCPServer、`npm exec` 外壳）会一直活着。只认 pid 与启动时间都对得上的，
 * 整棵树先 SIGTERM，宽限后还在的 SIGKILL；没来得及 SIGKILL 的登记留到下次清扫。
 * exitedOwner：刚报告退出的 worker。应用退出时 Electron 报 exit 那一刻它可能还在进程表里，不能按表判断。
 */
export function sweepOrphanMcpServers(dir: string, exitedOwner?: number): void {
  if (process.platform === 'win32') return;
  const records = readRecords(dir);
  if (records.length === 0) return;
  const starts = startTimes();
  const orphans = records.filter((record) => {
    const ownerAlive =
      record.owner.pid !== exitedOwner && starts.get(record.owner.pid) === record.owner.started;
    if (ownerAlive) return false;
    if (starts.get(record.pid) === record.started) return true;
    forget(dir, record.pid);
    return false;
  });
  if (orphans.length === 0) return;
  const known = new Map(orphans.map((record) => [record.pid, new Set<number>()]));
  for (const record of orphans) {
    signalProcessTree(record.pid, 'SIGTERM', known.get(record.pid), {}, ignore);
  }
  setTimeout(() => {
    const now = startTimes();
    for (const record of orphans) {
      if (groupAlive(record, now)) {
        signalProcessTree(record.pid, 'SIGKILL', known.get(record.pid), {}, ignore);
      }
      forget(dir, record.pid);
    }
  }, TERM_GRACE_MS).unref();
}

let ownerStarted: string | undefined;

function settle(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * stdio MCP transport：server 放进自己的进程组，断开时连同它派生的整棵树一起结束
 * （SDK 的 StdioClientTransport 与应用同组、只信号直接子进程，`npx` 外壳下面的真实 server 会留下来）。
 * 给了 registryDir 就登记 pid，worker 来不及收尾时由 Main 清扫。
 */
class ProcessTreeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer();
  private readonly known = new Set<number>();

  constructor(
    private readonly params: StdioServerParams,
    private readonly registryDir?: string
  ) {}

  start(): Promise<void> {
    if (this.child) throw new Error('stdio transport already started');
    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args, {
        env: this.params.env,
        stdio: ['pipe', 'pipe', 'inherit'],
        detached: true,
      });
      this.child = child;
      child.on('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on('spawn', () => {
        this.register(child);
        resolve();
      });
      child.on('close', () => {
        if (this.child === child) this.child = undefined;
        if (this.registryDir && child.pid) forget(this.registryDir, child.pid);
        this.onclose?.();
      });
      child.stdin?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
        } catch (error) {
          this.onerror?.(error as Error);
          void this.close().catch(ignore);
          return;
        }
        this.drain();
      });
    });
  }

  private drain(): void {
    for (;;) {
      try {
        const message = this.buffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  private register(child: ChildProcess): void {
    if (!this.registryDir || !child.pid) return;
    try {
      const starts = startTimes([child.pid, process.pid]);
      ownerStarted ??= starts.get(process.pid);
      const started = starts.get(child.pid);
      if (!started || !ownerStarted) return;
      recordMcpServer(this.registryDir, {
        pid: child.pid,
        started,
        owner: { pid: process.pid, started: ownerStarted },
        command: this.params.command,
      });
    } catch {
      // 登记只是强杀后的兜底，写不了不影响连接
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      const stdin = this.child?.stdin;
      if (!stdin) throw new Error('Not connected');
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.buffer.clear();
    const pid = child?.pid;
    if (!child || !pid) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    let rootExited = false;
    void exited.then(() => {
      rootExited = true;
    });
    // 根进程已退出时只看进程表里还有没有它组里（或见过的组里）的成员
    const treeAlive = () =>
      !rootExited ||
      listProcesses().some((entry) => entry.pgid === pid || this.known.has(entry.pgid));
    try {
      child.stdin?.end();
    } catch {}
    await settle(exited, EOF_GRACE_MS);
    for (const [signal, grace] of [
      ['SIGTERM', TERM_GRACE_MS],
      ['SIGKILL', 0],
    ] as const) {
      if (!treeAlive()) break;
      signalProcessTree(pid, signal, this.known, {}, ignore);
      const deadline = Date.now() + grace;
      while (Date.now() < deadline && treeAlive()) {
        await new Promise((resolve) => setTimeout(resolve, 50).unref());
      }
    }
    if (this.registryDir) forget(this.registryDir, pid);
  }
}

export function createStdioTransport(params: StdioServerParams, registryDir?: string): Transport {
  // Windows 没有进程组；沿用 SDK（cross-spawn 解析 npx.cmd 等）
  if (process.platform === 'win32') return new StdioClientTransport(params);
  return new ProcessTreeStdioTransport(params, registryDir);
}
