import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => {}) },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  screen: { getAllDisplays: () => [] },
  app: { getName: () => 'EnsoCode', getLocale: () => 'en' },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  BrowserWindow: class {
    setBounds() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setContentProtection() {}
    showInactive() {}
    hide() {}
    isDestroyed() {
      return false;
    }
    loadURL() {}
  },
  clipboard: { readText: () => '', writeText: () => {} },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    isTrustedAccessibilityClient: vi.fn(() => true),
  },
  utilityProcess: {
    fork: () => ({
      postMessage: () => {},
      kill: () => true,
      on: () => {},
      once: () => {},
    }),
  },
}));

vi.mock('./computer/axWorkerThread?modulePath', () => ({ default: '/tmp/ax-worker.js' }));

vi.mock('./computer/screenCaptureAccess', () => ({
  requestScreenCaptureAccess: vi.fn(async () => false),
}));

vi.mock('./computer/macPrivacySettings', () => ({
  openMacPrivacySettings: vi.fn(async () => {}),
}));

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopCapturer, systemPreferences } from 'electron';
import { AppAuthorizer } from './computer/appAuthorization';
import { FakeDesktopBackend } from './computer/fakeBackend';
import { openMacPrivacySettings } from './computer/macPrivacySettings';
import { ComputerOccupancy } from './computer/occupancy';
import { ComputerHost } from './computerHost';

describe('ComputerHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('run 执行 guest，frames 在同会话后续调用里仍在', async () => {
    const backend = new FakeDesktopBackend();
    const host = new ComputerHost(() => backend);
    await host.invoke('s1', 'run', {
      code: 'const win = await desktop.window("w1"); await win.screenshot();',
    });
    await host.invoke('s1', 'run', {
      code: 'const win = await desktop.window("w1"); await win.click(10, 5);',
    });
    expect(backend.clicks).toHaveLength(1);
    host.close('s1');
    await expect(
      host.invoke('s1', 'run', {
        code: 'const win = await desktop.window("w1"); await win.click(10, 5);',
      })
    ).rejects.toThrow(/screenshot/);
  });

  it('同一 session 跨 invoke 复用 backend，ax ref 仍可点', async () => {
    let created = 0;
    const host = new ComputerHost(() => {
      created += 1;
      return new FakeDesktopBackend();
    });
    const first = await host.invoke('s1', 'run', {
      code: 'const win = await desktop.window("w1"); return await win.ax();',
    });
    expect(String(first.returnValue ?? first.text)).toMatch(/\[ref=e1\]/);
    await expect(
      host.invoke('s1', 'run', {
        code: 'const win = await desktop.window("w1"); const el = await win.ref("e1"); await el.click(); return "ok";',
      })
    ).resolves.toMatchObject({ returnValue: 'ok' });
    expect(created).toBe(1);
  });

  it('同一 session 跨 invoke 保留 JS 堆', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    await host.invoke('s1', 'run', { code: 'globalThis.mark = 7; return mark' });
    const second = await host.invoke('s1', 'run', { code: 'return globalThis.mark' });
    expect(second.returnValue).toBe(7);
    host.close('s1');
  });

  it('缺 code 拒绝', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    await expect(host.invoke('s1', 'run', {})).rejects.toThrow(/code/);
  });

  it('打开辅助功能设置不弹阻塞 TCC', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    await host.openPermissionSettings('accessibility');
    expect(systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(openMacPrivacySettings).toHaveBeenCalledWith('accessibility');
  });

  it('打开屏幕录制设置不阻塞在截屏 TCC', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    await host.openPermissionSettings('screen');
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
    expect(openMacPrivacySettings).toHaveBeenCalledWith('screen');
  });

  it('非只读占用桌面，Esc 中止等待', async () => {
    const events: string[] = [];
    let esc = () => {};
    const occupancy = new ComputerOccupancy({
      show: () => events.push('show'),
      hide: () => events.push('hide'),
      registerEsc: (handler) => {
        esc = handler;
        return () => {};
      },
      pollMs: 0,
    });
    const host = new ComputerHost(() => new FakeDesktopBackend(), occupancy);
    const pending = host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.raise(); await wait(8000); return 1',
      timeout: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    esc();
    await expect(pending).rejects.toThrow(/took over/);
    expect(events).toEqual(['show', 'hide']);
  });

  it('只做截图/后台操作不占用桌面，前台输入时才占用', async () => {
    const events: string[] = [];
    const occupancy = new ComputerOccupancy({
      show: () => events.push('show'),
      hide: () => events.push('hide'),
      registerEsc: () => () => {},
      pollMs: 0,
    });
    const host = new ComputerHost(() => new FakeDesktopBackend(), occupancy);
    await host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.screenshot(); await w.click(1, 1, { delivery: "background" })',
    });
    expect(events).toEqual([]);
    await host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.press("Enter")',
    });
    expect(events).toEqual([]);
    await host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.press("Enter", { delivery: "foreground" })',
    });
    expect(events).toEqual(['show', 'hide']);
  });

  it('read_only 不占用桌面', async () => {
    const events: string[] = [];
    const occupancy = new ComputerOccupancy({
      show: () => events.push('show'),
      hide: () => events.push('hide'),
      registerEsc: () => () => {},
      pollMs: 0,
    });
    const host = new ComputerHost(() => new FakeDesktopBackend(), occupancy);
    await host.invoke('s1', 'run', {
      code: 'return 1',
      read_only: true,
    });
    expect(events).toEqual([]);
  });

  it('worker 发来的 read_only 线格式在 Main 真正生效', async () => {
    const backend = new FakeDesktopBackend();
    const host = new ComputerHost(() => backend);
    await expect(
      host.invoke('s1', 'run', {
        code: 'const win = await desktop.window("w1"); await win.screenshot(); await win.click(1, 1)',
        read_only: true,
        timeout: 5,
      })
    ).rejects.toThrow(/read-only/);
    expect(backend.clicks).toHaveLength(0);
  });

  it('外部 signal 中止正在跑的 run', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    const controller = new AbortController();
    const pending = host.invoke('s1', 'run', { code: 'await wait(8000)' }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/abort/);
  });

  it('同一 session 新 run 先中止并等旧 run 收尾', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    const first = host.invoke('s1', 'run', { code: 'await wait(8000); return 1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = host.invoke('s1', 'run', { code: 'return 2' });
    await expect(first).rejects.toThrow(/abort/);
    await expect(second).resolves.toMatchObject({ returnValue: 2 });
  });

  const twoApps = () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList = [
      { ...backend.windowsList[0] },
      { id: 'w2', app: 'Notes', title: 'n', pid: 2, x: 0, y: 0, width: 200, height: 100 },
    ];
    return backend;
  };
  const clickThenWait = (id: string, label: string, ms: number) =>
    `const w = await desktop.window("${id}"); await w.screenshot(); await w.click(1, 1); await wait(${ms}); return "${label}"`;

  it('同一 app 串行：后来的 session 等前一个 run 结束才拿到该 app', async () => {
    const host = new ComputerHost(twoApps);
    const order: string[] = [];
    const a = host
      .invoke('a', 'run', { code: clickThenWait('w1', 'a', 80) })
      .then((r) => order.push(String(r.returnValue)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = host
      .invoke('b', 'run', { code: clickThenWait('w1', 'b', 0) })
      .then((r) => order.push(String(r.returnValue)));
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('不同 app 并行；不碰任何 app 的 run 不排队', async () => {
    const host = new ComputerHost(twoApps);
    const order: string[] = [];
    const a = host
      .invoke('a', 'run', { code: clickThenWait('w1', 'a', 120) })
      .then((r) => order.push(String(r.returnValue)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = host
      .invoke('b', 'run', { code: clickThenWait('w2', 'b', 0) })
      .then((r) => order.push(String(r.returnValue)));
    const c = host
      .invoke('c', 'run', { code: 'return "c"' })
      .then((r) => order.push(String(r.returnValue)));
    await Promise.all([a, b, c]);
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
  });

  it('前台接管全局互斥：不同 app 的前台输入也串行', async () => {
    const host = new ComputerHost(twoApps);
    const order: string[] = [];
    const fg = (id: string, label: string, ms: number) =>
      `const w = await desktop.window("${id}"); await w.press("a", { delivery: "foreground" }); await wait(${ms}); return "${label}"`;
    const a = host
      .invoke('a', 'run', { code: fg('w1', 'a', 80) })
      .then((r) => order.push(String(r.returnValue)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = host
      .invoke('b', 'run', { code: fg('w2', 'b', 0) })
      .then((r) => order.push(String(r.returnValue)));
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('等租约超时给出明确错误并带上 app 名', async () => {
    const host = new ComputerHost(twoApps, undefined, { leaseWaitMs: 30 });
    const a = host.invoke('a', 'run', { code: clickThenWait('w1', 'a', 300) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(host.invoke('b', 'run', { code: clickThenWait('w1', 'b', 0) })).rejects.toThrow(
      /another session is using Safari/i
    );
    await a;
  });

  it('app 授权被拒：动作不投递，错误回给模型', async () => {
    const backend = new FakeDesktopBackend();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'enso-host-')), 'apps.json');
    const prompts: string[] = [];
    const host = new ComputerHost(() => backend, undefined, {
      authorizer: new AppAuthorizer({
        file,
        prompt: async (app) => {
          prompts.push(app.bundleId);
          return 'deny';
        },
      }),
    });
    await expect(
      host.invoke('s1', 'run', {
        code: 'const w = await desktop.window("w1"); await w.screenshot(); await w.click(1, 1)',
      })
    ).rejects.toThrow(/not allowed computer control of Safari/);
    expect(backend.clicks).toHaveLength(0);
    expect(prompts).toEqual(['test.safari']);
    // 截图与 AX 读取不需要授权
    await expect(
      host.invoke('s1', 'run', {
        code: 'const w = await desktop.window("w1"); await w.screenshot(); return 1',
      })
    ).resolves.toMatchObject({ returnValue: 1 });
  });

  it('desktop 级前台输入同样要授权实际收到输入的 app，并锁住它', async () => {
    const backend = new FakeDesktopBackend();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'enso-host-')), 'apps.json');
    const prompts: string[] = [];
    const host = new ComputerHost(() => backend, undefined, {
      authorizer: new AppAuthorizer({
        file,
        prompt: async (app) => {
          prompts.push(app.bundleId);
          return 'deny';
        },
      }),
    });
    await expect(
      host.invoke('s1', 'run', {
        code: 'await desktop.press("cmd+v", { delivery: "foreground" })',
      })
    ).rejects.toThrow(/not allowed computer control of Safari/);
    expect(prompts).toEqual(['test.safari']);
    expect(backend.inputs).toEqual([]);
  });

  it('desktop 级前台输入无法判断目标 app 时拒绝，而不是放行', async () => {
    const backend = new FakeDesktopBackend();
    backend.desktopInputApp = null;
    const host = new ComputerHost(() => backend);
    await expect(
      host.invoke('s1', 'run', {
        code: 'await desktop.type("x", { delivery: "foreground" })',
      })
    ).rejects.toThrow(/which app/);
    expect(backend.inputs).toEqual([]);
  });

  it('拿不到 app 身份的窗口与 AX 写操作仍按窗口/全局加锁', async () => {
    const backend = new FakeDesktopBackend();
    backend.appIdentities = false;
    const host = new ComputerHost(() => backend, undefined, { leaseWaitMs: 30 });
    const a = host.invoke('a', 'run', {
      code: 'const w = await desktop.window("w1"); await w.screenshot(); await w.click(1, 1); await wait(200)',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      host.invoke('b', 'run', {
        code: 'const w = await desktop.window("w1"); await w.screenshot(); await w.click(1, 1)',
      })
    ).rejects.toThrow(/another session/i);
    await a;
  });

  it('始终允许后名单可列出与撤销', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'enso-host-')), 'apps.json');
    const host = new ComputerHost(() => new FakeDesktopBackend(), undefined, {
      authorizer: new AppAuthorizer({ file, prompt: async () => 'always' }),
    });
    await host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.screenshot(); await w.click(1, 1)',
    });
    expect(host.allowedApps().map((app) => app.bundleId)).toEqual(['test.safari']);
    expect(host.revokeApp('test.safari')).toBe(true);
    expect(host.allowedApps()).toEqual([]);
  });

  it('closeAll 收尾后端的合成焦点', async () => {
    const backend = new FakeDesktopBackend();
    const host = new ComputerHost(() => backend);
    await host.invoke('s1', 'run', { code: 'return 1' });
    host.closeAll();
    expect(backend.releasedAll).toBeGreaterThan(0);
  });

  it('closeAll 中止所有 run 并释放 VM', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    await host.invoke('s1', 'run', { code: 'globalThis.mark = 1' });
    const pending = host.invoke('s2', 'run', { code: 'await wait(8000)' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.closeAll();
    await expect(pending).rejects.toThrow(/abort/);
    const after = await host.invoke('s1', 'run', { code: 'return typeof globalThis.mark' });
    expect(after.returnValue).toBe('undefined');
  });

  it('同 session 连续三次调用：前两次被中止，只有最后一次执行', async () => {
    const host = new ComputerHost(() => new FakeDesktopBackend());
    const first = host.invoke('s1', 'run', { code: 'await wait(8000); return 1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = host.invoke('s1', 'run', { code: 'return 2' });
    const third = host.invoke('s1', 'run', { code: 'return 3' });
    await expect(first).rejects.toThrow(/abort/);
    await expect(second).rejects.toThrow(/abort/);
    await expect(third).resolves.toMatchObject({ returnValue: 3 });
  });

  it('排队中的 run 遇到 close 不再执行', async () => {
    const backend = new FakeDesktopBackend();
    const host = new ComputerHost(() => backend);
    const first = host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.screenshot(); await wait(8000)',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = host.invoke('s1', 'run', {
      code: 'const w = await desktop.window("w1"); await w.screenshot(); await w.click(1, 1)',
    });
    host.close('s1');
    await expect(first).rejects.toThrow(/abort/);
    await expect(queued).rejects.toThrow(/abort|closed/);
    expect(backend.clicks).toHaveLength(0);
  });
});
