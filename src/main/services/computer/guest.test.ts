import { describe, expect, it } from 'vitest';
import { withAxErrors } from './axErrors';
import { AX_WORKER_EXITED } from './axWorkerClient';
import { FakeDesktopBackend } from './fakeBackend';
import {
  COMPUTER_MAX_SCREENSHOTS_PER_RUN,
  createComputerGuestSession,
  runComputerGuest,
} from './guest';

async function run(code: string, opts: { readOnly?: boolean; backend?: FakeDesktopBackend } = {}) {
  const backend = opts.backend ?? new FakeDesktopBackend();
  const result = await runComputerGuest({
    code,
    readOnly: opts.readOnly === true,
    timeoutMs: 10_000,
    backend,
    session: createComputerGuestSession(),
    settleMs: 0,
  });
  return { result, backend };
}

describe('runComputerGuest', () => {
  it('列出窗口并返回值', async () => {
    const { result } = await run(`return await desktop.windows({ app: 'Safari' })`);
    expect(result.returnValue).toEqual([
      expect.objectContaining({ id: 'w1', app: 'Safari', title: 'Settings' }),
    ]);
  });

  it('read_only 拦截 click，允许 ax', async () => {
    await expect(
      run(`const win = await desktop.window({ app: 'Safari' }); await win.click(1, 1)`, {
        readOnly: true,
      })
    ).rejects.toThrow(/read-only/);
    const { result } = await run(`const win = await desktop.window('w1'); return await win.ax()`, {
      readOnly: true,
    });
    expect(String(result.returnValue)).toMatch(/\[ref=e/);
  });

  it('截图后才能点，坐标按缩放映回源尺寸', async () => {
    const backend = new FakeDesktopBackend();
    const { result } = await run(
      `
        const win = await desktop.window('w1');
        await win.screenshot();
        return await win.click(10, 5);
      `,
      { backend }
    );
    expect(backend.clicks[0]).toEqual({
      target: 'w1',
      x: 20,
      y: 10,
      delivery: 'background',
    });
    expect(result.returnValue).toMatchObject({ clickSpace: 'w1', x: 10, y: 5 });
  });

  it('未截图就 click 抛 FrameError', async () => {
    await expect(
      run(`const win = await desktop.window('w1'); await win.click(1, 1)`)
    ).rejects.toThrow(/screenshot/);
  });

  it('assert 失败、clipboard 写', async () => {
    await expect(run(`assert(false, 'nope')`)).rejects.toThrow(/nope/);
    const written = await run(
      `await desktop.clipboard.write('hi'); return await desktop.clipboard.read()`,
      {
        backend: new FakeDesktopBackend(),
      }
    );
    expect(written.result.returnValue).toBe('hi');
  });

  it('windows() 元素带 ax/raise，focused 是 focusedWindow 别名', async () => {
    const { result } = await run(`
      const wins = await desktop.windows();
      const focused = await desktop.focused();
      return {
        ax: typeof wins[0].ax,
        raise: typeof wins[0].raise,
        focusedId: focused.id,
        focusedAx: typeof focused.ax,
      };
    `);
    expect(result.returnValue).toEqual({
      ax: 'function',
      raise: 'function',
      focusedId: 'w1',
      focusedAx: 'function',
    });
  });

  it('window("Safari") 按 app 匹配，同 app 多窗口取 focused', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList.push({
      id: 'w2',
      app: 'Safari',
      title: 'Other',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    const { result } = await run(`return (await desktop.window('Safari')).id`, { backend });
    expect(result.returnValue).toBe('w1');
  });

  it('WeChat 别名命中微信', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList = [
      {
        id: 'wx',
        app: '微信',
        title: '微信',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ];
    const { result } = await run(`return (await desktop.window({ app: 'WeChat' })).id`, {
      backend,
    });
    expect(result.returnValue).toBe('wx');
  });

  it('空 AX 树说明不可用，而不是空字符串', async () => {
    const backend = new FakeDesktopBackend();
    backend.axSnapshot = async () => [];
    const { result } = await run(`const win = await desktop.window('w1'); return await win.ax()`, {
      backend,
      readOnly: true,
    });
    expect(String(result.returnValue)).toMatch(/ax-empty/);
  });

  it('AX 超时返回 ax-timeout，而不是一直挂起', async () => {
    const backend = new FakeDesktopBackend();
    backend.axSnapshot = async () => {
      throw new Error('AX_TIMEOUT');
    };
    const { result } = await run(`const win = await desktop.window('w1'); return await win.ax()`, {
      backend,
      readOnly: true,
    });
    expect(String(result.returnValue)).toMatch(/timeout/);
  });

  it('AX worker 退出时 ax() 返回说明，而不是整次 run 失败', async () => {
    const backend = new FakeDesktopBackend();
    backend.axSnapshot = async () => {
      throw new Error('AX_WORKER_EXITED');
    };
    const { result } = await run(`const win = await desktop.window('w1'); return await win.ax()`, {
      backend,
      readOnly: true,
    });
    expect(String(result.returnValue)).toMatch(/worker-exited/);
  });

  it('getState 在 AX worker 退出时仍返回截图', async () => {
    const backend = new FakeDesktopBackend();
    backend.axSnapshot = async () => {
      throw new Error('AX_WORKER_EXITED');
    };
    const { result } = await run(
      `const win = await desktop.window('w1'); return await win.getState()`,
      { backend, readOnly: true }
    );
    expect(result.returnValue).toMatchObject({ width: 100, height: 50, target: 'w1' });
    expect(String((result.returnValue as { ax: string }).ax)).toMatch(/worker-exited/);
    expect(result.screenshots).toHaveLength(1);
  });

  it('后端已翻译成 ax-worker-exited 时 getState 同样软失败', async () => {
    const backend = new FakeDesktopBackend();
    backend.axSnapshot = () => withAxErrors(() => Promise.reject(new Error(AX_WORKER_EXITED)));
    const { result } = await run(
      `const win = await desktop.window('w1'); return await win.getState()`,
      { backend, readOnly: true }
    );
    expect(String((result.returnValue as { ax: string }).ax)).toMatch(/worker-exited/);
    expect(result.screenshots).toHaveLength(1);
  });

  it('clipboard 是对象，raise 后 window() 的 focused 仍为 true', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList[0] = { ...backend.windowsList[0], focused: false };
    const { result } = await run(
      `
      await desktop.clipboard.write('hi');
      await desktop.clipboard().write('via-call');
      const win = await desktop.window('w1');
      const raised = await win.raise();
      const again = await desktop.window('w1');
      await win.screenshot();
      const clicked = await win.click(10, 5);
      const typed = await win.type('你好');
      const scrolled = await win.scroll(10, 5, { dy: 40 });
      const scrolledPos = await win.scroll(10, 5, 0, 24);
      const pressed = await win.press('Escape');
      return {
        clipType: typeof desktop.clipboard,
        read: await desktop.clipboard().read(),
        focused: raised.focused,
        againFocused: again.focused,
        clicked,
        typed,
        scrolled,
        scrolledPos,
        pressed,
      };
    `,
      { backend }
    );
    expect(result.returnValue).toMatchObject({
      clipType: 'function',
      read: 'via-call',
      focused: true,
      againFocused: true,
      clicked: expect.objectContaining({
        ok: true,
        x: 10,
        y: 5,
        delivery: 'background',
        pixelsChanged: expect.any(Boolean),
      }),
      typed: expect.objectContaining({ ok: true, chars: 2 }),
      scrolled: expect.objectContaining({ ok: true, dy: 40, pixelsChanged: expect.any(Boolean) }),
      scrolledPos: expect.objectContaining({ ok: true, dx: 0, dy: 24 }),
      pressed: expect.objectContaining({ ok: true, keys: ['Escape'] }),
    });
  });

  it('silent 截图 metadata 带 scale', async () => {
    const { result } = await run(
      `const win = await desktop.window('w1'); return await win.screenshot({ silent: true })`
    );
    expect(result.returnValue).toMatchObject({
      width: 100,
      height: 50,
      sourceWidth: 200,
      sourceHeight: 100,
      scale: 2,
      target: 'w1',
    });
    expect(result.screenshots).toEqual([]);
  });

  it('click/axClick 后自动 settle，ax 和 screenshot 不会', async () => {
    const sleeps: number[] = [];
    const backend = new FakeDesktopBackend();
    await runComputerGuest({
      code: `
        const win = await desktop.window('w1');
        await win.ax();
        await win.screenshot();
        await win.click(10, 5);
        const el = await win.ref('e1');
        await el.click();
      `,
      readOnly: false,
      timeoutMs: 10_000,
      backend,
      session: createComputerGuestSession(),
      settleMs: 400,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([400, 400]);
  });

  it('getState 一次返回 AX 文本和截图', async () => {
    const { result } = await run(
      `const win = await desktop.window('w1'); return await win.getState()`
    );
    expect(result.returnValue).toMatchObject({
      width: 100,
      height: 50,
      scale: 2,
      target: 'w1',
    });
    expect(String((result.returnValue as { ax: string }).ax)).toMatch(/\[ref=e/);
    expect(result.screenshots).toHaveLength(1);
  });

  it('getState 并行截图和 AX', async () => {
    const backend = new FakeDesktopBackend();
    const order: string[] = [];
    const capture = backend.capture.bind(backend);
    const axSnapshot = backend.axSnapshot.bind(backend);
    backend.capture = async (...args) => {
      order.push('cap-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('cap-end');
      return capture(...args);
    };
    backend.axSnapshot = async (...args) => {
      order.push('ax-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('ax-end');
      return axSnapshot(...args);
    };
    await run(`const win = await desktop.window('w1'); return await win.getState()`, { backend });
    expect(order.indexOf('ax-start')).toBeLessThan(order.indexOf('cap-end'));
    expect(order.indexOf('cap-start')).toBeLessThan(order.indexOf('ax-end'));
  });

  it('desktop.app 已有窗口不 launch', async () => {
    const backend = new FakeDesktopBackend();
    const { result } = await run(`return (await desktop.app('Safari')).id`, { backend });
    expect(result.returnValue).toBe('w1');
    expect(backend.launches).toEqual([]);
  });

  it('desktop.app 没有窗口则 launch 再返回', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList = [];
    const { result } = await run(`return (await desktop.app('Finder')).id`, { backend });
    expect(result.returnValue).toBe('launched');
    expect(backend.launches).toEqual(['Finder']);
  });

  it('desktop.app pane 传给 launchApp', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList = [];
    await run(`await desktop.app('系统设置', { pane: '外观' })`, { backend });
    expect(backend.launches).toEqual(['系统设置']);
    expect(backend.panes).toEqual(['外观']);
  });

  it('鉴权框停手，不再继续点', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList = [
      {
        id: 'auth',
        app: '系统设置',
        title: '锁屏正在尝试修改系统设置',
        pid: 1,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        focused: true,
      },
    ];
    await expect(
      run(
        `
          const win = await desktop.window('auth');
          await win.screenshot();
          await win.click(10, 5);
        `,
        { backend }
      )
    ).rejects.toThrow(/Touch ID, a password/);
  });

  it('read_only 下 app 只解析已有窗口', async () => {
    const { result } = await run(`return (await desktop.app('Safari')).id`, { readOnly: true });
    expect(result.returnValue).toBe('w1');
    const backend = new FakeDesktopBackend();
    backend.windowsList = [];
    await expect(run(`await desktop.app('Finder')`, { readOnly: true, backend })).rejects.toThrow(
      /read-only/
    );
  });

  it('wait 可被 abort 打断', async () => {
    const ac = new AbortController();
    const pending = runComputerGuest({
      code: 'await wait(8000); return 1',
      readOnly: false,
      timeoutMs: 10_000,
      backend: new FakeDesktopBackend(),
      session: createComputerGuestSession(),
      settleMs: 0,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toThrow(/abort/);
  });

  it('ax 默认整树（带新 ref）；显式 diff 时结构相同则 unchanged', async () => {
    const session = createComputerGuestSession();
    const backend = new FakeDesktopBackend();
    const once = (code: string) =>
      runComputerGuest({
        code,
        readOnly: false,
        timeoutMs: 10_000,
        backend,
        session,
        settleMs: 0,
      });
    const first = await once('const win = await desktop.window("w1"); return await win.ax()');
    expect(String(first.returnValue)).toMatch(/\[ref=e/);
    const second = await once('const win = await desktop.window("w1"); return await win.ax()');
    expect(String(second.returnValue)).toMatch(/\[ref=e/);
    const third = await once(
      'const win = await desktop.window("w1"); return await win.ax({ diff: true })'
    );
    expect(String(third.returnValue)).toBe('(ax unchanged)');
  });

  it('find description 深色不必整树', async () => {
    const { result } = await run(`
      const win = await desktop.window('w1');
      const hits = await win.find({ description: '深色' });
      return hits[0]?.description;
    `);
    expect(result.returnValue).toBe('深色');
  });

  it('find 返回数组，await ref 后可操作元素', async () => {
    const { result } = await run(`
      const win = await desktop.window('w1');
      const hits = await win.find({ description: '深色' });
      assert(Array.isArray(hits) && hits.length === 1, 'Expected one match');
      const el = await win.ref(hits[0].ref);
      return [el.description, typeof el.click, typeof el.setValue];
    `);
    expect(result.returnValue).toEqual(['深色', 'function', 'function']);
  });

  it('find description 也能命中 title=浅色', async () => {
    const { result } = await run(`
      const win = await desktop.window('w1');
      const hits = await win.find({ description: '浅色' });
      return hits[0]?.title;
    `);
    expect(result.returnValue).toBe('浅色');
  });
});

describe('runComputerGuest 生命周期', () => {
  const base = (session = createComputerGuestSession(), backend = new FakeDesktopBackend()) => ({
    readOnly: false,
    backend,
    session,
    settleMs: 0,
    persistVm: true,
  });

  it('timeout 是墙钟预算，宿主调用耗时也计入', async () => {
    const started = Date.now();
    await expect(
      runComputerGuest({
        ...base(),
        code: 'for (;;) await wait(50);',
        timeoutMs: 200,
      })
    ).rejects.toThrow(/exceeded/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('await 永不 resolve 的 Promise 立即失败，不空转', async () => {
    await expect(
      runComputerGuest({
        ...base(),
        code: 'await new Promise(() => {}); return 1',
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/never resolves/);
  });

  it('宿主调用卡住时 abort 立即返回', async () => {
    const backend = new FakeDesktopBackend();
    backend.windows = () => new Promise(() => {});
    const controller = new AbortController();
    const pending = runComputerGuest({
      ...base(createComputerGuestSession(), backend),
      code: 'await desktop.windows(); return 1',
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/abort/);
  });

  it('被中止的 run 之后同一 session 仍可继续执行', async () => {
    const session = createComputerGuestSession();
    await expect(
      runComputerGuest({ ...base(session), code: 'for (;;) await wait(20);', timeoutMs: 100 })
    ).rejects.toThrow(/exceeded/);
    await expect(
      runComputerGuest({ ...base(session), code: 'return 5', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ returnValue: 5 });
  });

  it('read_only 跑在一次性 VM，改不到后续可写 run 的全局', async () => {
    const session = createComputerGuestSession();
    await runComputerGuest({ ...base(session), code: 'globalThis.mark = 7', timeoutMs: 1_000 });
    await runComputerGuest({
      ...base(session),
      readOnly: true,
      code: 'globalThis.mark = 9; globalThis.desktop = null',
      timeoutMs: 1_000,
    });
    const after = await runComputerGuest({
      ...base(session),
      code: 'return [globalThis.mark, typeof desktop.windows]',
      timeoutMs: 1_000,
    });
    expect(after.returnValue).toEqual([7, 'function']);
  });

  it('普通声明局限于单次调用，只有显式全局可跨可写调用保留', async () => {
    const session = createComputerGuestSession();
    await runComputerGuest({
      ...base(session),
      code: 'var localWindow = await desktop.window("w1"); globalThis.savedWindow = localWindow;',
      timeoutMs: 1_000,
    });
    const next = await runComputerGuest({
      ...base(session),
      code: 'return [typeof localWindow, savedWindow.id];',
      timeoutMs: 1_000,
    });
    expect(next.returnValue).toEqual(['undefined', 'w1']);
    const inspection = await runComputerGuest({
      ...base(session),
      readOnly: true,
      code: 'return typeof globalThis.savedWindow;',
      timeoutMs: 1_000,
    });
    expect(inspection.returnValue).toBe('undefined');
  });

  it('只读可读元素属性，但不能读剪贴板', async () => {
    const { result } = await run(
      `const win = await desktop.window('w1'); await win.ax(); const el = await win.ref('e1'); return [await el.attributes(), await el.actions(), (await el.children()).length]`,
      { readOnly: true }
    );
    expect(result.returnValue).toBeDefined();
    await expect(run('return await desktop.clipboard.read()', { readOnly: true })).rejects.toThrow(
      /read-only/
    );
  });

  it('鉴权框出现时，键盘输入在送达前就拒绝', async () => {
    const backend = new FakeDesktopBackend();
    backend.windowsList = [
      ...backend.windowsList,
      {
        id: 'auth',
        app: 'SecurityAgent',
        title: 'System Settings is trying to modify system settings',
        pid: 9,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
    ];
    const typed: string[] = [];
    backend.typeText = (async (_target: string, text: string) => {
      typed.push(text);
    }) as typeof backend.typeText;
    await expect(
      run(`const win = await desktop.window('w1'); await win.type('secret')`, { backend })
    ).rejects.toThrow(/Touch ID, a password/);
    expect(typed).toEqual([]);
  });

  it('单次 run 只回最近几张截图，并说明省略数量', async () => {
    const { result } = await run(
      `const win = await desktop.window('w1'); for (let i = 0; i < 9; i++) await win.screenshot(); return 'ok'`
    );
    expect(result.screenshots).toHaveLength(COMPUTER_MAX_SCREENSHOTS_PER_RUN);
    expect(result.text).toMatch(/5 earlier screenshots omitted/);
  });

  it('超长返回文本截断', async () => {
    const { result } = await run(`return 'x'.repeat(200000)`);
    expect(result.text.length).toBeLessThan(40_000);
    expect(result.text).toMatch(/truncated/);
  });

  it('用过前台输入的 run 结束（含超时）都会调 backend.endRun；纯后台 run 不去恢复别人的前台状态', async () => {
    const backend = new FakeDesktopBackend();
    let ended = 0;
    backend.endRun = async () => {
      ended += 1;
    };
    await run('return 1', { backend });
    await run(`const w = await desktop.window('w1'); await w.type('x')`, { backend });
    expect(ended).toBe(0);
    await run(
      `const w = await desktop.window('w1'); await w.type('x', { delivery: 'foreground' })`,
      {
        backend,
      }
    );
    expect(ended).toBe(1);
    await expect(
      runComputerGuest({
        code: `const w = await desktop.window('w1'); await w.press('a', { delivery: 'foreground' }); for (;;) await wait(20);`,
        readOnly: false,
        timeoutMs: 60,
        backend,
        session: createComputerGuestSession(),
        settleMs: 0,
      })
    ).rejects.toThrow(/exceeded/);
    expect(ended).toBe(2);
  });
});

describe('投递方式与桌面接管', () => {
  const tracker = () => {
    const calls: string[] = [];
    return {
      calls,
      beginSynthetic: () => {
        calls.push('begin');
      },
      endSynthetic: () => {
        calls.push('end');
      },
    };
  };
  const runWith = (code: string, backend: FakeDesktopBackend, occupancy = tracker()) =>
    runComputerGuest({
      code,
      readOnly: false,
      timeoutMs: 10_000,
      backend,
      session: createComputerGuestSession(),
      settleMs: 0,
      occupancy,
    });
  const script = `
    const w = await desktop.window('w1');
    await w.screenshot();
    const click = await w.click(1, 1);
    const typed = await w.type('hi');
    const pressed = await w.press('Enter');
    return [click.delivery, typed.delivery, pressed.delivery];
  `;

  it('支持后台投递时缺省走后台，不接管桌面；显式 foreground 才接管', async () => {
    const backend = new FakeDesktopBackend();
    const occupancy = tracker();
    const result = await runWith(script, backend, occupancy);
    expect(result.returnValue).toEqual(['background', 'background', 'background']);
    expect(occupancy.calls).toEqual([]);
    expect(backend.raised).toEqual([]);
    const loud = tracker();
    await runWith(
      `const w = await desktop.window('w1'); await w.screenshot(); return (await w.click(1, 1, { delivery: 'foreground' })).delivery`,
      backend,
      loud
    );
    expect(backend.clicks.at(-1)?.delivery).toBe('foreground');
    expect(loud.calls).toEqual(['begin', 'end']);
  });

  it('平台不支持后台投递时缺省前台接管；显式 background 不接管', async () => {
    const backend = new FakeDesktopBackend();
    backend.backgroundInput = false;
    const occupancy = tracker();
    const result = await runWith(script, backend, occupancy);
    expect(result.returnValue).toEqual(['foreground', 'foreground', 'foreground']);
    expect(occupancy.calls).toEqual(['begin', 'end', 'begin', 'end', 'begin', 'end']);
    const quiet = tracker();
    await runWith(
      `const w = await desktop.window('w1'); await w.screenshot(); return (await w.click(1, 1, { delivery: 'background' })).delivery`,
      backend,
      quiet
    );
    expect(backend.clicks.at(-1)?.delivery).toBe('background');
    expect(quiet.calls).toEqual([]);
  });

  it('动作前先经宿主授权/加锁：窗口动作带 target 与投递方式，AX 写操作带 ref', async () => {
    const backend = new FakeDesktopBackend();
    const requests: unknown[] = [];
    await runComputerGuest({
      code: `const w = await desktop.window('w1'); await w.screenshot(); await w.click(1, 1); await w.type('x', { delivery: 'foreground' }); const [el] = await w.find({ title: 'Save' }); await el.setValue('v'); await el.press();`,
      readOnly: false,
      timeoutMs: 10_000,
      backend,
      session: createComputerGuestSession(),
      settleMs: 0,
      access: async (request) => {
        requests.push(request);
      },
    });
    expect(requests).toEqual([
      { target: 'w1', delivery: 'background' },
      { target: 'w1', delivery: 'foreground' },
      { ref: expect.stringMatching(/^e\d+$/), delivery: 'background' },
      { ref: expect.stringMatching(/^e\d+$/), delivery: 'background' },
    ]);
  });

  it('等授权/等租约的时间不计入 run 预算', async () => {
    const backend = new FakeDesktopBackend();
    const result = await runComputerGuest({
      code: `const w = await desktop.window('w1'); await w.type('x'); return 'done'`,
      readOnly: false,
      timeoutMs: 80,
      backend,
      session: createComputerGuestSession(),
      settleMs: 0,
      access: () => new Promise((resolve) => setTimeout(resolve, 200)),
    });
    expect(result.returnValue).toBe('done');
  });

  it('授权被拒时动作不投递', async () => {
    const backend = new FakeDesktopBackend();
    await expect(
      runComputerGuest({
        code: `const w = await desktop.window('w1'); await w.type('secret')`,
        readOnly: false,
        timeoutMs: 10_000,
        backend,
        session: createComputerGuestSession(),
        settleMs: 0,
        access: async () => {
          throw new Error('The user has not allowed computer control of Safari');
        },
      })
    ).rejects.toThrow(/not allowed/);
    expect(backend.inputs).toEqual([]);
  });

  it('后台指针动作给出可视反馈，前台与键盘不给', async () => {
    const backend = new FakeDesktopBackend();
    const pointers: string[] = [];
    await runComputerGuest({
      code: `const w = await desktop.window('w1'); await w.screenshot(); await w.click(10, 5); await w.scroll(10, 5, 0, 3); await w.type('x'); await w.click(10, 5, { delivery: 'foreground' });`,
      readOnly: false,
      timeoutMs: 10_000,
      backend,
      session: createComputerGuestSession(),
      settleMs: 0,
      feedback: {
        pointer: (input) => {
          pointers.push(`${input.action}@${input.screenX},${input.screenY}`);
        },
      },
    });
    expect(pointers).toEqual(['click@20,10', 'scroll@20,10']);
  });

  it('前台输入前先把目标窗口提到最前；已在最前则不动', async () => {
    const backend = new FakeDesktopBackend();
    backend.backgroundInput = false;
    backend.windowsList[0] = { ...backend.windowsList[0], focused: false };
    await runWith(
      `const w = await desktop.window('w1'); await w.press('cmd+a'); await w.type('x')`,
      backend
    );
    expect(backend.raised).toEqual(['w1']);
    expect(backend.inputs.map((item) => item.method)).toEqual(['press', 'type']);
  });

  it('目标窗口提不到最前时不发送输入，免得打进用户正在用的 App', async () => {
    const backend = new FakeDesktopBackend();
    backend.backgroundInput = false;
    backend.windowsList[0] = { ...backend.windowsList[0], focused: false };
    backend.raiseFails = true;
    await expect(
      runWith(`const w = await desktop.window('w1'); await w.type('secret')`, backend)
    ).rejects.toThrow(/could not be brought to the front/);
    expect(backend.inputs).toEqual([]);
  });

  it('raise 会抢前台，算接管', async () => {
    const occupancy = tracker();
    await runWith(
      `const w = await desktop.window('w1'); await w.raise()`,
      new FakeDesktopBackend(),
      occupancy
    );
    expect(occupancy.calls).toEqual(['begin', 'end']);
  });
});

describe('被遮挡窗口的截图', () => {
  it('窗口整体被前面的窗口盖住时提示截图可能过期', async () => {
    const backend = new FakeDesktopBackend();
    const w1 = backend.windowsList[0];
    backend.windowsList = [
      { id: 'cover', app: 'Other', title: '', x: -10, y: -10, width: 5000, height: 5000 },
      { ...w1, focused: false },
    ];
    const { result } = await run(
      `const w = await desktop.window('w1'); return await w.screenshot({ silent: true })`,
      { backend }
    );
    expect(result.returnValue).toMatchObject({ hidden: expect.stringMatching(/stale/) });
    const visible = await run(
      `const w = await desktop.window('w1'); return await w.screenshot({ silent: true })`
    );
    expect(visible.result.returnValue).not.toHaveProperty('hidden');
  });
});
