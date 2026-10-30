import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ComputerError } from '@shared/computer/errors';
import type { ComputerAllowedApp, ComputerAppIdentity } from '@shared/computer/types';

/** dismissed：提示被关闭（run 中止或超时未答），不记为拒绝 */
export type AppPromptAnswer = 'once' | 'always' | 'deny' | 'dismissed';

/** 等待用户回答的上限：须小于 worker 侧超出 run 预算的余量（30s） */
export const APP_PROMPT_TIMEOUT_MS = 25_000;

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规范 app 身份：绝对且已规范化的路径（`.app` 包，或不在包里的窗口程序的可执行文件），
 * 无 `..` 片段；bundle id 可为空（以路径作身份）。
 */
export function normalizeAppIdentity(raw: unknown): ComputerAppIdentity | null {
  if (!isRecord(raw)) return null;
  const { bundleId, name, path: appPath } = raw;
  if (typeof bundleId !== 'string' || typeof name !== 'string' || typeof appPath !== 'string') {
    return null;
  }
  if (bundleId !== '' && !BUNDLE_ID.test(bundleId)) return null;
  if (!path.isAbsolute(appPath) || appPath.split('/').includes('..')) return null;
  if (path.normalize(appPath) !== appPath || appPath.length > 4096) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return { bundleId, name: trimmed, path: appPath };
}

export function appIdentityKey(app: Pick<ComputerAppIdentity, 'bundleId' | 'path'>): string {
  return app.bundleId || app.path;
}

function normalizeAllowed(raw: unknown): ComputerAllowedApp | null {
  const identity = normalizeAppIdentity(raw);
  if (!identity || !isRecord(raw)) return null;
  const grantedAt = raw.grantedAt;
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) return null;
  const lastUsedAt = raw.lastUsedAt;
  return {
    ...identity,
    grantedAt,
    ...(typeof lastUsedAt === 'number' && Number.isFinite(lastUsedAt) ? { lastUsedAt } : {}),
  };
}

/** 不存在或损坏返回空表；脏条目丢弃 */
export function readAllowedApps(file: string): ComputerAllowedApp[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.apps)) return [];
    return parsed.apps.flatMap((item) => {
      const app = normalizeAllowed(item);
      return app ? [app] : [];
    });
  } catch {
    return [];
  }
}

function writeAllowedApps(file: string, apps: ComputerAllowedApp[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, apps }, null, 2), 'utf8');
  renameSync(tmp, file);
}

function deniedError(app: ComputerAppIdentity): ComputerError {
  return new ComputerError(
    'app-denied',
    `The user has not allowed computer control of ${app.name}. Do not retry; ask the user, or use another app.`
  );
}

/**
 * 按 app 授权：名单（始终允许）落盘只存元数据；「仅本次」与拒绝只在 session 内存里。
 * 名单命中要求 bundle id 与规范路径同时一致，被替换到别处的同名 app 重新询问。
 */
export class AppAuthorizer {
  private readonly sessionGrants = new Map<string, Set<string>>();
  private readonly sessionDenials = new Map<string, Set<string>>();
  private readonly prompts = new Map<string, Promise<AppPromptAnswer>>();

  constructor(
    private readonly deps: {
      /** 名单文件；函数形式用于 Electron userData 就绪后再求值 */
      file: string | (() => string);
      prompt: (
        app: ComputerAppIdentity,
        signal: AbortSignal,
        sessionId: string
      ) => Promise<AppPromptAnswer>;
      promptTimeoutMs?: number;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private file(): string {
    return typeof this.deps.file === 'function' ? this.deps.file() : this.deps.file;
  }

  list(): ComputerAllowedApp[] {
    return readAllowedApps(this.file());
  }

  private allowed(app: ComputerAppIdentity): ComputerAllowedApp | undefined {
    const key = appIdentityKey(app);
    return this.list().find((entry) => appIdentityKey(entry) === key && entry.path === app.path);
  }

  private touch(app: ComputerAllowedApp): void {
    const now = this.now();
    if (app.lastUsedAt !== undefined && now - app.lastUsedAt < LAST_USED_WRITE_INTERVAL_MS) return;
    const apps = this.list().map((entry) =>
      appIdentityKey(entry) === appIdentityKey(app) && entry.path === app.path
        ? { ...entry, lastUsedAt: now }
        : entry
    );
    try {
      writeAllowedApps(this.file(), apps);
    } catch {
      // 只是使用时间，写失败不阻断授权
    }
  }

  async authorize(
    sessionId: string,
    app: ComputerAppIdentity,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    const key = appIdentityKey(app);
    const listed = this.allowed(app);
    if (listed) {
      this.touch(listed);
      return;
    }
    if (this.sessionGrants.get(sessionId)?.has(`${key}\n${app.path}`)) return;
    if (this.sessionDenials.get(sessionId)?.has(`${key}\n${app.path}`)) throw deniedError(app);
    const promptKey = `${sessionId}\n${key}\n${app.path}`;
    let pending = this.prompts.get(promptKey);
    if (!pending) {
      const promptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.deps.promptTimeoutMs ?? APP_PROMPT_TIMEOUT_MS),
      ]);
      pending = this.deps
        .prompt(app, promptSignal, sessionId)
        .then((answer) => (promptSignal.aborted ? 'dismissed' : answer))
        .catch(() => (promptSignal.aborted ? ('dismissed' as const) : ('deny' as const)));
      this.prompts.set(promptKey, pending);
      void pending.finally(() => this.prompts.delete(promptKey));
    }
    const answer = await pending;
    const grantKey = `${key}\n${app.path}`;
    if (answer === 'dismissed') {
      throw new ComputerError(
        'app-prompt-dismissed',
        `The user did not answer whether to allow computer control of ${app.name}. Ask the user to allow it, then retry.`
      );
    }
    if (answer === 'deny') {
      const denials = this.sessionDenials.get(sessionId) ?? new Set<string>();
      this.sessionDenials.set(sessionId, denials);
      denials.add(grantKey);
      throw deniedError(app);
    }
    if (answer === 'always' && !this.allowed(app)) {
      try {
        const now = this.now();
        const apps = this.list().filter(
          (entry) => !(appIdentityKey(entry) === key && entry.path === app.path)
        );
        // 只落元数据：调用方传入的可能是带 pid 等运行期字段的对象
        apps.push({
          bundleId: app.bundleId,
          name: app.name,
          path: app.path,
          grantedAt: now,
          lastUsedAt: now,
        });
        writeAllowedApps(this.file(), apps);
        return;
      } catch {
        // 名单写不进去时退回本次 session 授权：用户已经同意了，不该让动作失败
      }
    } else if (answer === 'always') {
      return;
    }
    const grants = this.sessionGrants.get(sessionId) ?? new Set<string>();
    this.sessionGrants.set(sessionId, grants);
    grants.add(grantKey);
  }

  /** 按 bundle id（无 bundle id 的 app 用路径）撤销；同时清掉各 session 的「仅本次」授权 */
  revoke(key: string): boolean {
    const apps = this.list();
    const kept = apps.filter((entry) => appIdentityKey(entry) !== key);
    for (const grants of this.sessionGrants.values()) {
      for (const grant of [...grants]) {
        if (grant.split('\n')[0] === key) grants.delete(grant);
      }
    }
    if (kept.length === apps.length) return false;
    writeAllowedApps(this.file(), kept);
    return true;
  }

  forgetSession(sessionId: string): void {
    this.sessionGrants.delete(sessionId);
    this.sessionDenials.delete(sessionId);
  }
}
