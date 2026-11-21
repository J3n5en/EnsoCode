import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  parseSecretaryToolDraft,
  parseSecretaryToolFile,
  renderSecretaryToolFile,
  secretaryToolDescriptor,
  secretaryToolScriptFile,
  TOOL_OUTPUT_MAX,
  TOOL_STDERR_MAX,
  TOOL_TIMEOUT_DEFAULT,
} from '@shared/secretary/customTools';
import { isSecretarySlug } from '@shared/secretary/skills';
import { wrapUntrusted } from '@shared/secretary/transcript';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryToolDescriptor,
  SecretaryToolDraft,
  SecretaryToolRuntime,
} from '@shared/types/secretary';
import { writeAtomic } from '../bots/files';
import { redactSecrets } from '../memory/distill';
import { appendAudit } from './audit';
import { notifySecretaryChanged } from './dispatch';
import { saveProposalRecord } from './proposals';
import type { SecretaryContext } from './secretaries';
import { SecretaryStore } from './store';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

const TOOL_FILE = 'tool.json';

export type ToolSaveResult = { ok: true; name: string } | { ok: false; error: string };

export type ToolRunOutcome = { ok: true; output: string } | { ok: false; error: string };

export interface ToolRunOptions {
  signal?: AbortSignal;
  /** 测试注入：默认 PATH 里的 python3 */
  pythonPath?: string;
  /** 测试注入：默认 process.execPath */
  nodePath?: string;
}

/** 目录里每个子目录一份 tool.json 加一个脚本；读不懂的跳过，坏文件不能顶掉整张列表 */
export function listSecretaryTools(dir: string): SecretaryToolDraft[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const tools: SecretaryToolDraft[] = [];
  for (const name of entries.sort()) {
    const tool = readSecretaryTool(dir, name);
    if (tool) tools.push(tool);
  }
  return tools;
}

/** 只接受合法 slug：路径由 dir 与 name 拼出，name 里不可能出现分隔符或 .. */
export function readSecretaryTool(dir: string, name: string): SecretaryToolDraft | null {
  if (!isSecretarySlug(name)) return null;
  try {
    const raw = readFileSync(path.join(dir, name, TOOL_FILE), 'utf8');
    const runtime = (JSON.parse(raw) as { runtime?: unknown } | null)?.runtime;
    if (runtime !== 'python' && runtime !== 'node') return null;
    const code = readFileSync(path.join(dir, name, secretaryToolScriptFile(runtime)), 'utf8');
    const parsed = parseSecretaryToolFile(raw, code);
    // 目录名才是工具的身份：tool.json 里的 name 对不上说明这份文件被搬过或用别的名字写过
    return parsed && parsed.name === name ? parsed : null;
  } catch {
    return null;
  }
}

function otherRuntime(runtime: SecretaryToolRuntime): SecretaryToolRuntime {
  return runtime === 'node' ? 'python' : 'node';
}

export function writeSecretaryTool(dir: string, draft: SecretaryToolDraft): void {
  if (!isSecretarySlug(draft.name)) throw new Error('invalid tool name');
  const toolDir = path.join(dir, draft.name);
  writeAtomic(path.join(toolDir, TOOL_FILE), renderSecretaryToolFile(draft));
  writeAtomic(path.join(toolDir, secretaryToolScriptFile(draft.runtime)), draft.code);
  // 换过运行时后旧脚本不能留着：执行只认当前 runtime 的文件名，留着只会让人以为它还在跑
  const stale = path.join(toolDir, secretaryToolScriptFile(otherRuntime(draft.runtime)));
  rmSync(stale, { force: true });
}

export function removeSecretaryTool(dir: string, name: string): boolean {
  if (!isSecretarySlug(name)) return false;
  const target = path.join(dir, name);
  if (!existsSync(target) || !statSync(target).isDirectory()) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** spawn 时下发给 worker 的工具表：只带名字、描述、参数结构与只读标记，不带代码 */
export function secretaryToolDescriptors(dir: string): SecretaryToolDescriptor[] {
  return listSecretaryTools(dir).map(secretaryToolDescriptor);
}

/**
 * 子进程只拿到最小的环境：Main 的环境变量里有 API key 与凭据路径。
 * node 工具靠 Electron 自带的 node 运行，所以要 ELECTRON_RUN_AS_NODE。
 */
function toolEnv(runtime: SecretaryToolRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (runtime === 'node') env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function missingRuntime(runtime: SecretaryToolRuntime): string {
  return runtime === 'python'
    ? 'python 工具需要安装 python3：PATH 里找不到 python3'
    : '找不到 node 可执行文件，无法运行这个工具';
}

/**
 * win32 没有进程组：不 detached，超时与取消靠 taskkill 连子进程一起杀；
 * 其它平台杀整个进程组，组已不在时退回单个进程。
 */
export function killSecretaryTool(
  pid: number,
  platform: NodeJS.Platform,
  fallback: () => void,
  run: (file: string, args: string[]) => void = (file, args) => {
    execFile(file, args, () => {});
  },
  signal: (target: number) => void = (target) => {
    process.kill(target, 'SIGKILL');
  }
): void {
  if (platform === 'win32') {
    try {
      run('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch {
      // taskkill 不可用时进程已经退出，没有别的办法
    }
    return;
  }
  try {
    signal(-pid);
  } catch {
    fallback();
  }
}

/** 参数走 stdin，结果走 stdout；超时或取消时连子进程组一起杀，免得留下孤儿 */
export function runSecretaryTool(
  dir: string,
  draft: SecretaryToolDraft,
  args: unknown,
  options: ToolRunOptions = {}
): Promise<ToolRunOutcome> {
  const toolDir = path.join(dir, draft.name);
  const script = path.join(toolDir, secretaryToolScriptFile(draft.runtime));
  const command =
    draft.runtime === 'node'
      ? (options.nodePath ?? process.execPath)
      : (options.pythonPath ?? 'python3');
  const timeoutSec = draft.timeoutSec ?? TOOL_TIMEOUT_DEFAULT;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, [script], {
      cwd: toolDir,
      env: toolEnv(draft.runtime),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const finish = (outcome: ToolRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const kill = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      killSecretaryTool(pid, process.platform, () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已经退出
        }
      });
    };
    const onAbort = () => {
      kill();
      finish({ ok: false, error: `工具 ${draft.name} 已取消` });
    };
    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, error: `工具 ${draft.name} 超过 ${timeoutSec} 秒未结束，已终止` });
    }, timeoutSec * 1000);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length <= TOOL_OUTPUT_MAX) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-TOOL_STDERR_MAX);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        error: error.code === 'ENOENT' ? missingRuntime(draft.runtime) : error.message,
      });
    });
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, output: stdout.slice(0, TOOL_OUTPUT_MAX) });
      else finish({ ok: false, error: stderr.trim() || `工具 ${draft.name} 退出码 ${code}` });
    });
    // 脚本不读 stdin 时会 EPIPE：不能让它变成 Main 的未捕获错误
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(args ?? {}));
  });
}

/** Main 侧的工具写入数据源；测试注入假实现，生产走文件末尾的 secretaryToolPorts */
export interface SecretaryToolPorts {
  dir(): string;
  dispatchFile(): SecretaryDispatchFile;
  saveDispatch(file: SecretaryDispatchFile): void;
  audit(entry: SecretaryAuditEntry): void;
  notify(): void;
  /** 工具在 spawn 时定死：写完释放空闲会话，忙的等本轮结束 */
  releaseSessions(): Promise<void>;
  runTool(draft: SecretaryToolDraft, args: unknown): Promise<ToolRunOutcome>;
  now(): number;
  newId(): string;
}

export interface SecretaryToolService {
  propose(params: Record<string, unknown>, ctx: SecretaryOpContext): Promise<SecretaryOpResult>;
  save(draft: unknown, secretaryConversationId: string | null): Promise<ToolSaveResult>;
  remove(request: unknown, secretaryConversationId: string | null): Promise<ToolSaveResult>;
  list(): SecretaryToolDraft[];
  run(params: Record<string, unknown>, ctx: SecretaryOpContext): Promise<SecretaryOpResult>;
}

function nameParam(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const name = (request as { name?: unknown }).name;
  return isSecretarySlug(name) ? name : null;
}

export function createSecretaryTools(ports: SecretaryToolPorts): SecretaryToolService {
  function audit(
    op: string,
    secretaryConversationId: string | null,
    ok: boolean,
    detail?: string,
    targetId?: string
  ): void {
    ports.audit({
      at: ports.now(),
      secretaryConversationId,
      op,
      ...(targetId ? { targetId } : {}),
      ok,
      ...(detail ? { detail } : {}),
    });
  }

  async function release(): Promise<void> {
    try {
      await ports.releaseSessions();
    } catch (error) {
      // 文件已经落盘：释放失败不能报成保存失败，下一轮 spawn 仍会读到新内容
      console.warn('[secretary] releasing sessions after a tool change failed:', error);
    }
  }

  return {
    async propose(params, ctx) {
      if (!ctx.secretaryConversationId) return { ok: false, error: 'invalid arguments' };
      const parsed = parseSecretaryToolDraft(params);
      if (!parsed.ok) return parsed;
      const existing = readSecretaryTool(ports.dir(), parsed.draft.name);
      const now = ports.now();
      const file = ports.dispatchFile();
      const { saved, changed } = saveProposalRecord(file, {
        id: ports.newId(),
        secretaryConversationId: ctx.secretaryConversationId,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        kind: 'tool',
        draft: parsed.draft,
        ...(existing ? { previous: existing } : {}),
      });
      if (changed) {
        ports.saveDispatch(file);
        ports.notify();
      }
      audit(
        'secretary_tool_propose',
        ctx.secretaryConversationId,
        true,
        saved.reused ? 'awaiting_confirmation (existing)' : 'awaiting_confirmation',
        saved.proposalId
      );
      return {
        ok: true,
        result: {
          status: 'awaiting_confirmation',
          proposalId: saved.proposalId,
          ...(saved.reused ? { reused: true } : {}),
          ...(saved.note ? { note: saved.note } : {}),
        },
      };
    },

    async save(draft, secretaryConversationId) {
      const parsed = parseSecretaryToolDraft(draft);
      if (!parsed.ok) {
        audit('tool_save', secretaryConversationId, false, parsed.error);
        return parsed;
      }
      try {
        writeSecretaryTool(ports.dir(), parsed.draft);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        audit('tool_save', secretaryConversationId, false, message, parsed.draft.name);
        return { ok: false, error: message };
      }
      audit('tool_save', secretaryConversationId, true, 'succeeded', parsed.draft.name);
      await release();
      ports.notify();
      return { ok: true, name: parsed.draft.name };
    },

    async remove(request, secretaryConversationId) {
      const name = nameParam(request);
      if (!name) return { ok: false, error: 'invalid request' };
      if (!removeSecretaryTool(ports.dir(), name)) {
        audit('tool_delete', secretaryConversationId, false, 'not-found', name);
        return { ok: false, error: 'not-found' };
      }
      audit('tool_delete', secretaryConversationId, true, 'deleted', name);
      await release();
      ports.notify();
      return { ok: true, name };
    },

    list() {
      return listSecretaryTools(ports.dir());
    },

    async run(params, ctx) {
      const name = nameParam(params);
      const args = params.arguments ?? {};
      const readOnly = params.readOnly;
      if (!name || !ctx.secretaryConversationId || typeof readOnly !== 'boolean') {
        return { ok: false, error: 'invalid arguments' };
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, error: 'invalid arguments' };
      }
      // 每次执行都读盘上的已确认版本：worker 传来的代码一律不认
      const draft = readSecretaryTool(ports.dir(), name);
      if (!draft) return { ok: false, error: 'not-found' };
      // 审批与否取决于 spawn 时下发的描述符：盘上版本变了就不能拿旧会话的判定跑新代码
      if (draft.readOnly !== readOnly) return { ok: false, error: '工具已更新，请在新会话中重试' };
      const outcome = await ports.runTool(draft, args);
      // 会改东西的工具每次执行都留痕；参数内容不记，只记结果
      if (!draft.readOnly) {
        audit(
          'tool_run',
          ctx.secretaryConversationId,
          outcome.ok,
          outcome.ok ? 'succeeded' : redactSecrets(outcome.error).slice(0, 500),
          draft.name
        );
      }
      const source = `tool:${draft.name}`;
      return outcome.ok
        ? { ok: true, result: { output: wrapUntrusted(source, redactSecrets(outcome.output)) } }
        : { ok: false, error: wrapUntrusted(source, redactSecrets(outcome.error)) };
    },
  };
}

/** 秘书工作区就是秘书项目的 cwd：自有工具放在它下面的 tools/ */
export function secretaryToolsDir(ctx: Pick<SecretaryContext, 'dir'>): string {
  return path.join(ctx.dir, 'workspace', 'tools');
}

export function toolPortsFor(ctx: SecretaryContext): SecretaryToolPorts {
  const store = () => new SecretaryStore(ctx.dir);
  return {
    dir: () => secretaryToolsDir(ctx),
    dispatchFile: () => store().dispatch(),
    saveDispatch: (file) => {
      store().saveDispatch(file);
    },
    audit: (entry) => appendAudit(ctx.dir, entry),
    notify: () => {
      notifySecretaryChanged();
    },
    releaseSessions: async () => {
      const { secretaryProfileFor } = await import('./profile');
      await secretaryProfileFor(ctx).releaseSessions();
    },
    runTool: (draft, args) => runSecretaryTool(secretaryToolsDir(ctx), draft, args),
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

export function secretaryToolFor(ctx: SecretaryContext): SecretaryToolService {
  return createSecretaryTools(toolPortsFor(ctx));
}

export function toolHandlersFor(ctx: SecretaryContext): {
  tool_propose: SecretaryOpHandler;
  tool_run: SecretaryOpHandler;
} {
  return {
    tool_propose: (params, op) => secretaryToolFor(ctx).propose(params, op),
    tool_run: (params, op) => secretaryToolFor(ctx).run(params, op),
  };
}
