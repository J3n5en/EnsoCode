import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from '@platform';
import { ComputerError } from '@shared/computer/errors';
import { normalizeComputerParams } from '@shared/computer/params';
import type {
  ComputerAllowedApp,
  ComputerCapabilities,
  ComputerRunResult,
} from '@shared/computer/types';
import type { ComputerOp } from '@shared/types/agent';
import { promptComputerAppAccess } from './computer/appApprovalPrompt';
import { AppAuthorizer } from './computer/appAuthorization';
import type { DesktopBackend } from './computer/backend';
import {
  type ComputerGuestSession,
  createComputerGuestSession,
  disposeComputerGuestVm,
  runComputerGuest,
} from './computer/guest';
import { LeaseTable } from './computer/leaseTable';
import { openMacPrivacySettings } from './computer/macPrivacySettings';
import { ComputerOccupancy } from './computer/occupancy';
import { createElectronOccupancyDeps } from './computer/occupancyOverlay';
import { createDesktopBackend } from './computer/platform';
import { createVirtualCursor } from './computer/virtualCursor';

const DEFAULT_LEASE_WAIT_MS = 20_000;
/** 真实键鼠只有一套：前台接管独占这把锁 */
const FOREGROUND_LEASE = 'fg';
const AX_WRITE_LEASE = 'ax-write';
const YIELD_MESSAGE =
  'The user took over the desktop (Esc or physical input). Stop and ask the user before using computer again.';

interface SessionState {
  guest: ComputerGuestSession;
  /** 该 session 所有未结束的 run（含排队中）；新 run 到来或 close 时全部中止 */
  active: Set<AbortController>;
  /** 最后一个 run 的收尾；新 run 等它结束再开始，保证同 session 串行 */
  tail: Promise<void>;
}

function abortedError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name.startsWith('Computer')
    ? reason
    : new Error('Computer action aborted');
}

export interface ComputerFeedback {
  pointer(input: {
    pid?: number;
    app?: string;
    screenX: number;
    screenY: number;
    action: string;
  }): void;
  /** 收起并释放所有指针窗口 */
  dispose?(): void;
}

/**
 * Main 侧桌面 computer 宿主。run 本身不占桌面；动作开始前按目标 app 申请租约：
 * 同一 app 串行、不同 app 并行，前台接管额外独占真实键鼠。
 * 同 session 新 run 先中止并等旧 run 收尾。
 */
export class ComputerHost {
  private readonly sessions = new Map<string, SessionState>();
  private backend?: DesktopBackend;
  private readonly leases: LeaseTable;

  constructor(
    private backendFactory: () => DesktopBackend,
    private occupancy?: ComputerOccupancy,
    options: {
      leaseWaitMs?: number;
      authorizer?: AppAuthorizer;
      feedback?: ComputerFeedback;
    } = {}
  ) {
    this.leases = new LeaseTable({ waitMs: options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS });
    this.authorizer = options.authorizer;
    this.feedback = options.feedback;
  }

  private readonly authorizer?: AppAuthorizer;
  private readonly feedback?: ComputerFeedback;

  setBackendFactory(factory: () => DesktopBackend): void {
    this.backendFactory = factory;
    this.backend = undefined;
  }

  private sharedBackend(): DesktopBackend {
    this.backend ??= this.backendFactory();
    return this.backend;
  }

  async invoke(
    sessionId: string,
    op: ComputerOp,
    params: unknown,
    signal?: AbortSignal
  ): Promise<ComputerRunResult> {
    if (op !== 'run') throw new Error(`unsupported computer op '${op}'`);
    const normalized = normalizeComputerParams(params);
    if (!normalized) throw new Error('computer requires code');
    if (signal?.aborted) throw new Error('Computer action aborted');

    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { guest: createComputerGuestSession(), active: new Set(), tail: Promise.resolve() };
      this.sessions.set(sessionId, state);
    }
    for (const earlier of state.active) earlier.abort();

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    state.active.add(controller);
    const previous = state.tail;
    const { promise: done, resolve: markDone } = Promise.withResolvers<void>();
    state.tail = done;
    const guest = state.guest;
    try {
      await previous;
      if (controller.signal.aborted) throw abortedError(controller.signal);
      if (this.sessions.get(sessionId) !== state) throw new Error('Computer session closed');
      const owner = `${sessionId}#${randomUUID()}`;
      const backend = this.sharedBackend();
      const occupancy = normalized.readOnly ? undefined : this.occupancy;
      let occupancyGen: number | undefined;
      // 后台投递不碰用户的鼠标键盘；第一次前台接管时才亮横幅、挂 Esc 与用户输入检测
      const lazyOccupancy = occupancy && {
        beginSynthetic: (synthetic?: { keys?: readonly string[] }) => {
          occupancyGen ??= occupancy.start(() => {
            const error = new Error(YIELD_MESSAGE);
            error.name = 'ComputerYieldError';
            controller.abort(error);
          });
          occupancy.beginSynthetic(synthetic);
        },
        endSynthetic: () => occupancy.endSynthetic(),
      };
      const access = async (request: {
        target?: string;
        ref?: string;
        delivery: 'background' | 'foreground';
        point?: { x: number; y: number };
      }) => {
        const desktop = !request.ref && (!request.target || request.target === 'desktop');
        let app = request.ref
          ? await backend.appForRef?.(request.ref)
          : !desktop && request.target
            ? await backend.appForTarget?.(request.target)
            : null;
        // 真实键鼠落在 desktop 上时，授权与加锁对象是实际收到输入的 app，判断不了就拒绝
        if (desktop && request.delivery === 'foreground' && backend.appForDesktopInput) {
          app = await backend.appForDesktopInput({ point: request.point });
          if (!app) {
            throw new ComputerError(
              'app-unknown',
              'Cannot tell which app would receive this desktop input; target a window with desktop.window(...) instead.'
            );
          }
        }
        const keys: string[] = [];
        const labels: Record<string, string> = { [FOREGROUND_LEASE]: 'the mouse and keyboard' };
        if (request.delivery === 'foreground') keys.push(FOREGROUND_LEASE);
        if (app) {
          await this.authorizer?.authorize(sessionId, app, controller.signal);
          const key = `app:${app.pid}`;
          keys.push(key);
          labels[key] = app.name;
        } else if (request.ref) {
          // 后端给不出 app 身份（如 Windows）：AX 写操作退回全局串行
          keys.push(AX_WRITE_LEASE);
          labels[AX_WRITE_LEASE] = 'accessibility actions';
        } else if (!desktop && request.target) {
          const key = `win:${request.target}`;
          keys.push(key);
          labels[key] = `window ${request.target}`;
        }
        await this.leases.acquire(owner, keys, controller.signal, labels);
      };
      const feedback = this.feedback;
      try {
        return await runComputerGuest({
          code: normalized.code,
          readOnly: normalized.readOnly,
          timeoutMs: normalized.timeoutSec * 1000,
          signal: controller.signal,
          backend,
          session: guest,
          occupancy: lazyOccupancy,
          access,
          ...(feedback
            ? {
                feedback: {
                  pointer: (input: {
                    target: string;
                    screenX: number;
                    screenY: number;
                    action: string;
                  }) => {
                    void backend.appForTarget?.(input.target).then(
                      (app) =>
                        feedback.pointer({
                          screenX: input.screenX,
                          screenY: input.screenY,
                          action: input.action,
                          ...(app ? { pid: app.pid, app: app.name } : {}),
                        }),
                      () => undefined
                    );
                  },
                },
              }
            : {}),
          persistVm: true,
        });
      } finally {
        if (occupancyGen !== undefined) this.occupancy?.stop(occupancyGen);
        this.leases.releaseOwner(owner);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      state.active.delete(controller);
      markDone();
    }
  }

  async capabilities(): Promise<ComputerCapabilities> {
    return this.sharedBackend().capabilities();
  }

  async openPermissionSettings(
    kind: 'screen' | 'accessibility'
  ): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'Permission settings are only needed on macOS' };
    }
    try {
      await openMacPrivacySettings(kind);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  allowedApps(): ComputerAllowedApp[] {
    return this.authorizer?.list() ?? [];
  }

  revokeApp(key: string): boolean {
    return this.authorizer?.revoke(key) ?? false;
  }

  /** 中止该 session 的 run（含排队中的），收尾后释放 VM；之后同 id 再调用会从空 VM 开始 */
  close(sessionId: string): void {
    this.authorizer?.forgetSession(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    for (const controller of state.active) controller.abort();
    void state.tail.then(() => disposeComputerGuestVm(state.guest));
  }

  /** worker 退出 / 应用退出：停下所有桌面操作，收尾合成焦点与 AX 打开声明 */
  closeAll(): void {
    this.feedback?.dispose?.();
    const tails = [...this.sessions.values()].map((state) => state.tail);
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId);
    const backend = this.backend;
    if (!backend?.releaseAll) return;
    // 先同步收尾一次（应用即将退出），run 全部落地后再收一次被它们重新激活的目标
    backend.releaseAll();
    void Promise.allSettled(tails).then(() => backend.releaseAll?.());
  }
}

export const computerHost = new ComputerHost(
  () => createDesktopBackend(),
  new ComputerOccupancy(createElectronOccupancyDeps()),
  {
    // 名单只在 macOS 后端生效（Windows 后端不提供 app 身份）
    authorizer: new AppAuthorizer({
      file: () => path.join(app.getPath('userData'), 'computer', 'allowed-apps.json'),
      prompt: promptComputerAppAccess,
    }),
    feedback: createVirtualCursor(),
  }
);
