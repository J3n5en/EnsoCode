#!/usr/bin/env node
// 模型中心「拉取全部模型」验收：点一次按钮，所有条目都换成上游清单并落盘。
// 前置（隔离 userData，不碰真实账号）：
//   node .agents/skills/enso-cdp/scripts/mk-env.mjs /tmp/enso-fetchall 3
//   node scripts/fake-provider-issue-27.mjs &
//   ENSO_USER_DATA_DIR=/tmp/enso-fetchall ENSO_CDP_PORT=9333 pnpm dev
// 用法：ENSO_CDP_PORT=9333 node scripts/verify-fetch-all-models.mjs
import assert from 'node:assert/strict';

const CDP_BASE = `http://127.0.0.1:${process.env.ENSO_CDP_PORT?.trim() || '9222'}`;
const EXPECTED_MODELS = 2;

async function waitForCdp(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${CDP_BASE}/json/version`)).ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`CDP 不可达：${CDP_BASE}`);
}

async function waitForPage(predicate, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pages = (await (await fetch(`${CDP_BASE}/json/list`)).json()).filter(
      (t) => t.type === 'page'
    );
    const hit = pages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('等待页面目标超时');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
    ws.addEventListener('open', () => {
      resolve({
        send: (method, params = {}) => {
          const id = nextId++;
          return new Promise((ok, fail) => {
            pending.set(id, { resolve: ok, reject: fail });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
      });
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
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails, null, 2));
  return res.result?.value;
}

async function waitFor(send, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalExpr(send, expression)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待超时：${expression}`);
}

const readRows = `(() =>
  [...document.querySelectorAll('[data-settings-row^="providers."]')]
    .filter((row) => row.getAttribute('data-settings-row') !== 'providers.root')
    .map((row) => ({
      id: row.getAttribute('data-settings-row'),
      text: row.innerText.replace(/\\s+/g, ' ').trim(),
    }))
)()`;

async function main() {
  await waitForCdp();
  const mainPage = await waitForPage((p) => p.url.includes('index.html'));
  const main = await connect(mainPage.webSocketDebuggerUrl);
  await main.send('Runtime.enable');
  await evalExpr(main.send, 'window.electronAPI.window.openSettings()');

  const settingsPage = await waitForPage((p) => p.url.includes('settings.html'));
  const settings = await connect(settingsPage.webSocketDebuggerUrl);
  await settings.send('Runtime.enable');
  await settings.send('Page.enable');

  const navFound = `[...document.querySelectorAll('button')].some((el) => el.textContent.trim() === '模型中心')`;
  await waitFor(settings.send, navFound);
  await evalExpr(
    settings.send,
    `(() => {
      const nav = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '模型中心');
      if (!nav) throw new Error('模型中心 导航未找到');
      nav.click();
      return true;
    })()`
  );
  await waitFor(
    settings.send,
    `document.querySelectorAll('[data-settings-row^="providers."]').length > 1`
  );

  const before = await evalExpr(settings.send, readRows);
  assert.ok(before.length >= 2, `期望至少 2 个条目，实际 ${before.length}`);
  for (const row of before) {
    assert.ok(
      row.text.includes(`${EXPECTED_MODELS - 1} 个模型`),
      `${row.id} 拉取前应只有 ${EXPECTED_MODELS - 1} 个模型：${row.text}`
    );
  }

  const clicked = await evalExpr(
    settings.send,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '拉取全部模型');
      if (!button) throw new Error('拉取全部模型 按钮未找到');
      button.click();
      return true;
    })()`
  );
  assert.equal(clicked, true);

  const deadline = Date.now() + 30_000;
  let after = [];
  while (Date.now() < deadline) {
    after = await evalExpr(settings.send, readRows);
    const done = after.every((row) => row.text.includes(`${EXPECTED_MODELS} 个模型`));
    const failed = after.some((row) => row.text.includes('拉取失败'));
    if (done || failed) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const row of after) {
    assert.ok(!row.text.includes('拉取失败'), `${row.id} 拉取失败：${row.text}`);
    assert.ok(
      row.text.includes(`${EXPECTED_MODELS} 个模型`),
      `${row.id} 拉取后应有 ${EXPECTED_MODELS} 个模型：${row.text}`
    );
  }

  const readPersisted = `(async () => {
    const data = await window.electronAPI.settings.read();
    const providers = data?.['enso-settings']?.state?.providers ?? [];
    return providers.map((p) => ({ id: p.id, models: (p.models ?? []).map((m) => m.id) }));
  })()`;
  const persistDeadline = Date.now() + 15_000;
  let persisted = [];
  while (Date.now() < persistDeadline) {
    persisted = await evalExpr(settings.send, readPersisted);
    if (persisted.every((provider) => provider.models.includes('fake-model-2'))) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const provider of persisted) {
    assert.ok(
      provider.models.includes('fake-model-2'),
      `${provider.id} 的新模型没有落进 settings：${JSON.stringify(provider.models)}`
    );
  }

  console.table(after.map((row) => ({ row: row.id, text: row.text })));
  console.log(`ok: ${after.length} 个条目全部拉取到 ${EXPECTED_MODELS} 个模型并落盘`);
  process.exit(0);
}

await main();
