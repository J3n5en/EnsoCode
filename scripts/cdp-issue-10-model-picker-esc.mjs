#!/usr/bin/env node
/**
 * CDP check for issue #10: ModelPicker cascade Esc peels one level at a time.
 *
 * Covers:
 * - cascade Esc: submenu stays parent-open after first Esc, then full close
 * - search-mode Esc closes the entire picker
 * - outside click closes the entire picker (not one level)
 * - with a submenu open, focus stays on a menu item (not the search box)
 * - after full close: focus back on trigger, no leftover portal/backdrop
 *
 * Prerequisites: `pnpm dev` with remote-debugging-port 9222.
 * Usage: node scripts/cdp-issue-10-model-picker-esc.mjs
 */

const CDP_BASE = process.env.ENSO_CDP_URL ?? 'http://127.0.0.1:9222';
const ARTIFACT_DIR = process.env.ENSO_CDP_ARTIFACTS ?? '/opt/cursor/artifacts/screenshots';

async function waitForCdp(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${CDP_BASE}/json/version`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`CDP not reachable at ${CDP_BASE} after ${timeoutMs}ms`);
}

async function listTargets() {
  const res = await fetch(`${CDP_BASE}/json/list`);
  if (!res.ok) throw new Error(`json/list ${res.status}`);
  return res.json();
}

async function waitForPage(predicate, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pages = (await listTargets()).filter((t) => t.type === 'page');
    const hit = pages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for page target');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(JSON.stringify(msg.error)));
        else ok(msg.result);
      }
    });
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => {
        const id = nextId++;
        return new Promise((ok, fail) => {
          pending.set(id, { resolve: ok, reject: fail });
          ws.send(JSON.stringify({ id, method, params }));
        });
      };
      resolve({ ws, send });
    });
    ws.addEventListener('error', reject);
  });
}

async function evalExpr(send, expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(JSON.stringify(res.exceptionDetails, null, 2));
  }
  return res.result?.value;
}

async function screenshot(send, filename) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const dest = join(ARTIFACT_DIR, filename);
  await writeFile(dest, Buffer.from(data, 'base64'));
  return dest;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pressEscape(send) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
}

async function clickCss(send, selector) {
  const box = await evalExpr(
    send,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
}

async function hoverCss(send, selector) {
  const box = await evalExpr(
    send,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
}

const SNAPSHOT_JS = `(() => {
  const active = document.activeElement;
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (el.hasAttribute('hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const roots = [...document.querySelectorAll('[data-model-picker="root"]')];
  const subs = [...document.querySelectorAll('[data-model-picker="submenu"]')];
  const positioners = [
    ...document.querySelectorAll('[data-slot="menu-positioner"], [data-slot="menu-sub-positioner"]'),
  ];
  const menus = [...document.querySelectorAll('[role="menu"]')];
  const backdrops = [...document.querySelectorAll('[role="presentation"]')].filter((el) => {
    const style = getComputedStyle(el);
    return style.position === 'fixed' && visible(el);
  });
  const inMenuItem = Boolean(
    active?.closest?.('[data-slot="menu-item"], [data-slot="menu-sub-trigger"], [role="menuitem"]') ||
      (active?.closest?.('[role="menu"], [data-model-picker="root"], [data-model-picker="submenu"]') &&
        active?.getAttribute?.('data-model-picker') !== 'search')
  );
  return {
    root: roots.filter(visible).length,
    submenu: subs.filter(visible).length,
    positioners: positioners.filter(visible).length,
    menus: menus.filter(visible).length,
    backdrops: backdrops.length,
    active: {
      tag: active?.tagName ?? null,
      slot: active?.getAttribute?.('data-slot') ?? null,
      picker: active?.getAttribute?.('data-model-picker') ?? null,
      isSearch: active?.getAttribute?.('data-model-picker') === 'search',
      isTrigger: Boolean(active?.closest?.('[data-model-picker="trigger"]')),
      inMenuItem,
    },
  };
})()`;

async function snapshot(send) {
  return evalExpr(send, SNAPSHOT_JS);
}

async function waitSnapshot(send, predicate, label, timeoutMs = 4_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await snapshot(send);
    if (predicate(last)) return last;
    await sleep(80);
  }
  throw new Error(`${label}: timed out. last=${JSON.stringify(last)}`);
}

function noGhost(s) {
  return (
    s.root === 0 && s.submenu === 0 && s.positioners === 0 && s.menus === 0 && s.backdrops === 0
  );
}

async function seedApp(send) {
  return evalExpr(
    send,
    `(() => {
      const settings = window.__stores?.settings;
      const sessions = window.__stores?.sessions;
      if (!settings || !sessions) throw new Error('window.__stores missing');
      return new Promise((resolve) => {
        const finish = () => {
          settings.setState({ onboarded: true, language: 'en' });
          settings.getState().addProviders([
            {
              id: 'cdp-issue-10-alpha',
              name: 'Issue 10 Alpha',
              api: 'openai-completions',
              apiKey: 'sk-cdp-issue-10-a',
              baseUrl: 'https://cdp-issue-10-a.example/v1',
              enabled: true,
              models: [
                { id: 'alpha-one', label: 'Alpha One', enabled: true },
                { id: 'alpha-two', label: 'Alpha Two', enabled: true },
              ],
            },
            {
              id: 'cdp-issue-10-beta',
              name: 'Issue 10 Beta',
              api: 'anthropic-messages',
              apiKey: 'sk-cdp-issue-10-b',
              baseUrl: 'https://cdp-issue-10-b.example/v1',
              enabled: true,
              models: [
                { id: 'beta-one', label: 'Beta One', enabled: true },
                { id: 'beta-two', label: 'Beta Two', enabled: true },
              ],
            },
          ]);
          const project = settings.getState().addProject('/tmp/enso-cdp-issue-10');
          sessions.getState().newConversation(project.id);
          resolve({
            onboarded: settings.getState().onboarded,
            providers: settings.getState().providers.map((p) => p.name),
            activeId: sessions.getState().activeId,
          });
        };
        const waitBoth = () => {
          const settingsReady = settings.persist?.hasHydrated?.() ?? true;
          const sessionsReady = sessions.persist?.hasHydrated?.() ?? true;
          if (settingsReady && sessionsReady) finish();
          else setTimeout(waitBoth, 50);
        };
        waitBoth();
      });
    })()`
  );
}

async function openPicker(send) {
  let state = await snapshot(send);
  if (state.root >= 1 && !state.active.isSearch) return state;
  if (state.root >= 1) {
    await pressEscape(send);
    await waitSnapshot(send, (s) => s.root === 0, 'close leftover picker');
  }
  await clickCss(send, '[data-model-picker="trigger"]');
  state = await snapshot(send);
  if (state.root === 0) {
    await evalExpr(send, `document.querySelector('[data-model-picker="trigger"]')?.click()`);
  }
  return waitSnapshot(
    send,
    (s) => s.root >= 1 && !s.active.isSearch,
    'open picker without search focus'
  );
}

async function openSubmenu(send) {
  await hoverCss(send, '[data-slot="menu-sub-trigger"]');
  return waitSnapshot(send, (s) => s.root >= 1 && s.submenu >= 1, 'open submenu');
}

async function typeSearch(send, text) {
  await clickCss(send, '[data-model-picker="search"]');
  await evalExpr(
    send,
    `(() => {
      const input = document.querySelector('[data-model-picker="search"]');
      if (!input) throw new Error('search missing');
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      proto.set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return input.value;
    })()`
  );
}

async function clickOutside(send) {
  const point = await evalExpr(
    send,
    `(() => {
      const root = document.querySelector('[data-model-picker="root"]');
      if (!root) throw new Error('root menu missing');
      const r = root.getBoundingClientRect();
      return { x: Math.max(16, r.left - 40), y: Math.max(48, r.top - 40) };
    })()`
  );
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

async function main() {
  await waitForCdp();
  const mainTarget = await waitForPage(
    (p) => p.url.includes('index.html') || p.url.endsWith('/') || p.url.includes(':5173/')
  );
  const client = await connect(mainTarget.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const seed = await seedApp(client.send);
  await sleep(500);

  const assertions = {};
  const shots = {};

  // --- cascade Esc ---
  let state = await openPicker(client.send);
  assertions.openDoesNotStealSearchFocus =
    state.root >= 1 && !state.active.isSearch && state.active.inMenuItem;
  state = await openSubmenu(client.send);
  assertions.submenuFocusStaysOnMenuItem =
    state.submenu >= 1 && !state.active.isSearch && state.active.inMenuItem;
  shots.cascadeOpen = await screenshot(client.send, 'issue-10-cascade-open.png');

  await pressEscape(client.send);
  state = await waitSnapshot(
    client.send,
    (s) => s.root >= 1 && s.submenu === 0,
    'first Esc peels submenu only'
  );
  assertions.firstEscKeepsParent = state.root >= 1 && state.submenu === 0;
  shots.afterFirstEsc = await screenshot(client.send, 'issue-10-after-first-esc.png');

  await pressEscape(client.send);
  state = await waitSnapshot(client.send, noGhost, 'second Esc closes picker');
  await sleep(200);
  state = await snapshot(client.send);
  assertions.secondEscClosesAll = noGhost(state);
  assertions.focusReturnsToTriggerAfterCascade = state.active.isTrigger;
  assertions.noGhostAfterCascade = noGhost(state);
  shots.afterCascadeClose = await screenshot(client.send, 'issue-10-after-cascade-close.png');

  // --- search-mode Esc ---
  state = await openPicker(client.send);
  await typeSearch(client.send, 'Alpha');
  state = await waitSnapshot(
    client.send,
    (s) => s.root >= 1 && s.submenu === 0 && s.active.isSearch,
    'search mode'
  );
  assertions.searchModeHasNoSubmenu = state.root >= 1 && state.submenu === 0;
  shots.searchMode = await screenshot(client.send, 'issue-10-search-mode.png');
  await pressEscape(client.send);
  state = await waitSnapshot(client.send, noGhost, 'search Esc closes all');
  await sleep(200);
  state = await snapshot(client.send);
  assertions.searchEscClosesAll = noGhost(state);
  assertions.focusReturnsToTriggerAfterSearch = state.active.isTrigger;
  assertions.noGhostAfterSearch = noGhost(state);

  // --- outside click ---
  state = await openPicker(client.send);
  state = await openSubmenu(client.send);
  assertions.outsideClickStartedWithSubmenu = state.root >= 1 && state.submenu >= 1;
  shots.beforeOutsideClick = await screenshot(client.send, 'issue-10-before-outside-click.png');
  await clickOutside(client.send);
  state = await waitSnapshot(client.send, noGhost, 'outside click closes all');
  await sleep(200);
  state = await snapshot(client.send);
  assertions.outsideClickClosesAll = noGhost(state);
  assertions.noGhostAfterOutsideClick = noGhost(state);
  shots.afterOutsideClick = await screenshot(client.send, 'issue-10-after-outside-click.png');

  const report = { seed, assertions, screenshots: shots };
  const failed = Object.entries(assertions).filter(([, ok]) => !ok);
  console.log(JSON.stringify(report, null, 2));
  client.ws.close();
  if (failed.length) {
    throw new Error(`CDP assertions failed: ${failed.map(([k]) => k).join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
