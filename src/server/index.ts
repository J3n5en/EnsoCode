/**
 * EnsoCode 无界面宿主：跑在 Node 上，通过中继与 PWA 配对，浏览器经隧道加载桌面 renderer。
 * `enso-server start` 前台运行；其余子命令（见 cli.ts）经控制 socket 操作运行中的宿主。
 */
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { app } from '@platform';
import { setAppLoggingEnabled } from '@shared/appLogFile';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { UpdateStatus } from '@shared/types/updater';
import { registerIpcHandlers } from '../main/ipc';
import { patchSettingsState, readSettings, startProviderModelRefresh } from '../main/ipc/settings';
import {
  agentWorkerAlive,
  startAgentWorker,
  stopAgentWorkerForQuit,
} from '../main/services/agentHost';
import { attachAppQuitDrain } from '../main/services/appQuitDrain';
import { getCaCertConfig } from '../main/services/caCert';
import { getExtensionPlugins } from '../main/services/extensionPlugins';
import {
  closeMemoryDb,
  syncMemoryDistillFromSettings,
  syncMemoryEmbeddingFromSettings,
  syncMemoryForgettingFromSettings,
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
import { broadcastToRenderers } from '../main/services/renderers';
import { readySecureStores } from '../main/services/secureStores';
import {
  disposeAllTerminals,
  hasPendingPtys,
  waitPtyQuitIdle,
} from '../main/services/terminalService';
import { isRunning, runCommand, USAGE } from './cli';
import { applyConfigEnv, readServerConfig } from './config';
import { type PluginControlCommand, parseControlCommand, serveControlConnection } from './control';
import { runCli } from './run/cli';
import { registerServerUpdater } from './update/ipc';
import { globalNpmInstaller } from './update/npm';
import { HEALTHY_AFTER_MS, markUpdateReady, resolveUpdateBoot } from './update/pendingUpdate';
import { detectRestartMethod, spawnReexec } from './update/reexec';
import type { ServerUpdater } from './update/serverUpdater';
import { startWeb } from './web';
import { parseWebConfig, type WebConfig } from './web/config';

/**
 * 启动时的更新健康检查：pending-update.json 在，说明上次启动是为更新而来。
 * 连续崩溃到上限（守护/launcher 反复拉起却没活到 markUpdateReady）就回滚到旧版本；
 * 起来满 HEALTHY_AFTER_MS 算健康，清除标记。回滚安装完成后退出，由守护/reexec 脚本拉起旧版本。
 */
async function resolveStartupUpdate(): Promise<void> {
  const dataDir = app.getPath('userData');
  const decision = resolveUpdateBoot(dataDir, app.getVersion());
  if (decision.kind === 'none' || decision.kind === 'stale') return;
  if (decision.kind === 'rollback') {
    console.warn(`[server] ${decision.to} 连续 ${3} 次没能起来，回滚到 ${decision.from}`);
    const npm = globalNpmInstaller(app.getAppPath());
    if (!npm) {
      console.error('[server] 无法自动回滚（非全局 npm 安装），请手动执行 npm i -g 重装旧版本');
      return;
    }
    try {
      await npm.install(`@ensocode/server@${decision.from}`);
      console.log(`[server] 已回滚到 ${decision.from}，重启后生效`);
    } catch (error) {
      console.error(
        `[server] 回滚失败: ${error instanceof Error ? error.message : String(error)}，请手动重装旧版本`
      );
      return;
    }
    // 无守护时没人拉起旧版本：再放一个 reexec 脚本（崩溃循环下 launcher 早已退出）
    if (detectRestartMethod(process.env, process.pid) === 'reexec') spawnReexec(dataDir);
    process.exit(0);
  }
  // booting：起来满一分钟算健康
  const timer = setTimeout(() => markUpdateReady(dataDir, app.getVersion()), HEALTHY_AFTER_MS);
  timer.unref();
}

const socketPath = (): string => path.join(app.getPath('userData'), 'server.sock');

/** 检查 → 下载 → 应用（应用会让宿主退出，由 systemd 拉起新版本） */
async function update(updater: ServerUpdater, channel?: 'stable' | 'beta'): Promise<unknown> {
  if (channel) {
    updater.setChannel(channel);
    // 命令行切的渠道同样落盘，重启后仍在所选渠道（与设置页一致）
    patchSettingsState('updateChannel', channel);
  }
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
      return { ok: true, plugins: plugins.list(), notice: plugins.registryNotice() };
    case 'notice-dismiss':
      plugins.dismissRegistryNotice();
      return { ok: true };
    case 'check':
      return { ok: true, ...(await plugins.checkUpdates()), plugins: plugins.list() };
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
    case 'inject-anywhere':
    case 'inject-current':
      return plugins.setCrossSessionInject(command.id, command.action === 'inject-anywhere');
    case 'dev-on':
    case 'dev-off':
      return plugins.setDevWatch(command.id, command.action === 'dev-on');
    case 'config-get':
      return plugins.configView(command.id);
    case 'restage':
      return plugins.restage(command.id);
    case 'logs':
      return { ok: true, text: await plugins.logs(command.id) };
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
  if (command.cmd === 'update') return update(updater, command.channel);
  // 仅调试：ENSO_SERVER_DEBUG=1 时可伪造 applying 状态广播，截图/联调 UI 用
  if (command.cmd === 'debug-applying') {
    if (process.env.ENSO_SERVER_DEBUG !== '1') return { ok: false, error: 'debug disabled' };
    const status: UpdateStatus = {
      status: 'applying',
      info: { version: command.version ?? '0.4.0-beta.1' },
      applying: {
        stage: command.stage,
        ...(command.stage === 'waiting-tasks'
          ? { busyCount: command.busyCount ?? 2, deadlineMs: Date.now() + 5 * 60 * 1000 }
          : {}),
      },
    };
    broadcastToRenderers(IPC_CHANNELS.UPDATER_STATUS, status);
    return { ok: true };
  }
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
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) =>
    serveControlConnection(socket, (line) => handle(line, updater, web))
  );
  server.listen(file, () => chmodSync(file, 0o600));
  app.on('before-quit', () => {
    server.close();
    rmSync(file, { force: true });
  });
}

async function serve(web: WebConfig | null): Promise<void> {
  await resolveStartupUpdate();
  // 先占端口：端口被占时直接失败，不留半启动的宿主
  const relay = web ? await startWeb(web) : null;
  await readySecureStores();
  setupRemoteRenderer();
  registerIpcHandlers();
  const updater = registerServerUpdater();
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: Record<string, unknown> }
    | undefined;
  const state = persisted?.state ?? {};
  setAppLoggingEnabled(state.appLoggingEnabled === true);
  getProxyConfig().initFromConfig(state.proxyMode, state.customProxyUrl);
  getCaCertConfig().initFromConfig(state.customCaCertPath);
  startProviderModelRefresh();
  syncMemoryEmbeddingFromSettings(state);
  syncMemoryDistillFromSettings(state);
  syncMemoryKgFromSettings(state);
  syncMemoryForgettingFromSettings(state);
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
  getExtensionPlugins().startBackground();

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
    {
      begin: () => {
        void getExtensionPlugins().dispose();
      },
      shouldWait: () => getExtensionPlugins().hasRunningPlugins(),
      wait: () => getExtensionPlugins().dispose(),
    },
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
  if (argv[0] === 'run') {
    const code = await runCli(argv.slice(1));
    process.exit(code);
  }
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
