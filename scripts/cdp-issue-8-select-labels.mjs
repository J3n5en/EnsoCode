#!/usr/bin/env node
/**
 * CDP check for issue #8: McpEditDialog / ProviderEditDialog Select triggers
 * must show mapped labels, not raw values.
 *
 * Prerequisites: `pnpm dev` with remote-debugging-port 9222.
 * Usage: node scripts/cdp-issue-8-select-labels.mjs
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
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const dest = join(ARTIFACT_DIR, filename);
  await import('node:fs/promises').then((fs) => fs.writeFile(dest, Buffer.from(data, 'base64')));
  return dest;
}

async function main() {
  await waitForCdp();
  const mainTarget = await waitForPage(
    (p) => p.url.includes('index.html') || p.url.endsWith('/') || p.url.includes(':5173/')
  );
  const main = await connect(mainTarget.webSocketDebuggerUrl);
  await main.send('Runtime.enable');
  await main.send('Page.enable');

  await evalExpr(
    main.send,
    `(() => {
      const settings = window.__stores?.settings;
      if (!settings) throw new Error('window.__stores.settings missing');
      return new Promise((resolve) => {
        const finish = () => {
          settings.setState({ onboarded: true, language: 'en' });
          settings.getState().addMcpServers([{
            id: 'cdp-issue-8-mcp',
            name: 'Issue 8 MCP',
            transport: 'http',
            url: 'https://example.com/mcp',
            source: 'Manual',
            enabled: true,
          }]);
          settings.getState().addProviders([{
            id: 'cdp-issue-8-provider',
            name: 'Issue 8 Probe',
            api: 'anthropic-messages',
            apiKey: '',
            baseUrl: '',
            enabled: true,
            models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4', enabled: true }],
          }]);
          resolve({
            language: settings.getState().language,
            mcp: settings.getState().mcpServers.map((s) => s.name),
            providers: settings.getState().providers.map((p) => p.name),
          });
        };
        if (settings.persist?.hasHydrated?.()) finish();
        else settings.persist?.onFinishHydration?.(finish) ?? finish();
      });
    })()`
  );

  await evalExpr(main.send, `window.electronAPI.window.openSettings()`);
  const settingsTarget = await waitForPage((p) => p.url.includes('settings.html'));
  const settings = await connect(settingsTarget.webSocketDebuggerUrl);
  await settings.send('Runtime.enable');
  await settings.send('Page.enable');
  await new Promise((r) => setTimeout(r, 800));

  const clickNav = (label) =>
    evalExpr(
      settings.send,
      `(() => {
        const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(label)});
        if (!btn) throw new Error('nav not found: ${label}');
        btn.click();
        return btn.textContent.trim();
      })()`
    );

  const openRowEdit = (rowName) =>
    evalExpr(
      settings.send,
      `(() => {
        const row = [...document.querySelectorAll('div.group')].find((el) =>
          (el.textContent || '').includes(${JSON.stringify(rowName)})
        );
        if (!row) throw new Error('row not found: ${rowName}');
        const edit = row.querySelector('button');
        const buttons = [...row.querySelectorAll('button')];
        const pencil = buttons.find((b) => b.querySelector('svg')) ?? buttons[1] ?? buttons[0];
        if (!pencil) throw new Error('edit button missing for ${rowName}');
        pencil.click();
        return true;
      })()`
    );

  const readDialogSelects = () =>
    evalExpr(
      settings.send,
      `(() => {
        const dialog = document.querySelector('[role="dialog"], [data-slot="dialog-content"]')
          ?? document.querySelector('[data-slot="dialog"]')
          ?? document.body;
        const triggers = [...document.querySelectorAll('[data-slot="select-trigger"]')];
        return triggers.map((el) => ({
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(),
          valueSlot: (el.querySelector('[data-slot="select-value"]')?.textContent || '').trim(),
        }));
      })()`
    );

  const closeDialog = () =>
    evalExpr(
      settings.send,
      `(() => {
        const cancel = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Cancel');
        if (cancel) cancel.click();
        return Boolean(cancel);
      })()`
    );

  await clickNav('MCP Servers');
  await new Promise((r) => setTimeout(r, 300));
  await openRowEdit('Issue 8 MCP');
  await new Promise((r) => setTimeout(r, 400));
  const mcpSelects = await readDialogSelects();
  const mcpShot = await screenshot(settings.send, 'issue-8-mcp-edit-dialog.png');

  await closeDialog();
  await new Promise((r) => setTimeout(r, 300));

  await clickNav('Model Providers');
  await new Promise((r) => setTimeout(r, 300));
  await openRowEdit('Issue 8 Probe');
  await new Promise((r) => setTimeout(r, 400));
  const providerSelects = await readDialogSelects();
  const providerShot = await screenshot(settings.send, 'issue-8-provider-edit-dialog.png');

  const report = {
    mcpSelects,
    providerSelects,
    screenshots: { mcpShot, providerShot },
    assertions: {
      mcpTransportIsHttp: mcpSelects.some((s) => s.valueSlot === 'http' || s.text.includes('http')),
      apiTypeIsAnthropic: providerSelects.some((s) =>
        (s.valueSlot === 'Anthropic' || s.text.includes('Anthropic')) &&
        !s.valueSlot.includes('anthropic-messages')
      ),
      testModelIsFriendlyLabel: providerSelects.some((s) =>
        (s.valueSlot === 'Claude Sonnet 4' || s.text.includes('Claude Sonnet 4')) &&
        !s.valueSlot.includes('claude-sonnet-4')
      ),
    },
  };

  const failed = Object.entries(report.assertions).filter(([, ok]) => !ok);
  console.log(JSON.stringify(report, null, 2));
  main.ws.close();
  settings.ws.close();
  if (failed.length) {
    throw new Error(`CDP assertions failed: ${failed.map(([k]) => k).join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
