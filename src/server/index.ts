/**
 * EnsoCode 无界面宿主：跑在 Node 上，通过中继与 PWA 配对，浏览器经隧道加载桌面 renderer。
 * `enso-server start` 前台运行；其余子命令（见 cli.ts）经控制 socket 操作运行中的宿主。
 */
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { app } from '@platform';
import { registerIpcHandlers } from '../main/ipc';
import { readSettings } from '../main/ipc/settings';
import {
  agentWorkerAlive,
  startAgentWorker,
  stopAgentWorkerForQuit,
} from '../main/services/agentHost';
import { attachAppQuitDrain } from '../main/services/appQuitDrain';
import { getExtensionPlugins } from '../main/services/extensionPlugins';
import {
  closeMemoryDb,
  syncMemoryDistillFromSettings,
  syncMemoryEmbeddingFromSettings,
  syncMemoryKgFromSettings,
} from '../main/services/memoryHost';
import {
  flushPairCatalogSnapshot,
  loadPairCatalogSnapshot,
  savePairCatalogSnapshot,
} from '../main/services/pairCatalogStore';
import { startPairGuest, stopPairGuest } from '../main/services/pairGuest';
import {
  getPairStatus,
  revokeDevice,
  setPairCatalogSink,
  setRelayUrl,
  startPairHost,
  startPairing,
  stopPairHost,
  updatePairCatalog,
} from '../main/services/pairHost';
import { getProxyConfig } from '../main/services/proxyConfig';
import { refreshRemoteLeadership, setupRemoteRenderer } from '../main/services/remoteRenderer';
import {
  disposeAllTerminals,
  hasPendingPtys,
  waitPtyQuitIdle,
} from '../main/services/terminalService';
import { isRunning, runCommand, USAGE } from './cli';
import { applyConfigEnv, readServerConfig } from './config';
import { type PluginControlCommand, parseControlCommand } from './control';
import { registerServerUpdater } from './update/ipc';
import type { ServerUpdater } from './update/serverUpdater';
import { startWeb } from './web';
import { parseWebConfig, type WebConfig } from './web/config';

const socketPath = (): string => path.join(app.getPath('userData'), 'server.sock');

/** 检查 → 下载 → 应用（应用会让宿主退出，由 systemd 拉起新版本） */
async function update(updater: ServerUpdater): Promise<unknown> {
  await updater.checkForUpdates();
  if (updater.state().status?.status === 'available') await updater.downloadUpdate();
  const status = updater.state().status;
  if (status?.status !== 'downloaded') return { ok: status?.status !== 'error', status };
  setTimeout(() => void updater.quitAndInstall(), 200);
  return { ok: true, status, applying: true };
}

/** 控制 socket（0600，仅本机同用户）上的插件管理；路径是服务器本地路径 */
async function handlePlugin(command: PluginControlCommand): Promise<unknown> {
  const plugins = getExtensionPlugins();
  switch (command.action) {
    case 'list':
      return { ok: true, plugins: plugins.list() };
    case 'stage':
      return plugins.stage(
        'url' in command
          ? { kind: 'url', url: command.url }
          : {
              kind: command.path.toLowerCase().endsWith('.zip') ? 'zip' : 'dir',
              path: command.path,
            }
      );
    case 'commit':
      return plugins.commit(command.token);
    case 'discard':
      plugins.discard(command.token);
      return { ok: true };
    case 'enable':
    case 'disable':
      return plugins.setEnabled(command.id, command.action === 'enable');
    case 'approve':
      return plugins.approvePending(command.id);
    case 'reject':
      return plugins.rejectPending(command.id);
    case 'uninstall':
      return plugins.uninstall(command.id);
    case 'config-get':
      return plugins.configView(command.id);
    case 'config-set':
      return plugins.setConfig(command.id, command.values);
  }
}

async function handle(
  line: string,
  updater: ServerUpdater,
  web: WebConfig | null
): Promise<unknown> {
  const command = parseControlCommand(line);
  if ('error' in command) return { ok: false, error: command.error };
  if (command.cmd === 'plugin') return handlePlugin(command);
  if (command.cmd === 'pair') return startPairing();
  if (command.cmd === 'devices') return { ok: true, status: getPairStatus() };
  if (command.cmd === 'update') return update(updater);
  if (command.cmd === 'status') {
    return {
      ok: true,
      pid: process.pid,
      version: app.getVersion(),
      dataDir: app.getPath('userData'),
      pair: getPairStatus(),
      update: updater.state(),
      web: web && { listen: `${web.host}:${web.port}`, publicUrl: web.publicUrl },
    };
  }
  await revokeDevice(command.id);
  return { ok: true };
}

function listenControl(updater: ServerUpdater, web: WebConfig | null): void {
  const file = socketPath();
  if (existsSync(file)) rmSync(file);
  // 客户端发完即半关闭；保持写端打开，等异步命令（如向中继登记配对）回包
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    createInterface({ input: socket }).on('line', (line) => {
      void handle(line, updater, web)
        .catch((error: unknown) => ({ ok: false, error: String(error) }))
        .then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    });
  });
  server.listen(file, () => chmodSync(file, 0o600));
  app.on('before-quit', () => {
    server.close();
    rmSync(file, { force: true });
  });
}

async function serve(web: WebConfig | null): Promise<void> {
  // 先占端口：端口被占时直接失败，不留半启动的宿主
  const relay = web ? await startWeb(web) : null;
  setupRemoteRenderer();
  registerIpcHandlers();
  const updater = registerServerUpdater();
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: Record<string, unknown> }
    | undefined;
  const state = persisted?.state ?? {};
  getProxyConfig().initFromConfig(state.proxyMode, state.customProxyUrl);
  syncMemoryEmbeddingFromSettings(state);
  syncMemoryDistillFromSettings(state);
  syncMemoryKgFromSettings(state);
  // 目录平时由 leader 渲染器推送；重启后先用快照，headless 接管的会话才有据可依
  const snapshot = loadPairCatalogSnapshot();
  if (snapshot) updatePairCatalog(snapshot);
  setPairCatalogSink(savePairCatalogSnapshot);
  // 没有本地窗口：无远端 leader 时由宿主接管 pair 会话
  refreshRemoteLeadership();
  void getProxyConfig()
    .whenReady()
    .finally(() => startAgentWorker());
  const relayUrl = process.env.ENSO_RELAY_URL?.trim();
  if (relayUrl && !web) setRelayUrl(relayUrl);
  if (relayUrl && web) console.warn('[server] 已开启内置 web，忽略 ENSO_RELAY_URL');
  startPairHost();
  startPairGuest();
  listenControl(updater, web);

  app.on('before-quit', () => {
    void relay?.close();
    flushPairCatalogSnapshot();
    stopPairHost();
    stopPairGuest();
    closeMemoryDb();
  });
  attachAppQuitDrain(app, [
    { begin: disposeAllTerminals, shouldWait: hasPendingPtys, wait: waitPtyQuitIdle },
    { shouldWait: agentWorkerAlive, wait: () => stopAgentWorkerForQuit(3_000) },
  ]);
  let quitting = false;
  const quit = () => {
    if (quitting) process.exit(130);
    quitting = true;
    app.quit();
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  console.log(`[server] enso-server ${app.getVersion()} data=${app.getPath('userData')}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'start') {
    const config = readServerConfig(app.getPath('userData'));
    if (!config.ok) {
      console.error(`配置文件有误：${config.error}`);
      process.exit(2);
    }
    applyConfigEnv(process.env, config.config);
    const parsed = parseWebConfig(argv.slice(1), process.env);
    if (!parsed.ok) {
      console.error(`${parsed.error}\n\n${USAGE}`);
      process.exit(2);
    }
    if (await isRunning(socketPath())) {
      console.error('enso-server 已在运行（`enso-server status` 查看）');
      process.exit(1);
    }
    await serve(parsed.web).catch((error: unknown) => {
      console.error(`[server] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
    return;
  }
  const ctx = {
    socketPath: socketPath(),
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
  };
  if (!(await runCommand(argv, ctx))) {
    console.error(USAGE);
    process.exit(2);
  }
}

void main();
