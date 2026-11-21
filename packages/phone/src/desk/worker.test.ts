import { describe, expect, it } from 'vitest';
import { type DeskWorkerContainer, type DeskWorkerRegistration, ensureDeskWorker } from './worker';

type Fake = { state: string; postMessage(message: { type: string }, ports: MessagePort[]): void };

function setup() {
  const listeners: (() => void)[] = [];
  const sent: string[] = [];
  let updates = 0;
  const container = {
    controller: null as Fake | null,
    addEventListener: (_: 'controllerchange', l: () => void) => void listeners.push(l),
  };
  const takeOver = (worker: Fake) => {
    container.controller = worker;
    for (const l of listeners) l();
  };
  /** 新版 SW：认 desk-ping / desk-claim */
  const fresh: Fake = {
    state: 'activated',
    postMessage(message, [port]) {
      sent.push(message.type);
      if (message.type === 'desk-claim') takeOver(fresh);
      port.postMessage({ desk: 1 });
    },
  };
  /** 旧版 SW：没有消息处理 */
  const stale: Fake = {
    state: 'activated',
    postMessage(message) {
      sent.push(`stale:${message.type}`);
    },
  };
  const registration: DeskWorkerRegistration = {
    active: fresh,
    installing: null,
    waiting: null,
    update: async () => {
      updates++;
      registration.active = fresh;
      setTimeout(() => takeOver(fresh), 50);
    },
  };
  const sw = {
    get controller() {
      return container.controller;
    },
    register: async () => registration,
    addEventListener: container.addEventListener,
  } satisfies DeskWorkerContainer;
  return {
    sw,
    sent,
    registration,
    fresh,
    stale,
    takeOver,
    setController: (w: Fake) => {
      container.controller = w;
    },
    updates: () => updates,
  };
}

describe('ensureDeskWorker', () => {
  it('已激活但没接管本页：直接让 SW claim，不再干等 update', async () => {
    const t = setup();
    const started = Date.now();
    await ensureDeskWorker(t.sw, () => {});
    expect(Date.now() - started).toBeLessThan(500);
    expect(t.sent).toEqual(['desk-claim', 'desk-ping']);
    expect(t.updates()).toBe(0);
  });

  it('已接管且是新版：一次 ping 即可', async () => {
    const t = setup();
    t.setController(t.registration.active as Fake);
    await ensureDeskWorker(t.sw, () => {});
    expect(t.sent).toEqual(['desk-ping']);
  });

  it('旧版 SW 在接管：ping 不回就 update，等到新版接管', async () => {
    const t = setup();
    t.setController(t.stale);
    t.registration.active = t.stale;
    const stages: string[] = [];
    await ensureDeskWorker(t.sw, (stage) => stages.push(stage));
    expect(t.updates()).toBe(1);
    expect(t.sent).toEqual(['stale:desk-ping', 'desk-ping']);
    expect(stages).toEqual(['注册 Service Worker', '等待 Service Worker 响应']);
  });

  it('首次安装中：不调 update，等 activate 时的接管', async () => {
    const t = setup();
    t.registration.active = null;
    t.registration.installing = {};
    setTimeout(() => {
      t.registration.installing = null;
      t.registration.active = t.fresh;
      // activate 里 clients.claim() 触发 controllerchange
      t.takeOver(t.fresh);
    }, 20);
    const started = Date.now();
    await ensureDeskWorker(t.sw, () => {});
    expect(t.updates()).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('controllerchange 早于等待发生也不会错过', async () => {
    const t = setup();
    t.registration.active = null;
    // update() 返回前新版就已接管：旧实现在 update 之后才挂监听，会干等 3s
    t.registration.update = async () => {
      t.takeOver(t.fresh);
    };
    const started = Date.now();
    await ensureDeskWorker(t.sw, () => {});
    expect(Date.now() - started).toBeLessThan(500);
  });
});
