// 秘书只读工具的 Main 事件循环阻塞基准。隔离 userData 与 HOME、fake provider，不碰真实数据与账号。
//
//   VITE_ENSO_EXPOSE_STORES=1 pnpm build   # 先构建一次 out/（不计入基准的 3 分钟）
//   node scripts/bench-secretary-tools-main.mjs [--label x] [--json out.json] [--keep] [--profile]
//
// 规模按真实用户造：约 900 个会话（settings.json 约 1.6MB）、40 个项目、1 个挂 25 个 worktree 的大仓库、
// 3 个约 30MB 的会话 jsonl（session_read / session_activity / session_stats 各读一个，保证都是冷读）。
// 实例用 `electron --inspect=<port> .` 跑 out/ 产物，经 Main 的 V8 inspector 挂 5ms 间隔的事件循环探针：
// 相邻两次回调的间隔减去 5ms 即 Main 被占住的时长。每个工具由秘书会话真实调用一次（fake provider 回 tool_use），
// 记录从发送到工具结果回到界面期间 Main 的最长阻塞；control 行是不带工具的一轮，作为对话本身的底噪。
// --profile 额外采 Main 的 CPU profile，列出每段 >50ms 连续忙碌里包含耗时最高的函数。
// 全程 3 分钟硬超时；结束、失败、Ctrl-C 都会杀掉本次进程树并删掉临时目录（--keep 保留目录）。

import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { uiElementElectron } from './verify-electron.mjs';
import { mergeOwnedPids, ownedProcessGroups } from './verify-secretary-isolation.mjs';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const PROFILE = argv.includes('--profile');
const ROOT = path.resolve(import.meta.dirname, '..');
const LABEL = flag('--label') ?? 'run';
const JSON_OUT = flag('--json');
const HARD_TIMEOUT_MS = 180_000;
const PROBE_MS = 5;

const PROJECTS = 40;
const BIG_WORKTREES = 25;
const CONVERSATIONS = 900;
const DISPATCHED = 400;
const BIG_SESSION_TURNS = 1400;

const children = [];
const trackedPids = [];
let artDir = null;
let logTail = '';
let finishing = null;

function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}

const log = (line) => console.log(line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  const detail = last instanceof Error ? last.message : JSON.stringify(last);
  throw new Error(`等待超时 ${label}${detail ? `: ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function ports(count) {
  const picked = new Set();
  while (picked.size < count) {
    const port = await freePort();
    if (port !== 9222 && port !== 9229) picked.add(port);
  }
  return [...picked];
}

function listProcesses() {
  const listed = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  return listed.stdout.split('\n').flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return pid && ppid && pgid ? [{ pid, ppid, pgid }] : [];
  });
}

function rememberOwned() {
  const processes = listProcesses();
  const roots = children.flatMap((child) => (Number.isInteger(child.pid) ? [child.pid] : []));
  const owned = mergeOwnedPids(trackedPids, processes, roots);
  trackedPids.length = 0;
  trackedPids.push(...owned);
  return { processes, owned };
}

function signalOwned(signal) {
  const { processes, owned } = rememberOwned();
  const selfGroup = processes.find((proc) => proc.pid === process.pid)?.pgid;
  for (const pgid of ownedProcessGroups(processes, owned)) {
    if (pgid === selfGroup) continue;
    try {
      process.kill(-pgid, signal);
    } catch {}
  }
  for (const pid of owned) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf);
    if (chunks.length > 400) chunks.shift();
    logTail = Buffer.concat(chunks).toString('utf8').slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push(child);
  return child;
}

// ---------------------------------------------------------------- 假数据

/** 异步跑 git：造数据期间信号与硬超时仍能及时处理 */
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(stdout)
    );
  });
}

/** 大仓库取本仓库 src/shared 的一份快照（几百个文件），25 个 worktree 一半分支已合进 main */
async function makeBigRepo(repo, worktreeRoot) {
  mkdirSync(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  const archive = spawnSync('git', ['archive', 'HEAD', 'src/shared'], {
    cwd: ROOT,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(`git archive 失败 ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', repo], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar 失败 ${untar.stderr}`);
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'snapshot');
  for (let i = 0; i < 40; i += 1) {
    writeFileSync(path.join(repo, `CHANGELOG-${i % 4}.md`), `entry ${i}\n`.repeat(i + 1));
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', `chore: history ${i}`, '--allow-empty');
  }
  // 主检出带一份没进 git 的 node_modules：session_create(worktree) 会把它播种进新 worktree
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  for (let pkg = 0; pkg < 40; pkg += 1) {
    const dir = path.join(repo, 'node_modules', `pkg-${pkg}`, 'lib');
    mkdirSync(dir, { recursive: true });
    for (let file = 0; file < 10; file += 1)
      writeFileSync(path.join(dir, `m${file}.js`), `module.exports = ${pkg * file};\n`);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'chore: ignore deps');
  for (let i = 0; i < BIG_WORKTREES; i += 1) {
    const branch = `feat/bench-${String(i).padStart(2, '0')}`;
    await git(repo, 'branch', branch, 'main');
    const target = path.join(worktreeRoot, `wt-big-${i}`, 'checkout');
    mkdirSync(path.dirname(target), { recursive: true });
    await git(repo, 'worktree', 'add', '-q', target, branch);
    writeFileSync(path.join(target, `NOTE-${i}.md`), `work ${i}\n`);
    await git(target, 'add', '-A');
    await git(target, 'commit', '-qm', `feat: work ${i}`);
    // 一部分留未提交改动，一部分分支合进 main
    if (i % 3 === 0) writeFileSync(path.join(target, `dirty-${i}.ts`), 'export {};\n');
    if (i % 2 === 0) await git(repo, 'merge', '-q', '--no-edit', '--no-ff', branch);
  }
}

async function makeSmallRepo(repo, worktreeRoot, index) {
  mkdirSync(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(path.join(repo, `file-${i}.txt`), `repo ${index} rev ${i}\n`);
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', `rev ${i}`);
  }
  await git(repo, 'branch', 'feat/side', 'main');
  const target = path.join(worktreeRoot, `wt-small-${index}`, 'checkout');
  mkdirSync(path.dirname(target), { recursive: true });
  await git(repo, 'worktree', 'add', '-q', target, 'feat/side');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

const PERSISTED_ROW_BASE = {
  messages: [],
  commands: [],
  customEntries: [],
  dispatchMainEvents: {},
  lastSeq: 0,
  spawning: false,
  started: false,
  status: 'idle',
  toolOutputs: {},
  toolStartedAt: {},
  toolDeadlineAt: {},
  toolEnded: {},
  toolTodos: {},
  pendingApprovals: [],
  pendingAsks: [],
  backgroundTasks: [],
  subagents: [],
};

const LOREM =
  '会话里来回讨论了实现方案、测试与回归，这一段只是为了把消息撑到真实大小。The quick brown fox jumps over the lazy dog. ';

/** pi v3 会话：header + 按 parentId 串起的 user / assistant(toolCall) / toolResult */
function sessionJsonl(id, cwd, turns, bulk) {
  const lines = [];
  const t0 = Date.now() - turns * 60_000;
  lines.push({ type: 'session', version: 3, id, timestamp: iso(t0), cwd });
  let parent = null;
  let n = 0;
  const push = (message, at) => {
    n += 1;
    const entryId = `e${n.toString(16).padStart(8, '0')}`;
    lines.push({ type: 'message', id: entryId, parentId: parent, timestamp: iso(at), message });
    parent = entryId;
  };
  for (let turn = 0; turn < turns; turn += 1) {
    const at = t0 + turn * 60_000;
    push(
      { role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮：${LOREM}` }], timestamp: at },
      at
    );
    const callId = `call_${turn}`;
    push(
      {
        role: 'assistant',
        content: [
          { type: 'text', text: LOREM.repeat(bulk ? 6 : 1) },
          {
            type: 'toolCall',
            id: callId,
            name: 'bash',
            arguments: { command: `rg -n foo src/${turn}` },
          },
        ],
        api: 'anthropic-messages',
        provider: 'pv-A',
        model: 'fake-model-1',
        usage: {
          input: 1200,
          output: 300,
          cacheRead: 800,
          cacheWrite: 0,
          totalTokens: 2300,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: at + 1000,
      },
      at + 1000
    );
    push(
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'bash',
        content: [{ type: 'text', text: `src/${turn}.ts:1: ${LOREM}`.repeat(bulk ? 120 : 2) }],
        isError: false,
        timestamp: at + 2000,
      },
      at + 2000
    );
    push(
      {
        role: 'assistant',
        content: [{ type: 'text', text: `第 ${turn} 轮结论。${LOREM}` }],
        api: 'anthropic-messages',
        provider: 'pv-A',
        model: 'fake-model-1',
        usage: {
          input: 1500,
          output: 120,
          cacheRead: 1000,
          cacheWrite: 0,
          totalTokens: 2620,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: at + 3000,
      },
      at + 3000
    );
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

async function buildFixture(fakePort) {
  const userData = path.join(artDir, 'user-data');
  const home = path.join(artDir, 'home');
  // 派发 worktree 落在应用托管根 userData/worktrees：cleanup_list 只认它和 ~/project/worktree，
  // 不改 HOME（改了 macOS keychain 解密会卡住启动），也就不往用户真实的 ~/project/worktree 里写东西
  const worktreeRoot = path.join(userData, 'worktrees');
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(path.join(home, 'gh'), { recursive: true });

  const repos = Array.from({ length: PROJECTS }, (_, i) =>
    path.join(home, 'repos', `p${String(i).padStart(2, '0')}`)
  );
  const small = repos.slice(1);
  const workers = Array.from({ length: 6 }, async () => {
    for (let repo = small.shift(); repo; repo = small.shift())
      await makeSmallRepo(repo, worktreeRoot, repos.indexOf(repo));
  });
  await Promise.all([makeBigRepo(repos[0], worktreeRoot), ...workers]);
  const projects = repos.map((repo) => ({
    id: randomUUID(),
    name: path.basename(repo),
    path: realpathSync(repo),
  }));

  const sessionDir = path.join(userData, 'agent', 'sessions', '--bench--');
  mkdirSync(sessionDir, { recursive: true });
  const now = Date.now();
  const conversations = {};
  const dispatched = {};
  const secretaryConversationId = randomUUID();
  const big = [];
  for (let i = 0; i < CONVERSATIONS; i += 1) {
    const id = randomUUID();
    const project = projects[i < 300 ? 0 : i % PROJECTS];
    const lastActiveAt = now - i * 3_600_000;
    const archived = i >= 120 && i % 10 !== 0;
    const bigSession = i < 3;
    const file = path.join(sessionDir, `${String(i).padStart(4, '0')}_${id}.jsonl`);
    writeFileSync(
      file,
      sessionJsonl(id, project.path, bigSession ? BIG_SESSION_TURNS : 2, bigSession)
    );
    if (bigSession) big.push(id);
    const row = {
      // 与 renderer persistOne 落盘的形状一致：运行态容器都是空的
      ...PERSISTED_ROW_BASE,
      id,
      projectId: project.id,
      title: `会话 ${i}：排查 ${project.name} 的某个问题并修复`,
      createdAt: lastActiveAt - 7_200_000,
      lastActiveAt,
      sessionFile: realpathSync(file),
      lastProviderId: 'pv-A',
      lastModelId: 'fake-model-1',
      summary: LOREM.repeat(9),
      ...(archived ? { archived: true, archivedAt: lastActiveAt + 60_000 } : {}),
      ...(i % 4 === 0 ? { goal: { text: `把第 ${i} 号问题修好并开 PR`, status: 'complete' } } : {}),
      ...(i < DISPATCHED ? { secretaryOrigin: { secretaryConversationId } } : {}),
    };
    conversations[id] = row;
    if (i < DISPATCHED) {
      dispatched[id] = {
        conversationId: id,
        projectId: project.id,
        secretaryConversationId,
        createdAt: row.createdAt,
        turn: 3,
        lastState: 'idle',
        lastEventAt: lastActiveAt,
        goal: `把第 ${i} 号问题修好并开 PR，${LOREM}`,
        lastText: LOREM.repeat(4),
        goalResult: { at: lastActiveAt, result: { summary: `完成 ${i}。${LOREM}` } },
        ...(archived ? { autoArchivedAt: row.archivedAt } : {}),
      };
    }
  }

  const state = {
    providers: [
      {
        id: 'pv-A',
        name: 'Provider A',
        api: 'anthropic-messages',
        apiKey: 'sk-fake-A',
        baseUrl: `http://127.0.0.1:${fakePort}`,
        enabled: true,
        models: [{ id: 'fake-model-1' }],
      },
    ],
    defaultModel: { providerId: 'pv-A', modelId: 'fake-model-1' },
    onboarded: true,
    theme: 'system',
    language: 'zh-CN',
    titleSummaryEnabled: false,
    secretaryEnabled: true,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
    })),
  };
  const settings = {
    'enso-settings': { state, version: 18 },
    'enso-conversations': {
      state: { conversations, order: Object.keys(conversations), activeId: null },
      version: 0,
    },
  };
  const settingsText = JSON.stringify(settings);
  writeFileSync(path.join(userData, 'settings.json'), settingsText);
  const secretaryDir = path.join(userData, 'secretary');
  mkdirSync(secretaryDir, { recursive: true });
  const dispatchText = JSON.stringify({
    version: 1,
    dispatched,
    named: [],
    proposals: {},
    outbox: [],
  });
  writeFileSync(path.join(secretaryDir, 'dispatch.json'), dispatchText);
  return {
    home,
    userData,
    bigProject: projects[0],
    big,
    sizes: { settings: Buffer.byteLength(settingsText), dispatch: Buffer.byteLength(dispatchText) },
  };
}

// ---------------------------------------------------------------- CDP

class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`ws 连接失败 ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const done = message.id && this.pending.get(message.id);
      if (!done) return;
      this.pending.delete(message.id);
      done(message);
    };
    ws.onclose = () => {
      for (const done of this.pending.values()) done({ error: { message: 'CDP socket closed' } });
      this.pending.clear();
    };
  }

  send(method, params = {}, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error(`CDP 已关闭 ${method}`));
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} 超时`));
      }, timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result ?? {});
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeout = 30_000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeout
    ).catch((error) => {
      throw new Error(`${error.message}: ${expression.replace(/\s+/g, ' ').slice(0, 120)}`);
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'evaluate 失败'
      );
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function rendererPage(cdpPort) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = list.find(
    (entry) => entry.type === 'page' && String(entry.url).includes('index.html')
  );
  if (!target?.webSocketDebuggerUrl) return null;
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return cdp;
}

async function mainInspector(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'node') ?? list[0];
  if (!target?.webSocketDebuggerUrl) return null;
  return Cdp.open(target.webSocketDebuggerUrl);
}

/** Main 里的事件循环探针：5ms 一跳，记录每段超出间隔的延迟 */
const PROBE = `(() => {
  if (globalThis.__benchLag) return true;
  const lag = { last: performance.now(), max: 0, gaps: [] };
  lag.reset = () => { lag.max = 0; lag.gaps = []; lag.last = performance.now(); };
  setInterval(() => {
    const now = performance.now();
    const over = now - lag.last - ${PROBE_MS};
    if (over > lag.max) lag.max = over;
    if (over > 20) lag.gaps.push([Math.round(now - over), Math.round(over)]);
    lag.last = now;
  }, ${PROBE_MS});
  globalThis.__benchLag = lag;
  return true;
})()`;

const PRELUDE = `
const S = () => window.__stores.sessions.getState();
const SEC = () => window.__stores.secretary.getState();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

async function sendTurn(page, conversationId, text) {
  const raw = await page.eval(`(async () => {
    ${PRELUDE}
    const before = (S().conversations[${JSON.stringify(conversationId)}]?.messages ?? []).length;
    const err = await S().send(${JSON.stringify(text)}, {
      providerId: 'pv-A',
      modelId: 'fake-model-1',
      cwd: window.__benchSecretaryCwd,
    }, undefined, ${JSON.stringify(conversationId)});
    return JSON.stringify({ err: err ?? null, before });
  })()`);
  const parsed = JSON.parse(raw);
  if (parsed.err) throw new Error(`send 被拒绝: ${parsed.err}`);
  return parsed.before;
}

async function waitTurn(page, conversationId, before, toolName) {
  return waitFor(
    async () => {
      const raw = await page.eval(`(() => {
        const row = window.__stores.sessions.getState().conversations[${JSON.stringify(conversationId)}];
        const messages = (row?.messages ?? []).slice(${before});
        const tool = ${JSON.stringify(toolName)};
        const result = tool ? messages.filter((m) => m.toolName === tool).at(-1) ?? null : null;
        const text = result && Array.isArray(result.content) ? result.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '';
        return JSON.stringify({
          status: row?.status ?? null,
          count: messages.length,
          tool: Boolean(result),
          isError: result?.isError === true,
          bytes: text.length,
          head: text.slice(0, 160),
        });
      })()`);
      const state = JSON.parse(raw);
      if (state.status === 'failed') throw new Error(`回合失败 ${raw}`);
      const done = state.status === 'idle' && state.count >= 2 && (!toolName || state.tool);
      return done ? state : null;
    },
    { timeout: 40_000, interval: 100, label: `回合结束 ${toolName ?? 'control'}` }
  );
}

// ---------------------------------------------------------------- profile

function frameKey(node) {
  const frame = node.callFrame;
  const file = frame.url ? frame.url.replace(/^.*\/(src|node_modules)\//, '$1/') : '';
  return `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`;
}

/** 连续忙碌段（相邻非 idle 样本）>50ms 的，列包含耗时最高的函数 */
function busyStretches(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const stretches = [];
  let current = null;
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i += 1) {
    t += profile.timeDeltas[i] ?? 0;
    const node = nodes.get(profile.samples[i]);
    if (node.callFrame.functionName === '(idle)') {
      if (current) stretches.push(current);
      current = null;
      continue;
    }
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    current ??= { start: t, ms: 0, total: new Map() };
    current.ms += dt;
    const seen = new Set();
    let walk = node;
    while (walk) {
      const key = frameKey(walk);
      if (!seen.has(key) && !/^\((root|program)\)/.test(key)) {
        seen.add(key);
        current.total.set(key, (current.total.get(key) ?? 0) + dt);
      }
      walk = nodes.get(parent.get(walk.id));
    }
  }
  if (current) stretches.push(current);
  return stretches
    .filter((stretch) => stretch.ms > 50)
    .map((stretch) => ({
      ms: Math.round(stretch.ms),
      top: [...stretch.total.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([key, ms]) => `${Math.round(ms)}ms ${key}`),
    }));
}

// ---------------------------------------------------------------- main

async function main() {
  artDir = mkdtempSync('/tmp/enso-sec-tools-bench-');
  const [cdpPort, inspectPort, fakePort] = await ports(3);
  const startedAt = Date.now();
  const fixture = await buildFixture(fakePort);
  log(
    `fixture ${Math.round((Date.now() - startedAt) / 100) / 10}s settings=${(fixture.sizes.settings / 1e6).toFixed(2)}MB dispatch=${(fixture.sizes.dispatch / 1e6).toFixed(2)}MB dir=${artDir}`
  );

  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ENSO_|ELECTRON_|GH_|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$)/.test(key)
    )
  );
  start(process.execPath, ['scripts/fake-provider-issue-27.mjs'], {
    ...clean,
    FAKE_PROVIDER_PORT: String(fakePort),
  });
  const electron = uiElementElectron(createRequire(path.join(ROOT, 'package.json'))('electron'));
  start(electron, [`--inspect=${inspectPort}`, '.'], {
    ...clean,
    // gh 用空配置目录、不带 token：cleanup_list 查合并 PR 时用不到用户的真实账号
    GH_CONFIG_DIR: path.join(fixture.home, 'gh'),
    ENSO_USER_DATA_DIR: fixture.userData,
    ENSO_CDP_PORT: String(cdpPort),
    ENSO_VERIFY: '1',
  });

  const main = await waitFor(() => mainInspector(inspectPort).catch(() => null), {
    timeout: 90_000,
    interval: 500,
    label: 'Main inspector',
  });
  await main.send('Runtime.enable');
  await main.eval(PROBE);
  log(`main probe attached ${Math.round((Date.now() - startedAt) / 1000)}s`);
  let lastDiag = 0;
  const page = await waitFor(
    async () => {
      rememberOwned();
      const cdp = await rendererPage(cdpPort).catch(() => null);
      const ready = cdp
        ? await cdp
            .eval(
              `JSON.stringify({ stores: Object.keys(window.__stores ?? {}), state: document.readyState, url: location.href.slice(0, 80) })`,
              5_000
            )
            .catch((error) => `eval: ${error.message.slice(0, 60)}`)
        : null;
      const ok =
        typeof ready === 'string' &&
        ready.includes('"sessions"') &&
        ready.includes('"secretary"') &&
        ready.includes('complete');
      if (ok) return cdp;
      cdp?.close();
      if (Date.now() - lastDiag > 10_000) {
        lastDiag = Date.now();
        const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
          .then((res) => res.json())
          .then((list) => list.map((entry) => `${entry.type}:${String(entry.url).slice(0, 60)}`))
          .catch((error) => `cdp list: ${error.message}`);
        const lag = await main
          .eval(
            'JSON.stringify({ max: Math.round(globalThis.__benchLag.max), n: globalThis.__benchLag.gaps.length })',
            5_000
          )
          .catch((error) => error.message.slice(0, 60));
        const app = await main
          .send(
            'Runtime.evaluate',
            {
              expression: `(() => { const { app, BrowserWindow, webContents } = require('electron'); return JSON.stringify({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().map((w) => [w.isVisible(), w.webContents.getURL().slice(0, 60)]), contents: webContents.getAllWebContents().length, ud: app.getPath('userData').slice(-30) }); })()`,
              includeCommandLineAPI: true,
              returnByValue: true,
            },
            5_000
          )
          .then(
            (result) =>
              result.result?.value ?? result.exceptionDetails?.exception?.description?.slice(0, 120)
          )
          .catch((error) => error.message.slice(0, 60));
        log(
          `  waiting renderer ${Math.round((Date.now() - startedAt) / 1000)}s targets=${JSON.stringify(targets)} page=${ready} mainLag=${lag} app=${app}`
        );
      }
      return null;
    },
    { timeout: 100_000, interval: 500, label: 'renderer 就绪' }
  );
  const startupLag = JSON.parse(
    await main.eval(
      'JSON.stringify({ max: Math.round(globalThis.__benchLag.max), gaps: globalThis.__benchLag.gaps.map(([, ms]) => ms).sort((a, b) => b - a).slice(0, 8) })'
    )
  );
  log(
    `renderer ready ${Math.round((Date.now() - startedAt) / 1000)}s startupMainLag=${JSON.stringify(startupLag)}`
  );
  const stage = (what) => log(`  ${what} ${Math.round((Date.now() - startedAt) / 1000)}s`);
  const SETUP = `${PRELUDE} const SET = () => window.__stores.settings.getState();`;
  await waitFor(
    () =>
      page.eval(
        `(() => { ${SETUP} return SET().projects.some((p) => p.kind === 'secretary'); })()`,
        5_000
      ),
    { timeout: 30_000, interval: 300, label: '秘书隐藏项目' }
  );
  stage('secretary project present');
  const saved = JSON.parse(
    await page.eval(
      `(async () => JSON.stringify(await window.electronAPI.secretary.saveProfile({
          name: '秘书',
          avatar: { color: '#6366f1' },
          visibleProjectIds: 'all',
          maxRunningDispatches: 3,
          patrolEnabled: false,
          replyLanguage: 'ui',
          style: 'concise',
          notify: 'off',
          addressAs: null,
          dailyBriefAt: null,
        })))()`,
      30_000
    )
  );
  if (!saved.ok) throw new Error(`saveProfile 失败 ${JSON.stringify(saved)}`);
  stage('profile saved');
  let lastSetup = null;
  const setup = await waitFor(
    async () => {
      const raw = await page.eval(
        `(async () => {
          ${SETUP}
          const sec = SEC();
          const projectId = sec.secretary?.projectId ?? null;
          const diag = {
            projectId,
            focusedId: sec.focusedId ?? null,
            secretaries: (sec.secretaries ?? []).map((e) => [e.id, e.projectId]),
            states: Object.keys(sec.states ?? {}),
            secretaryProjects: SET().projects.filter((p) => p.kind === 'secretary').map((p) => p.id),
          };
          if (!projectId) {
            // 秘书面板没挂载时 store 不会自己订阅 Main：绑一次再重读
            if (!window.__benchSecretaryBound) window.__benchSecretaryBound = sec.bind();
            await sec.reload().catch(() => {});
            return JSON.stringify(diag);
          }
          const id = await sec.newSecretaryConversation();
          const project = SET().projects.find((p) => p.id === projectId);
          window.__benchSecretaryCwd = project?.path;
          return JSON.stringify({ ...diag, id, cwd: project?.path ?? null, rows: Object.keys(S().conversations).length });
        })()`,
        15_000
      );
      const parsed = JSON.parse(raw);
      lastSetup = parsed;
      return parsed.id && parsed.cwd ? parsed : null;
    },
    { timeout: 40_000, interval: 500, label: '秘书会话' }
  ).catch((error) => {
    throw new Error(`${error.message} last=${JSON.stringify(lastSetup)}`);
  });
  if (!setup.id || !setup.cwd) throw new Error(`秘书会话没建起来 ${JSON.stringify(setup)}`);
  log(
    `instance up ${Math.round((Date.now() - startedAt) / 1000)}s secretary=${setup.id} rows=${setup.rows}`
  );

  const big = fixture.bigProject.id;
  const cases = [
    { name: 'control-warmup', tool: null },
    { name: 'control', tool: null },
    { name: 'project_list', tool: 'project_list', args: {} },
    { name: 'project_info', tool: 'project_info', args: { projectId: big } },
    { name: 'session_list', tool: 'session_list', args: { limit: 100 } },
    { name: 'session_list(project)', tool: 'session_list', args: { projectId: big, limit: 100 } },
    { name: 'session_read', tool: 'session_read', args: { conversationId: fixture.big[0] } },
    { name: 'session_read(warm)', tool: 'session_read', args: { conversationId: fixture.big[0] } },
    {
      name: 'session_activity',
      tool: 'session_activity',
      args: { conversationId: fixture.big[1] },
    },
    { name: 'session_stats', tool: 'session_stats', args: { conversationId: fixture.big[2] } },
    { name: 'session_tasks', tool: 'session_tasks', args: { conversationId: fixture.big[0] } },
    { name: 'repo_status', tool: 'repo_status', args: { projectId: big } },
    { name: 'repo_diff', tool: 'repo_diff', args: { projectId: big, base: 'main~20' } },
    { name: 'todo_list', tool: 'todo_list', args: {} },
    { name: 'memory_search', tool: 'memory_search', args: { query: '发布流程' } },
    { name: 'cleanup_list', tool: 'cleanup_list', args: {} },
    { name: 'cleanup_list(warm)', tool: 'cleanup_list', args: {} },
    {
      name: 'session_create(worktree)',
      tool: 'session_create',
      args: { projectId: big, prompt: '跑一下测试', worktree: true },
    },
    { name: 'control(after)', tool: null },
  ];
  const results = [];
  for (const item of cases) {
    await sleep(400);
    await main.eval('globalThis.__benchLag.reset(), true');
    if (PROFILE) {
      await main.send('Profiler.enable');
      await main.send('Profiler.setSamplingInterval', { interval: 500 });
      await main.send('Profiler.start');
    }
    const text = item.tool ? `查一下 [[call:${item.tool} ${JSON.stringify(item.args)}]]` : '你好';
    const t0 = Date.now();
    const before = await sendTurn(page, setup.id, text);
    const state = await waitTurn(page, setup.id, before, item.tool);
    const turnMs = Date.now() - t0;
    await sleep(300);
    const lag = JSON.parse(
      await main.eval(
        'JSON.stringify({ max: globalThis.__benchLag.max, gaps: globalThis.__benchLag.gaps })'
      )
    );
    let stretches = [];
    if (PROFILE) {
      const { profile } = await main.send('Profiler.stop', {}, 60_000);
      await main.send('Profiler.disable');
      stretches = busyStretches(profile);
    }
    const row = {
      case: item.name,
      maxBlockMs: Math.round(lag.max),
      over50: lag.gaps.filter(([, ms]) => ms > 50).length,
      gaps: lag.gaps
        .map(([, ms]) => ms)
        .sort((a, b) => b - a)
        .slice(0, 5),
      turnMs,
      toolError: state.isError,
      resultBytes: state.bytes,
    };
    log(
      `${item.name.padEnd(22)} max=${String(row.maxBlockMs).padStart(5)}ms over50=${row.over50} gaps=${JSON.stringify(row.gaps)} turn=${turnMs}ms ${state.isError ? `ERROR ${state.head}` : `bytes=${state.bytes}`}`
    );
    for (const stretch of stretches) {
      log(`  busy ${stretch.ms}ms`);
      for (const line of stretch.top.slice(0, 18)) log(`    ${line}`);
    }
    results.push({ ...row, stretches });
  }
  console.log(`\n== ${LABEL}：每个工具调用期间 Main 最长阻塞（ms） ==`);
  console.table(results.map(({ stretches, ...rest }) => rest));
  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ label: LABEL, sizes: fixture.sizes, results }, null, 2)
    );
    log(`写入 ${JSON_OUT}`);
  }
  page.close();
  main.close();
}

async function cleanup() {
  signalOwned('SIGTERM');
  await sleep(1000);
  signalOwned('SIGKILL');
  await sleep(200);
  if (!artDir) return;
  if (KEEP) return log(`保留 ${artDir}`);
  rmSync(artDir, { recursive: true, force: true });
}

function finish(code) {
  finishing ??= cleanup()
    .catch((error) => {
      console.error(error);
      code = 1;
    })
    .finally(() => process.exit(code));
  return finishing;
}

const hardStop = setTimeout(() => {
  console.error(`超过 ${HARD_TIMEOUT_MS / 1000}s 硬超时`);
  if (logTail) console.error(logTail);
  void finish(124);
}, HARD_TIMEOUT_MS);
hardStop.unref();

process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));
process.on('unhandledRejection', (error) => {
  console.error(error);
  if (logTail) console.error(logTail);
  void finish(1);
});

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    if (logTail) console.error(logTail);
    return finish(1);
  });
