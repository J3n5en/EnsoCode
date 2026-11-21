import { withTimeout } from './launch';

interface Worker {
  readonly state?: string;
  postMessage(message: { type: string }, transfer: MessagePort[]): void;
}

export interface DeskWorkerRegistration {
  active: Worker | null;
  installing: unknown;
  waiting: unknown;
  update(): Promise<unknown>;
}

export interface DeskWorkerContainer {
  readonly controller: Worker | null;
  register(url: string): Promise<DeskWorkerRegistration>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

const STEP_MS = 1500;

/**
 * SW 需要能代理 /desk/* ：旧版 SW 没有 fetch 处理，先确保新版接管本页。
 * 已激活却没接管本页（注销后复活、强制刷新）时 activate 不会再触发，update() 也不会换 controller：
 * 直接让它 claim。controllerchange 监听要在 register 之前挂上，否则首次安装时可能错过。
 */
export async function ensureDeskWorker(
  sw: DeskWorkerContainer,
  onStage: (stage: string) => void
): Promise<void> {
  let changed = false;
  let wake: (() => void) | null = null;
  sw.addEventListener('controllerchange', () => {
    changed = true;
    wake?.();
  });
  const controllerChange = (ms: number) =>
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        wake = null;
        changed = false;
        resolve();
      };
      if (changed) {
        done();
        return;
      }
      timer = setTimeout(done, ms);
      wake = done;
    });
  onStage('注册 Service Worker');
  const registration = await withTimeout(sw.register('/sw.js'), STEP_MS * 4, null);
  if (!registration) throw new Error('service worker unavailable');
  onStage('等待 Service Worker 响应');
  const ask = (worker: Worker | null | undefined, type: string) =>
    new Promise<boolean>((resolve) => {
      if (!worker) {
        resolve(false);
        return;
      }
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        resolve(false);
      }, STEP_MS);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(event.data?.desk === 1);
      };
      worker.postMessage({ type }, [channel.port2]);
    });
  for (let attempt = 0; attempt < 4; attempt++) {
    if (sw.controller && (await ask(sw.controller, 'desk-ping'))) return;
    const active = registration.active;
    // 新版 SW 收到 desk-claim 会 clients.claim() 后回执；旧版不认，退回 update()
    if (!sw.controller && active?.state === 'activated' && (await ask(active, 'desk-claim'))) {
      await controllerChange(STEP_MS);
      continue;
    }
    if (!registration.installing && !registration.waiting)
      await withTimeout(registration.update(), STEP_MS * 2, undefined);
    await controllerChange(3000);
  }
  throw new Error('service worker unavailable');
}
