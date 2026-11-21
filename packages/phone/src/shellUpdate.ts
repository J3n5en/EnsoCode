import { SHELL_VERSION_META } from './shellPrecache';

/**
 * 页面壳换新：导航先出 SW 缓存的壳（不等中继），新版由 SW 在后台装齐。
 * 本页若是旧版本缓存出来的，安全时机整页重载换上：还没起来（renderer 没拿到设置）就立即重载——
 * 旧壳配新桌面起不来时靠这条自愈；已在用就等下次回到前台，不打断操作。
 */

const CHECK_TIMEOUT_MS = 5000;
/** 常驻页面（iOS 很少真冷启动）回前台时多久查一次 sw.js 有没有新版 */
const UPDATE_EVERY_MS = 30 * 60_000;
const RELOADED_KEY = 'enso-shell-reloaded';

export type ShellReload = 'none' | 'now' | 'resume';

export function shellReloadDecision(s: {
  stale: boolean;
  /** 本页面会话里已经为同一个旧版本重载过：不再重载，防止循环 */
  alreadyReloaded: boolean;
  canReloadNow: boolean;
}): ShellReload {
  if (!s.stale || s.alreadyReloaded) return 'none';
  return s.canReloadNow ? 'now' : 'resume';
}

export function pageShellVersion(doc: Pick<Document, 'querySelector'>): string | null {
  const value = doc.querySelector(`meta[name="${SHELL_VERSION_META}"]`)?.getAttribute('content');
  return value && /^[0-9a-f]{8,64}$/.test(value) ? value : null;
}

interface ShellWorker {
  postMessage(message: unknown, transfer: MessagePort[]): void;
}

export interface ShellUpdateDeps {
  container: {
    readonly controller: ShellWorker | null;
    addEventListener(
      type: 'message' | 'controllerchange',
      listener: (event: MessageEvent) => void
    ): void;
    getRegistration(): Promise<{ update(): Promise<unknown> } | undefined>;
  };
  doc: Pick<Document, 'querySelector' | 'addEventListener' | 'visibilityState'>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  canReloadNow(): boolean;
  reload(): void;
  now?: () => number;
}

function ask(worker: ShellWorker, version: string): Promise<{ stale?: unknown } | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, CHECK_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data ?? null);
    };
    worker.postMessage({ type: 'shell-check', version }, [channel.port2]);
  });
}

export function watchShellUpdate(deps: ShellUpdateDeps): void {
  const version = pageShellVersion(deps.doc);
  if (!version) return;
  const now = deps.now ?? Date.now;
  let pending = false;
  let lastUpdate = now();
  const reload = () => {
    try {
      deps.storage.setItem(RELOADED_KEY, version);
    } catch {}
    deps.reload();
  };
  const check = async () => {
    const worker = deps.container.controller;
    if (!worker || pending) return;
    const reply = await ask(worker, version);
    let alreadyReloaded = false;
    try {
      alreadyReloaded = deps.storage.getItem(RELOADED_KEY) === version;
    } catch {}
    const action = shellReloadDecision({
      stale: reply?.stale === true,
      alreadyReloaded,
      canReloadNow: deps.canReloadNow(),
    });
    if (action === 'now') reload();
    else if (action === 'resume') pending = true;
  };
  deps.container.addEventListener('message', (event) => {
    if ((event.data as { type?: unknown } | null)?.type === 'shell-ready') void check();
  });
  // 新版 SW 接管：旧 SW 不认 shell-check，换了才问得到
  deps.container.addEventListener('controllerchange', () => void check());
  deps.doc.addEventListener('visibilitychange', () => {
    if (deps.doc.visibilityState !== 'visible') return;
    if (pending) {
      reload();
      return;
    }
    if (now() - lastUpdate < UPDATE_EVERY_MS) return;
    lastUpdate = now();
    void deps.container
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {});
  });
  void check();
}
